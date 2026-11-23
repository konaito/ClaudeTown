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
            "capabilities": super::caps_with_send(self.socket.is_some()),
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
    let f = fs::File::open(jsonl).ok()?;
    // 先頭の 1MB と 400 行までに無ければ、from 行は無いとみなす
    let r = BufReader::new(f.take(1 << 20));
    for (i, line) in r.lines().enumerate() {
        let Ok(line) = line else { break };
        if i >= 400 {
            return Some(None);
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
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

/// id を名乗っている、生きているプロセスの pid（sessions/<pid>.json を今読む）。無ければ None。
/// resume すると同じ id を新しい pid が名乗るので、起動時刻の合わない古い記録は飛ばして次を見る
pub fn live_pid_of(root: &Path, id: &str) -> Option<u32> {
    let cands: Vec<(u32, Option<String>)> = fs::read_dir(root.join("sessions")).ok()?.flatten().filter_map(|e| {
        let v: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
        let pid = v["pid"].as_u64()? as u32;
        (v["sessionId"].as_str() == Some(id)).then(|| (pid, proc_start_of(&v)))
    }).collect();
    let ok = alive_as_recorded(&cands);
    cands.iter().zip(ok).find(|(_, a)| *a).map(|(c, _)| c.0)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;

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
}
