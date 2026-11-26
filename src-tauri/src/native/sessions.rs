// 生きている対話セッション。~/.claude/sessions/<pid>.json を読み、pid が生きているものだけを残す。
// 形（2.1.330 で実ファイルを読んだ）: pid、sessionId、cwd、startedAt、kind（interactive）、entrypoint（cli）、
// status（busy、waiting、idle）、updatedAt、name、messagingSocketPath など。
// 制御端末が無く引数に -p か --print がある裏方（Stop hook や launchd のジョブ）は外す（決め方は claude-code-nodes の agents.ts から借りた）。

use super::Stats;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct Session {
    pub pid: u32,
    pub id: String,
    pub cwd: String,
    pub started_at: u64,
    /// 画面の state（running、waiting_permission、idle）
    pub state: &'static str,
    pub updated_at: u64,
    pub title: Option<String>,
    pub kind: String,
    /// 会話の jsonl（まだ無ければ、書かれるはずの場所）
    pub jsonl: PathBuf,
    /// 最初の文の from 行の呼び手（agent:<ノード>/<sid8>/<役割>）。ccn などが子を立てるときに付ける
    pub parent_raw: Option<String>,
    /// 受信ソケット（messagingSocketPath）。ファイルがあるときだけ入れる。あれば文を送れる（#156）
    pub socket: Option<PathBuf>,
}

impl Session {
    pub fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "kind": "terminal",
            "state": self.state,
            "cwd": self.cwd,
            "pid": self.pid,
            "startedAt": self.started_at,
            "lastActivityAt": self.updated_at,
            "parent": self.parent_raw,
            "capabilities": super::outside_caps(self.socket.is_some()),
            "title": self.title,
            "native": { "jsonl": self.jsonl, "kind": self.kind, "socket": self.socket },
        })
    }
}

/// cwd から projects/ の下のディレクトリ名を作る。英数字（ASCII）以外を全部 - にする。
/// 2026-11-21 に実機の 1045 ディレクトリで、jsonl の行の cwd と突き合わせて確かめた（一致しないのは、途中で cd したセッションだけ）
pub fn project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// status の読み替え（claude-code-nodes の agents.ts と同じ）
fn state_of(status: Option<&str>, stats: &mut Stats) -> &'static str {
    match status {
        Some("busy") => "running",
        Some("waiting") => "waiting_permission",
        Some("idle") => "idle",
        other => {
            stats.odd(format!("sessions: 知らない status {:?}", other));
            "idle"
        }
    }
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // シグナル0は送らずに、プロセスがあるかだけを見る。EPERM は別のユーザーのプロセスがある
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 記録の procStart。claude 2.1.330 は `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` の出力を trim して入れ、
/// 一覧のたびに同じコマンドの出力と完全一致で比べている（本体の文字列で確かめた）。
/// lstart の形（曜日、月、日、時:分:秒、年の5語）でなければ None にして、pid だけで判定する
fn proc_start_of(v: &Value) -> Option<String> {
    lstart_norm(v["procStart"].as_str()?)
}

/// 空白を1つに畳む（日が1桁だと `Nov  2` と空白が2つになる）。lstart の形でなければ None
fn lstart_norm(s: &str) -> Option<String> {
    let w: Vec<&str> = s.split_whitespace().collect();
    let ok = w.len() == 5
        && w[0].len() == 3
        && w[1].len() == 3
        && w[2].parse::<u8>().is_ok()
        && w[3].split(':').count() == 3
        && w[3].split(':').all(|x| x.len() == 2 && x.parse::<u8>().is_ok())
        && w[4].parse::<u16>().is_ok();
    ok.then(|| w.join(" "))
}

/// pid ごとの起動時刻（UTC の lstart、空白を畳んだもの）。1回の ps でまとめて取る。
/// ps が動かなかった pid と、出力に無い pid は入らない。結果は覚えない（記録が同じまま pid の中身が替わるのを見分けるため）
fn ps_lstart(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let arg = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    // Finder から起動したアプリは地方時になるので、TZ と LC_ALL を claude と同じに明示する
    let Ok(out) = std::process::Command::new("/bin/ps")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .args(["-o", "pid=,lstart=", "-p", &arg])
        .output()
    else {
        return HashMap::new();
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| {
        let line = line.trim_start();
        let (pid, rest) = line.split_once(char::is_whitespace)?;
        Some((pid.parse().ok()?, lstart_norm(rest)?))
    }).collect()
}

/// pid が生きているもののうち、記録の起動時刻が今のプロセスと合うもの（合わなければ、記録が残ったまま pid が使い回された）。
/// 起動時刻を比べられない（記録に無い、形が違う、ps で取れない）ものは pid だけで判定する。返すのは list と同じ並びの真偽
fn alive_as_recorded(list: &[(u32, Option<String>)]) -> Vec<bool> {
    let alive: Vec<bool> = list.iter().map(|r| pid_alive(r.0)).collect();
    let ask: Vec<u32> = list.iter().zip(&alive).filter(|(r, a)| **a && r.1.is_some()).map(|(r, _)| r.0).collect();
    let now = ps_lstart(&ask);
    list.iter().zip(alive).map(|((pid, want), a)| {
        a && match (want, now.get(pid)) {
            (Some(w), Some(n)) => w == n,
            _ => true,
        }
    }).collect()
}

/// 裏方の -p か。pid と起動時刻ごとに1回だけ ps で調べて覚える（毎回 ps を起こさない）
static HEADLESS: Mutex<Option<HashMap<(u32, u64), bool>>> = Mutex::new(None);

fn headless_of(list: &[(u32, u64)]) -> HashMap<u32, bool> {
    let mut g = HEADLESS.lock().unwrap_or_else(|e| e.into_inner());
    let known = g.get_or_insert_with(HashMap::new);
    let ask: Vec<u32> = list.iter().filter(|k| !known.contains_key(k)).map(|k| k.0).collect();
    if !ask.is_empty() {
        let found = ps_headless(&ask);
        for k in list.iter().filter(|k| ask.contains(&k.0)) {
            // ps に出なかった（読めなかった）ものは残す
            known.insert(*k, found.get(&k.0).copied().unwrap_or(false));
        }
    }
    // 終わったプロセスの分は忘れる
    known.retain(|k, _| list.contains(k));
    list.iter().map(|k| (k.0, known.get(k).copied().unwrap_or(false))).collect()
}

fn ps_headless(pids: &[u32]) -> HashMap<u32, bool> {
    let arg = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let Ok(out) = std::process::Command::new("/bin/ps").args(["-o", "pid=,tty=,command=", "-p", &arg]).output() else {
        return HashMap::new();
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| {
        let mut it = line.split_whitespace();
        let pid: u32 = it.next()?.parse().ok()?;
        let tty = it.next()?;
        let args: Vec<&str> = it.collect();
        Some((pid, tty.starts_with('?') && args.iter().any(|a| *a == "-p" || *a == "--print")))
    }).collect()
}

/// sessionId ごとの jsonl の場所と、from 行の親（最初の user の行を読めたら決まる）
#[derive(Clone, Default)]
struct Known {
    jsonl: Option<PathBuf>,
    parent: Option<Option<String>>,
}
static KNOWN: Mutex<Option<HashMap<String, Known>>> = Mutex::new(None);

/// jsonl の場所。規則の場所に無ければ projects/*/<sid>.jsonl を探す（cwd が変わったセッション）。見つからなければ規則の場所
fn locate(root: &Path, sid: &str, cwd: &str, stats: &mut Stats) -> (PathBuf, bool) {
    let projects = root.join("projects");
    let want = projects.join(project_dir_name(cwd)).join(format!("{sid}.jsonl"));
    if want.exists() {
        return (want, true);
    }
    if let Ok(rd) = fs::read_dir(&projects) {
        for d in rd.flatten() {
            let p = d.path().join(format!("{sid}.jsonl"));
            if p.exists() {
                stats.jsonl_searched += 1;
                return (p, true);
            }
        }
    }
    stats.jsonl_missing += 1;
    (want, false)
}

/// 最初の user の文の from 行。from 行が無ければ Some(None)、まだ user の行が無ければ None（次の回に読み直す）
pub fn first_prompt_caller(jsonl: &Path) -> Option<Option<String>> {
    // 先頭の 1MB と 400 行までに始まる行に無ければ、from 行は無いとみなす。
    // 1MB をまたぐ行は、64MB までなら最後まで読む（画像を貼った最初の文は 8MB や 16MB になる。#234）。
    // 頭だけでは isMeta（message の後ろにある）や tool_result を見られないので、行を丸ごと読んで今と同じ規則で見る
    const HEAD: u64 = 1 << 20;
    const LINE_CAP: u64 = 64 << 20;
    let mut r = BufReader::new(fs::File::open(jsonl).ok()?);
    let mut off = 0u64;
    let mut buf = Vec::new();
    for i in 0.. {
        if i >= 400 || off >= HEAD {
            return Some(None);
        }
        buf.clear();
        let n = r.by_ref().take(LINE_CAP + 1).read_until(b'\n', &mut buf).ok()? as u64;
        if n == 0 {
            return None;
        }
        off += n;
        if n > LINE_CAP {
            return Some(None);
        }
        // 改行の無い最後の行は、読めれば使い、読めなければ書きかけとみなして次の回に読み直す
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
            if buf.ends_with(b"\n") {
                continue;
            }
            return None;
        };
        if v["type"] != "user" || v["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let content = &v["message"]["content"];
        if content.as_array().map(|a| a.iter().any(|c| c["type"] == "tool_result")).unwrap_or(false) {
            continue;
        }
        let text = crate::user_text(content);
        if text.is_empty() || text.starts_with('<') {
            continue;
        }
        return Some(caller_of(&text));
    }
    None
}

/// 「from <呼び手> via <ノード>」の呼び手（claude-code-nodes の identity/from-line.ts と同じ規則）
pub fn caller_of(text: &str) -> Option<String> {
    let first = text.lines().next()?;
    let rest = first.strip_prefix("from ")?;
    let mut it = rest.split_whitespace();
    let who = it.next()?;
    (it.next()? == "via" && it.next().is_some()).then(|| who.to_string())
}

/// pid の sessions/<pid>.json を、覚えた値を使わずに今読む。返すのは state、startedAt、lastActivityAt（無ければ None）
pub fn fresh_row(root: &Path, pid: u32) -> Option<Value> {
    let v: Value = serde_json::from_str(&fs::read_to_string(root.join(format!("sessions/{pid}.json"))).ok()?).ok()?;
    let mut st = Stats::default();
    Some(json!({
        "state": state_of(v["status"].as_str(), &mut st),
        "startedAt": v["startedAt"],
        "lastActivityAt": v["updatedAt"].as_u64().or(v["startedAt"].as_u64()),
    }))
}

/// sessions/<pid>.json の messagingSocketPath。ファイルが無ければ None（古い版、受信を切ったセッション）
fn socket_from(v: &Value) -> Option<PathBuf> {
    v["messagingSocketPath"].as_str().map(PathBuf::from).filter(|p| p.exists())
}

/// id を名乗っている、生きているセッションの受信ソケット（sessions/<pid>.json を今読む）。無ければ None
pub fn live_socket_of(root: &Path, id: &str) -> Option<PathBuf> {
    let pid = live_pid_of(root, id)?;
    let v: Value = serde_json::from_str(&fs::read_to_string(root.join(format!("sessions/{pid}.json"))).ok()?).ok()?;
    socket_from(&v)
}

/// id の会話の jsonl を projects/*/ から探す。無ければ None（resume すると exit 1 で終わるので、立て直す前に見る）
pub fn find_jsonl(root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    fs::read_dir(root.join("projects")).ok()?.flatten().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

/// 同じ id を名乗る記録が2つ以上あるとき（同じセッションを2か所で開いた。#328、#331）に、どれを先に選ぶかの並び。
/// 新しく開いたほう（startedAt が大きい）を先にし、同じなら pid の大きいほう。町の一覧で残す行（merge_same_id）と、
/// 外で起動したセッションへの送信と停止の行き先（live_pid_of、verified_pid_of）を、この並びでそろえる
fn newer_first(a: (u64, u32), b: (u64, u32)) -> std::cmp::Ordering {
    b.cmp(&a)
}

/// sessionId が id の記録の（pid、startedAt、v）。読めない記録は飛ばす。newer_first の順
fn records_of(root: &Path, id: &str) -> Vec<(u32, u64, Value)> {
    let Ok(rd) = fs::read_dir(root.join("sessions")) else { return vec![] };
    let mut v: Vec<(u32, u64, Value)> = rd.flatten().filter_map(|e| {
        let v: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
        (v["sessionId"].as_str() == Some(id)).then_some(())?;
        Some((v["pid"].as_u64()? as u32, v["startedAt"].as_u64().unwrap_or(0), v))
    }).collect();
    v.sort_by(|a, b| newer_first((a.1, a.0), (b.1, b.0)));
    v
}

/// id を名乗っている、生きているプロセスの pid の全部（sessions/<pid>.json を今読む）。newer_first の順。
/// resume すると同じ id を新しい pid が名乗るので、起動時刻の合わない古い記録は数えない
pub fn live_pids_of(root: &Path, id: &str) -> Vec<u32> {
    let cands: Vec<(u32, Option<String>)> = records_of(root, id).into_iter().map(|(pid, _, v)| (pid, proc_start_of(&v))).collect();
    let ok = alive_as_recorded(&cands);
    cands.iter().zip(ok).filter(|(_, a)| *a).map(|(c, _)| c.0).collect()
}

/// id を名乗っている、生きているプロセスの pid（2つ以上あれば newer_first の先頭）。無ければ None
pub fn live_pid_of(root: &Path, id: &str) -> Option<u32> {
    live_pids_of(root, id).into_iter().next()
}

/// id を名乗っている claude の pid のうち、記録の起動時刻（procStart）が今のプロセスと一致するもの全部。止める前の確かめに使う（#309）。
/// live_pids_of と違い、起動時刻を比べられない記録は選ばない。pid が別のプロセスに使い回されていても見分けられないので、信号を送らない。
/// 並びは newer_first（先頭が町の一覧に残した行の pid）
pub fn verified_pids_of(root: &Path, id: &str) -> Vec<u32> {
    let cands: Vec<(u32, String)> = records_of(root, id).into_iter().filter_map(|(pid, _, v)| Some((pid, proc_start_of(&v)?))).collect();
    let now = ps_lstart(&cands.iter().map(|c| c.0).collect::<Vec<_>>());
    cands.into_iter().filter(|(pid, want)| now.get(pid) == Some(want)).map(|c| c.0).collect()
}

/// verified_pids_of の先頭。無ければ None
pub fn verified_pid_of(root: &Path, id: &str) -> Option<u32> {
    verified_pids_of(root, id).into_iter().next()
}

/// SIGHUP を送ってから、終わっていなければ SIGKILL を送るまで待つ長さ。
/// Claude Town の外で起動した claude は、SIGHUP から 1.69 秒で終わった（2026-11-26 の実測、#309）
const HANGUP_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// Claude Town の外で起動したセッションを止める（#309）。claude の pid に SIGHUP を送る。このアプリが立てた端末と同じ止め方（pty::kill）。
/// 受信ソケットに /exit を送っても、ただの文として届くので使わない（composer.rs の socket_refusal）。
/// 同じ id を2か所以上で開いていれば（#331）、全部に送る。町のカードは id ごとに1枚なので、1つ残すとカードが消えない。
/// skip の pid には送らない（このアプリの端末で、pty::kill で止めるもの）。
/// HANGUP_WAIT たっても同じプロセスが残っていれば SIGKILL を送る。どちらも送る直前に起動時刻を確かめる。返すのは止めた pid（1つも無ければ Err）
pub fn hangup(root: &Path, id: &str, skip: Option<u32>) -> Result<Vec<u32>, String> {
    let pids: Vec<u32> = verified_pids_of(root, id).into_iter().filter(|p| Some(*p) != skip).collect();
    if pids.is_empty() {
        return Err("止める claude が見つからなかった（もう終わったか、記録の起動時刻が今のプロセスと合わない）".into());
    }
    let mut sent = vec![];
    let mut failed = vec![];
    for pid in pids {
        if unsafe { libc::kill(pid as i32, libc::SIGHUP) } == 0 {
            sent.push(pid);
        } else {
            failed.push(format!("pid {pid}: {}", std::io::Error::last_os_error()));
        }
    }
    if !failed.is_empty() {
        return Err(format!("止められなかった: {}", failed.join("、")));
    }
    let (root, id, watch) = (root.to_path_buf(), id.to_string(), sent.clone());
    std::thread::spawn(move || {
        std::thread::sleep(HANGUP_WAIT);
        let left = verified_pids_of(&root, &id);
        for pid in watch.into_iter().filter(|p| left.contains(p)) {
            eprintln!("[native] SIGHUP で終わらなかったので SIGKILL を送る pid {pid}");
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    });
    Ok(sent)
}

/// id を名乗るプロセスが消えるのを、limit まで待つ。消えた（もともと無い）なら true。
/// アプリを入れ替えた直後は、前のアプリの claude が SIGHUP を受けてから終わるまでに1秒ほどかかる（2026-11-22 の実測で 1.27 秒）。
/// その間に立て直しを判定すると「よそで動いている」と見て外してしまうので、起動のときの立て直しはここで待ってから判定する
pub fn wait_gone(root: &Path, id: &str, limit: std::time::Duration) -> bool {
    let t0 = std::time::Instant::now();
    loop {
        if live_pid_of(root, id).is_none() {
            return true;
        }
        if t0.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// resume するときの cwd。jsonl の行の cwd のうち、projects/ の下のディレクトリ名（project_dir_name）が jsonl の置き場所と合うもの。
/// claude は cwd から projects/ の下を引いて jsonl を探すので、合わない cwd では resume できない。途中で cd したセッションは最初の行の cwd が合う
pub fn resume_cwd(jsonl: &Path) -> Option<String> {
    let dir = jsonl.parent()?.file_name()?.to_str()?.to_string();
    let f = fs::File::open(jsonl).ok()?;
    BufReader::new(f).lines().take(2000).map_while(Result::ok).find_map(|l| {
        let v: Value = serde_json::from_str(&l).ok()?;
        let c = v["cwd"].as_str()?;
        (project_dir_name(c) == dir).then(|| c.to_string())
    })
}

/// 生きている対話セッション（開始の古い順）
pub fn live(root: &Path, stats: &mut Stats) -> Vec<Session> {
    let mut raw = vec![];
    if let Ok(rd) = fs::read_dir(root.join("sessions")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            stats.session_files += 1;
            let v: Value = match fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()) {
                Some(v) => v,
                None => { stats.odd("sessions: 読めない json"); continue; }
            };
            let (Some(pid), Some(id), Some(cwd)) = (v["pid"].as_u64(), v["sessionId"].as_str(), v["cwd"].as_str()) else {
                stats.odd("sessions: pid、sessionId、cwd のどれかが無い");
                continue;
            };
            raw.push((pid as u32, id.to_string(), cwd.to_string(), v));
        }
    }
    // pid が死んでいる記録と、起動時刻の合わない記録（pid の使い回し）を、headless_of に渡す前に落とす。ps は1回だけ
    let starts: Vec<(u32, Option<String>)> = raw.iter().map(|r| (r.0, proc_start_of(&r.3))).collect();
    let ok = alive_as_recorded(&starts);
    let mut ok = ok.into_iter();
    raw.retain(|_| ok.next().unwrap_or(false));
    let keys: Vec<(u32, u64)> = raw.iter().map(|r| (r.0, r.3["startedAt"].as_u64().unwrap_or(0))).collect();
    let headless = headless_of(&keys);
    let mut g = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
    let known = g.get_or_insert_with(HashMap::new);
    let mut out = vec![];
    for (pid, id, cwd, v) in raw {
        if headless.get(&pid).copied().unwrap_or(false) {
            stats.headless += 1;
            continue;
        }
        stats.live += 1;
        let kind = v["kind"].as_str().unwrap_or("").to_string();
        if !matches!(kind.as_str(), "interactive" | "background") {
            stats.odd(format!("sessions: 知らない kind {kind:?}"));
        }
        let k = known.entry(id.clone()).or_default();
        let jsonl = match &k.jsonl {
            Some(p) if p.exists() => p.clone(),
            _ => {
                let (p, found) = locate(root, &id, &cwd, stats);
                if found {
                    k.jsonl = Some(p.clone());
                }
                p
            }
        };
        if k.parent.is_none() {
            k.parent = first_prompt_caller(&jsonl);
        }
        out.push(Session {
            pid,
            cwd,
            started_at: v["startedAt"].as_u64().unwrap_or(0),
            state: state_of(v["status"].as_str(), stats),
            updated_at: v["updatedAt"].as_u64().or(v["startedAt"].as_u64()).unwrap_or(0),
            title: v["name"].as_str().map(String::from),
            kind,
            jsonl,
            parent_raw: k.parent.clone().flatten(),
            socket: socket_from(&v),
            id,
        });
    }
    // 終わったセッションの分は忘れる
    let ids: std::collections::HashSet<&str> = out.iter().map(|s| s.id.as_str()).collect();
    known.retain(|k, _| ids.contains(k.as_str()));
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
    out
}

/// 様子の急ぎの順（承認待ち、作業中、待機）
fn urgency(state: &str) -> u8 {
    match state {
        "waiting_permission" => 2,
        "running" => 1,
        _ => 0,
    }
}

/// 同じ id の行を1つにまとめる（#331）。同じセッションを2か所で開く（Claude Town の端末と、外の端末の `claude -r <id>`）と、
/// sessions/ に同じ sessionId の記録が2つできる（#328）。画面、状態ファイル、avatars.json、操作の命令はどれも id を鍵にしているので、
/// 町の一覧では1つの id を1行にする。
/// - 残す行（pid、cwd、受信ソケット）は、このアプリが立てた端末の pid（app_pids）があればそれ、無ければ newer_first の先頭。
///   操作の行き先と同じにする（アプリの端末は pty、外は live_pid_of と verified_pid_of）
/// - 様子は、どれかが承認待ちなら承認待ち、どれかが作業中なら作業中（#329 の通知と同じ考え方）。開始は早いほう、最後の動きは遅いほう
/// - まとめた行の数は stats.dup_merged に数える
pub fn merge_same_id(live: Vec<Session>, app_pids: &std::collections::HashSet<u32>, stats: &mut Stats) -> Vec<Session> {
    let mut groups: Vec<Vec<Session>> = vec![];
    for s in live {
        match groups.iter_mut().find(|g| g[0].id == s.id) {
            Some(g) => g.push(s),
            None => groups.push(vec![s]),
        }
    }
    groups.into_iter().map(|mut g| {
        if g.len() == 1 {
            return g.pop().expect("1件ある");
        }
        stats.dup_merged += g.len() - 1;
        g.sort_by(|a, b| app_pids.contains(&b.pid).cmp(&app_pids.contains(&a.pid)).then(newer_first((a.started_at, a.pid), (b.started_at, b.pid))));
        let state = g.iter().map(|s| s.state).max_by_key(|s| urgency(s)).expect("1件以上");
        let started_at = g.iter().map(|s| s.started_at).min().expect("1件以上");
        let updated_at = g.iter().map(|s| s.updated_at).max().expect("1件以上");
        let title = g.iter().find_map(|s| s.title.clone());
        let mut keep = g.swap_remove(0);
        (keep.state, keep.started_at, keep.updated_at) = (state, started_at, updated_at);
        keep.title = keep.title.or(title);
        keep
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;

    /// HUP を受けたら dir/hup を書いて終わる代役（#309）。dir/ready が書かれるまで待ってから返す
    fn hup_stub(dir: &Path) -> std::process::Child {
        let d = dir.display();
        let child = std::process::Command::new("/bin/sh").arg("-c")
            .arg(format!("trap 'echo hup > {d}/hup; exit 0' HUP; echo ready > {d}/ready; while :; do sleep 0.1; done"))
            .spawn().unwrap();
        let t0 = std::time::Instant::now();
        while !dir.join("ready").exists() {
            assert!(t0.elapsed() < std::time::Duration::from_secs(5), "代役が起動しなかった");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        child
    }

    /// 代役の pid で sessions/<pid>.json を書く。proc_start が None なら procStart を書かない
    fn record_stub(root: &Path, pid: u32, id: &str, proc_start: Option<&str>) {
        let mut v = json!({ "pid": pid, "sessionId": id, "cwd": "/tmp/合成", "startedAt": 1_000u64, "kind": "interactive", "status": "idle" });
        if let Some(s) = proc_start {
            v["procStart"] = json!(s);
        }
        write(&root.join(format!("sessions/{pid}.json")), &v.to_string());
    }

    /// 代役が limit までに終わったか
    fn exits_within(child: &mut std::process::Child, limit: std::time::Duration) -> bool {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < limit {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn hangup_sends_sighup_to_the_recorded_claude() {
        // 記録の起動時刻が今のプロセスと合えば、SIGHUP を送って止める（#309）
        let root = tmp("hangup-ok");
        let mut child = hup_stub(&root);
        let pid = child.id();
        let start = ps_lstart(&[pid]).remove(&pid).expect("ps で起動時刻が取れる");
        let id = "eeeeeeee-0000-4000-8000-00000000000e";
        record_stub(&root, pid, id, Some(&start));
        assert_eq!(hangup(&root, id, None), Ok(vec![pid]));
        assert!(exits_within(&mut child, std::time::Duration::from_secs(3)), "SIGHUP で終わらなかった");
        assert!(root.join("hup").exists(), "SIGHUP が届かなかった");
    }

    #[test]
    fn hangup_refuses_when_the_start_time_does_not_match() {
        // pid が別のプロセスに使い回された記録（起動時刻が合わない）と、起動時刻の無い記録には信号を送らない（#309）
        for (name, start) in [("hangup-reused", Some("Mon Jan 1 00:00:00 2001")), ("hangup-nostart", None)] {
            let root = tmp(name);
            let mut child = hup_stub(&root);
            let pid = child.id();
            let id = "ffffffff-0000-4000-8000-00000000000f";
            record_stub(&root, pid, id, start);
            assert!(hangup(&root, id, None).is_err(), "{name}: 断らなかった");
            let ended = exits_within(&mut child, std::time::Duration::from_millis(500));
            let _ = child.kill();
            let _ = child.wait();
            assert!(!ended && !root.join("hup").exists(), "{name}: 信号が届いた");
        }
    }

    #[test]
    fn project_dir_name_replaces_every_non_alnum() {
        assert_eq!(project_dir_name("/Users/a/Documents/family-computing/.claude/worktrees/x_y"), "-Users-a-Documents-family-computing--claude-worktrees-x-y");
    }

    #[test]
    fn caller_of_reads_the_from_line() {
        assert_eq!(caller_of("from agent:pro/746b380e/impl via pro\n\n本文").as_deref(), Some("agent:pro/746b380e/impl"));
        assert_eq!(caller_of("from me@example.com via pro\n本文").as_deref(), Some("me@example.com"));
        assert_eq!(caller_of("from 東京 に行く"), None);
        assert_eq!(caller_of("ふつうの文"), None);
    }

    /// 1行目が短い非 user の行、2行目が 1MB を超える user の行（#234）
    fn big_prompt(root: &Path, name: &str, content: &str) -> PathBuf {
        let p = root.join(name);
        write(&p, &format!(
            "{}\n{{\"parentUuid\":null,\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":{content}}},\"uuid\":\"u\"}}\n",
            r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{}}"#,
        ));
        p
    }

    #[test]
    fn first_prompt_over_1mb_reads_the_from_line_at_its_head() {
        let root = tmp("big-prompt");
        let body = "あ".repeat(700_000); // 2.1MB
        // 本文が文字列
        let s = serde_json::to_string(&format!("from agent:node/2222aaaa/role via node\n\n{body}")).unwrap();
        let p = big_prompt(&root, "str.jsonl", &s);
        assert!(fs::metadata(&p).unwrap().len() > 2 << 20);
        assert_eq!(first_prompt_caller(&p), Some(Some("agent:node/2222aaaa/role".into())));
        // 本文が配列で、文の後ろに大きな画像が続く（貼った画像の付いた最初の文の実際の形）
        let img = "A".repeat(3 << 20);
        let a = format!(r#"[{{"type":"text","text":"from me@example.com via pro\n見て"}},{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{img}"}}}}]"#);
        let p = big_prompt(&root, "arr.jsonl", &a);
        assert_eq!(first_prompt_caller(&p), Some(Some("me@example.com".into())));
        // from 行の無い大きな文は Some(None)（読み直さない）
        let s = serde_json::to_string(&body).unwrap();
        assert_eq!(first_prompt_caller(&big_prompt(&root, "plain.jsonl", &s)), Some(None));
    }

    #[test]
    fn first_prompt_beyond_1mb_stops_rereading() {
        let root = tmp("big-other");
        // 最初の user の行の前に 1MB を超える非 user の行がある。from 行は探せないので Some(None)
        let p = root.join("other.jsonl");
        write(&p, &format!(
            "{{\"type\":\"attachment\",\"data\":\"{}\"}}\n{}\n",
            "x".repeat(2 << 20),
            r#"{"type":"user","message":{"content":"from agent:n/1/r via n\nやって"}}"#,
        ));
        assert_eq!(first_prompt_caller(&p), Some(None));
        // まだ user の行が無い短い記録は、今までどおり None（次の回に読み直す）
        let p = root.join("young.jsonl");
        write(&p, "{\"type\":\"file-history-snapshot\",\"snapshot\":{}}\n");
        assert_eq!(first_prompt_caller(&p), None);
        // 書きかけの user の行で終わっている短い記録も None
        let p = root.join("half.jsonl");
        write(&p, "{\"type\":\"file-history-snapshot\",\"snapshot\":{}}\n{\"type\":\"user\",\"message\":{\"content\":\"from a via");
        assert_eq!(first_prompt_caller(&p), None);
        // 1MB を超える user の行を書いている途中も None（Some(None) で覚えると、from 行があっても親子がつながらない）
        let p = root.join("half-big.jsonl");
        write(&p, &format!(
            "{{\"type\":\"file-history-snapshot\",\"snapshot\":{{}}}}\n{{\"type\":\"user\",\"message\":{{\"content\":\"from agent:n/1/r via n\\n{}",
            "x".repeat(2 << 20),
        ));
        assert_eq!(first_prompt_caller(&p), None);
    }

    #[test]
    fn live_session_with_jsonl_and_parent() {
        let root = tmp("live");
        let cwd = "/tmp/合成/proj";
        session(&root, "11111111-aaaa-bbbb-cccc-000000000001", cwd, "waiting");
        write(&root.join(format!("projects/{}/11111111-aaaa-bbbb-cccc-000000000001.jsonl", enc(cwd))), &[
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"from agent:node/2222aaaa/role via node\n\nやって"}}"#,
        ].join("\n"));
        let mut st = Stats::default();
        let v = live(&root, &mut st);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].state, "waiting_permission");
        assert_eq!(v[0].parent_raw.as_deref(), Some("agent:node/2222aaaa/role"));
        assert!(v[0].jsonl.exists());
        assert_eq!(st.live, 1);
        assert!(st.unexpected.is_empty(), "{:?}", st.unexpected);
        let row = v[0].to_row();
        assert_eq!(row["capabilities"]["send"], false);
        assert_eq!(row["kind"], "terminal");
    }

    #[test]
    fn moved_jsonl_is_found_and_dead_pids_are_skipped() {
        let root = tmp("moved");
        session(&root, "33333333-aaaa-bbbb-cccc-000000000003", "/tmp/合成/wt", "busy");
        // 規則の場所ではなく、別のプロジェクトの下にある（起動後に cd した）
        write(&root.join("projects/-tmp-other/33333333-aaaa-bbbb-cccc-000000000003.jsonl"), r#"{"type":"user","message":{"content":"こんにちは"}}"#);
        // 死んだ pid のファイルは読まない
        write(&root.join("sessions/999999.json"), r#"{"pid":999999,"sessionId":"dead","cwd":"/x","status":"idle"}"#);
        write(&root.join("sessions/bad.json"), "{");
        let mut st = Stats::default();
        let v = live(&root, &mut st);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].state, "running");
        assert!(v[0].jsonl.ends_with("projects/-tmp-other/33333333-aaaa-bbbb-cccc-000000000003.jsonl"));
        assert_eq!(v[0].parent_raw, None);
        assert_eq!(st.jsonl_searched, 1);
        assert_eq!(st.unexpected.get("sessions: 読めない json"), Some(&1));
    }

    /// session() で書いた sessions/<自分の pid>.json に procStart を足す（testtree の session() の引数は変えない）
    fn with_proc_start(root: &Path, proc_start: Value) {
        let p = root.join(format!("sessions/{}.json", std::process::id()));
        let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        v["procStart"] = proc_start;
        fs::write(&p, v.to_string()).unwrap();
    }

    /// 自分の起動時刻を、claude 本体と同じコマンドで取る（製品側の関数は使わない）
    fn my_lstart() -> String {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("LC_ALL=C TZ=UTC ps -o lstart= -p {}", std::process::id())])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn lstart_norm_folds_spaces_and_rejects_other_shapes() {
        assert_eq!(lstart_norm("Mon Nov  2 01:01:47 2026    ").as_deref(), Some("Mon Nov 2 01:01:47 2026"));
        assert_eq!(lstart_norm("Mon Nov 2 01:01:47 2026"), lstart_norm("Mon Nov  2 01:01:47 2026"));
        assert_eq!(lstart_norm("Sun Nov 22 16:01:47 2026").as_deref(), Some("Sun Nov 22 16:01:47 2026"));
        assert_eq!(lstart_norm(""), None);
        assert_eq!(lstart_norm("2026-11-22T16:01:47Z"), None);
        assert_eq!(lstart_norm("Sun Nov 22 16:01 2026"), None);
    }

    #[test]
    fn reused_pid_with_other_proc_start_is_not_live() {
        // pid は生きているが、記録の起動時刻が今のプロセスと違う（記録が残ったまま pid が使い回された）
        let root = tmp("reused");
        let sid = "44444444-aaaa-bbbb-cccc-000000000004";
        session(&root, sid, "/tmp/合成/ghost", "idle");
        with_proc_start(&root, json!("Sat Jan  1 00:00:00 2000"));
        let mut st = Stats::default();
        assert!(live(&root, &mut st).is_empty());
        assert_eq!(live_pid_of(&root, sid), None);
        assert!(wait_gone(&root, sid, std::time::Duration::ZERO));
    }

    #[test]
    fn matching_proc_start_is_live() {
        let root = tmp("procstart-ok");
        let sid = "55555555-aaaa-bbbb-cccc-000000000005";
        session(&root, sid, "/tmp/合成/ok", "idle");
        let now = my_lstart();
        assert!(!now.is_empty());
        with_proc_start(&root, json!(now));
        let mut st = Stats::default();
        assert_eq!(live(&root, &mut st).len(), 1);
        assert_eq!(live_pid_of(&root, sid), Some(std::process::id()));
    }

    #[test]
    fn unknown_proc_start_shapes_fall_back_to_pid() {
        // 形の分からない procStart は比べず、今までどおり pid だけで判定する（claude が形を変えても消えない）
        for (i, ps) in [json!(""), json!(12345), json!("2026-11-22T16:01:47Z"), json!(null)].into_iter().enumerate() {
            let root = tmp("procstart-odd");
            let sid = format!("66666666-aaaa-bbbb-cccc-00000000000{i}");
            session(&root, &sid, "/tmp/合成/odd", "idle");
            with_proc_start(&root, ps.clone());
            let mut st = Stats::default();
            assert_eq!(live(&root, &mut st).len(), 1, "{ps}");
            assert_eq!(live_pid_of(&root, &sid), Some(std::process::id()), "{ps}");
        }
    }

    #[test]
    fn live_pid_of_skips_stale_record_and_finds_the_resumed_one() {
        // resume で同じ id を新しい pid が名乗る。古い記録（起動時刻が違う）は飛ばして本物を返す
        let root = tmp("resumed");
        let sid = "77777777-aaaa-bbbb-cccc-000000000007";
        session(&root, sid, "/tmp/合成/r", "idle");
        with_proc_start(&root, json!(my_lstart()));
        // 古い記録。pid 1（launchd）は生きているが、起動時刻は合わない
        write(&root.join("sessions/1.json"), &json!({
            "pid": 1, "sessionId": sid, "cwd": "/tmp/合成/r", "status": "idle", "procStart": "Sat Jan  1 00:00:00 2000"
        }).to_string());
        assert_eq!(live_pid_of(&root, sid), Some(std::process::id()));
    }

    #[test]
    fn same_id_outside_twice_sends_and_stops_the_row_shown_in_town() {
        // #331: 外の端末2つで同じ id を開いた。町に残す行、送信のソケット、停止の pid を、新しく開いたほうにそろえる
        let root = tmp("dup-target");
        let id = "abcdabcd-0000-4000-8000-00000000abcd";
        let mut a = hup_stub(&tmp("dup-target-a"));
        let mut b = hup_stub(&tmp("dup-target-b"));
        let sock = |p: u32| root.join(format!("sock-{p}"));
        // 古いほう（a）を後から書いても、読む順に左右されない
        for (c, started) in [(&b, 3_000u64), (&a, 1_000u64)] {
            let pid = c.id();
            write(&sock(pid), "");
            let start = ps_lstart(&[pid]).remove(&pid).expect("ps で起動時刻が取れる");
            write(&root.join(format!("sessions/{pid}.json")), &json!({ "pid": pid, "sessionId": id, "cwd": "/tmp/合成/dup", "startedAt": started,
                "kind": "interactive", "status": "idle", "procStart": start, "messagingSocketPath": sock(pid) }).to_string());
        }
        let mut st = Stats::default();
        let rows = merge_same_id(live(&root, &mut st), &Default::default(), &mut st);
        let shown = rows.iter().find(|s| s.id == id).map(|s| s.pid);
        let (sent, stopped, pids) = (live_socket_of(&root, id), verified_pid_of(&root, id), live_pids_of(&root, id));
        let _ = (a.kill(), b.kill(), a.wait(), b.wait());
        assert_eq!(rows.len(), 1);
        assert_eq!(st.dup_merged, 1);
        assert_eq!(shown, Some(b.id()));
        assert_eq!(sent, Some(sock(b.id())));
        assert_eq!(stopped, Some(b.id()));
        assert_eq!(pids, vec![b.id(), a.id()]);
    }

    #[test]
    fn merge_same_id_prefers_the_app_terminal_and_the_most_urgent_state() {
        let s = |pid: u32, started: u64, state: &'static str, updated: u64, title: Option<&str>| Session {
            pid, id: "x".into(), cwd: format!("/p{pid}"), started_at: started, state, updated_at: updated, title: title.map(String::from),
            kind: "interactive".into(), jsonl: PathBuf::from("/x.jsonl"), parent_raw: None, socket: None,
        };
        let other = Session { id: "y".into(), ..s(9, 2_000, "idle", 2_000, None) };
        let rows = vec![s(1, 1_000, "running", 5_000, None), other.clone(), s(2, 3_000, "waiting_permission", 4_000, Some("題"))];
        let mut st = Stats::default();
        // アプリの端末（pid 1）が古くても残す。様子は承認待ち、題は持っている行から
        let out = merge_same_id(rows.clone(), &[1u32].into_iter().collect(), &mut st);
        assert_eq!(out.iter().map(|r| (r.id.as_str(), r.pid)).collect::<Vec<_>>(), vec![("x", 1), ("y", 9)]);
        let x = &out[0];
        assert_eq!((x.state, x.started_at, x.updated_at, x.cwd.as_str(), x.title.as_deref()), ("waiting_permission", 1_000, 5_000, "/p1", Some("題")));
        assert_eq!(st.dup_merged, 1);
        // アプリの端末が無ければ、新しく開いたほう（pid 2）
        let out = merge_same_id(rows, &Default::default(), &mut Stats::default());
        assert_eq!(out[0].pid, 2);
        // 1つしか無い id は触らない
        assert_eq!(merge_same_id(vec![other.clone()], &Default::default(), &mut Stats::default())[0].started_at, 2_000);
    }
}
