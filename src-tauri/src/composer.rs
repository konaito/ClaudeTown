// チャットの入力欄（src/composer/）が、Claude Code の CLI の入力と同じ動きをするための命令。
// 仕様の出所と実測は docs/research/cli-input.md にある。
// - prompt_history(cwd): CLI の入力履歴（~/.claude/history.jsonl）。上下キーは同じ project の分、Ctrl+R は全部
// - slash_commands(cwd): / の候補にするスキルとコマンド（ユーザー、プロジェクト、有効なプラグイン）。組み込みのコマンドは画面が持つ
// - file_suggestions(cwd, query): @ の候補にするファイルとフォルダ
// - send_direct(session_id, text): このアプリが立てた端末（pty.rs）の入力欄へ貼って Enter を押す
// - send_or_queue / cancel_queued / boot_status: チャット欄の送信。claude の起動前に送った文は預かり、起動したら送る
// - interrupt_session(session_id): 端末に Esc を書いて、claude の今のターンを止める

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

// ---------- 履歴 ----------

#[derive(Serialize, Clone)]
pub struct History {
    /// 同じ project（作業フォルダ）の入力。新しい順。上下キーで使う
    pub project: Vec<String>,
    /// 全部の project の入力。新しい順。Ctrl+R で使う（CLI の inline の検索は全部の project を探す）
    pub all: Vec<String>,
}

const HISTORY_ALL_MAX: usize = 1000;
const HISTORY_PROJECT_MAX: usize = 1000;

/// 別のプロダクト（ccn など）が本文の前に付ける1行（from <誰> via <ノード>）を外す。人が打ったのは、その後ろの文だから
pub fn strip_from_line(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("from ")
        && let Some(nl) = rest.find('\n') {
            let w: Vec<&str> = rest[..nl].split(' ').collect();
            if w.len() == 3 && w[1] == "via" && !w[0].is_empty() && !w[2].is_empty() {
                return rest[nl..].trim_start_matches('\n');
            }
        }
    s
}

/// [Pasted text #N ...] を、CLI が貼り付けの置き場（~/.claude/paste-cache/<hash>.txt）に残した本文に戻す。
/// CLI も履歴から呼び戻して送り直すときは本文を送る（interactive-mode の Command history）
fn expand_pastes(display: &str, pasted: Option<&Value>, home: &Path) -> String {
    let Some(map) = pasted.and_then(|v| v.as_object()) else { return display.to_string() };
    let mut out = display.to_string();
    for (k, v) in map {
        if v.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        let body = v.get("content").and_then(|c| c.as_str()).map(|s| s.to_string()).or_else(|| {
            let h = v.get("contentHash")?.as_str()?;
            fs::read_to_string(home.join(".claude/paste-cache").join(format!("{h}.txt"))).ok()
        });
        let Some(body) = body else { continue };
        let tag = format!("[Pasted text #{k}");
        if let Some(start) = out.find(&tag)
            && let Some(end) = out[start..].find(']') {
                out.replace_range(start..start + end + 1, &body);
            }
    }
    out
}

/// history.jsonl の行を新しい順に並べ、同じ文が続いたものは1つにする。
/// all が false なら cwd の project の分だけ、true なら全部の project の分だけを返す（上下キーと Ctrl+R で使い分け、毎回の受け渡しを小さくする）。
/// 貼り付けの本文に戻すのは、返す行だけにする
pub fn history_from(lines: &str, cwd: Option<&str>, all: bool, home: &Path) -> History {
    let max = if all { HISTORY_ALL_MAX } else { HISTORY_PROJECT_MAX };
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if !all && cwd.is_none() {
        return History { project: out, all: vec![] };
    }
    for line in lines.lines().rev() {
        if out.len() >= max {
            break;
        }
        // project で先に絞る（JSON を開く前に、文字列で見て外れる行を飛ばす）
        if let (false, Some(c)) = (all, cwd)
            && !line.contains(&format!("\"project\":{}", Value::String(c.to_string()))) {
                continue;
            }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if !all && v.get("project").and_then(|p| p.as_str()) != cwd {
            continue;
        }
        let Some(display) = v.get("display").and_then(|d| d.as_str()) else { continue };
        let key = strip_from_line(display).to_string();
        if key.trim().is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(strip_from_line(&expand_pastes(display, v.get("pastedContents"), home)).to_string());
    }
    if all { History { project: vec![], all: out } } else { History { project: out, all: vec![] } }
}

/// history.jsonl は 7MB ほどあるので、変わっていなければ前に読んだ中身を使う
static HISTORY_CACHE: Mutex<Option<(SystemTime, u64, String)>> = Mutex::new(None);

pub fn prompt_history(cwd: Option<String>, all: bool) -> Result<History, String> {
    let home = super::home();
    let path = home.join(".claude/history.jsonl");
    let meta = fs::metadata(&path).map_err(|e| format!("履歴を読めない: {e}"))?;
    let stamp = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
    let mut g = HISTORY_CACHE.lock().map_err(|e| e.to_string())?;
    let fresh = matches!(&*g, Some((m, l, _)) if (*m, *l) == stamp);
    if !fresh {
        let s = fs::read_to_string(&path).map_err(|e| format!("履歴を読めない: {e}"))?;
        *g = Some((stamp.0, stamp.1, s));
    }
    let s = &g.as_ref().unwrap().2;
    Ok(history_from(s, cwd.as_deref(), all, &home))
}

// ---------- / の候補（スキルとコマンド） ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    #[serde(rename = "argumentHint")]
    pub argument_hint: Option<String>,
    /// user、project、plugin のどれか（CLI の候補の右に出る印と同じ）
    pub source: String,
}

/// SKILL.md とコマンドの .md の先頭の --- の間から、name、description、argument-hint、user-invocable を読む
pub fn front_matter(md: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let mut lines = md.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return m;
    }
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        if l.starts_with(' ') || l.starts_with('\t') {
            continue;
        }
        if let Some((k, v)) = l.split_once(':') {
            let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
            m.insert(k.trim().to_string(), v);
        }
    }
    m
}

fn first_line_of_body(md: &str) -> String {
    let body = if md.trim_start().starts_with("---") {
        md.splitn(3, "---").nth(2).unwrap_or("")
    } else {
        md
    };
    body.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or("").chars().take(120).collect()
}

fn push_cmd(out: &mut Vec<SlashCommand>, seen: &mut HashSet<String>, name: String, md: &str, source: &str) {
    let fm = front_matter(md);
    if fm.get("user-invocable").map(|v| v == "false").unwrap_or(false) {
        return;
    }
    if !seen.insert(name.clone()) {
        return;
    }
    let description = fm.get("description").filter(|d| !d.is_empty()).cloned().unwrap_or_else(|| first_line_of_body(md));
    out.push(SlashCommand { name, description, argument_hint: fm.get("argument-hint").cloned().filter(|s| !s.is_empty()), source: source.into() });
}

/// <dir>/skills/<名前>/SKILL.md と <dir>/commands/**/*.md を読む。commands の下のフォルダは : でつなぐ（frontend/component.md は frontend:component）
fn scan_claude_dir(dir: &Path, prefix: &str, source: &str, out: &mut Vec<SlashCommand>, seen: &mut HashSet<String>) {
    if let Ok(rd) = fs::read_dir(dir.join("skills")) {
        let mut ents: Vec<_> = rd.flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let p = e.path().join("SKILL.md");
            let Ok(md) = fs::read_to_string(&p) else { continue };
            let dir_name = e.file_name().to_string_lossy().to_string();
            let name = front_matter(&md).get("name").filter(|n| !n.is_empty()).cloned().unwrap_or(dir_name);
            push_cmd(out, seen, format!("{prefix}{name}"), &md, source);
        }
    }
    fn walk(base: &Path, d: &Path, prefix: &str, source: &str, out: &mut Vec<SlashCommand>, seen: &mut HashSet<String>, depth: usize) {
        if depth > 4 {
            return;
        }
        let Ok(rd) = fs::read_dir(d) else { return };
        let mut ents: Vec<_> = rd.flatten().collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, prefix, source, out, seen, depth + 1);
            } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                let Ok(md) = fs::read_to_string(&p) else { continue };
                let rel = p.strip_prefix(base).unwrap_or(&p).with_extension("");
                let name = rel.to_string_lossy().replace('/', ":");
                push_cmd(out, seen, format!("{prefix}{name}"), &md, source);
            }
        }
    }
    let cmds = dir.join("commands");
    walk(&cmds, &cmds, prefix, source, out, seen, 0);
}

/// 有効なプラグイン（settings.json の enabledPlugins が true）の置き場所。installed_plugins.json の installPath を使う
fn enabled_plugins(home: &Path) -> Vec<(String, PathBuf)> {
    let settings = super::read_json(&home.join(".claude/settings.json")).unwrap_or(Value::Null);
    let installed = super::read_json(&home.join(".claude/plugins/installed_plugins.json")).unwrap_or(Value::Null);
    let mut out = Vec::new();
    let Some(en) = settings.get("enabledPlugins").and_then(|v| v.as_object()) else { return out };
    for (id, on) in en {
        if on.as_bool() != Some(true) {
            continue;
        }
        let Some(path) = installed.pointer(&format!("/plugins/{}", id.replace('~', "~0").replace('/', "~1"))).and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|x| x.get("installPath")).and_then(|p| p.as_str()) else { continue };
        let name = id.split('@').next().unwrap_or(id).to_string();
        out.push((name, PathBuf::from(path)));
    }
    out.sort();
    out
}

pub fn slash_commands_in(home: &Path, cwd: Option<&str>) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // プロジェクトの分を先に読む。同じ名前はプロジェクトのほうを残す
    if let Some(c) = cwd {
        let mut d = Some(PathBuf::from(c));
        while let Some(p) = d {
            if p == home || p.as_os_str().is_empty() || p == Path::new("/") {
                break;
            }
            scan_claude_dir(&p.join(".claude"), "", "project", &mut out, &mut seen);
            d = p.parent().map(|x| x.to_path_buf());
        }
    }
    scan_claude_dir(&home.join(".claude"), "", "user", &mut out, &mut seen);
    for (name, path) in enabled_plugins(home) {
        scan_claude_dir(&path, &format!("{name}:"), "plugin", &mut out, &mut seen);
    }
    out
}

pub fn slash_commands(cwd: Option<String>) -> Vec<SlashCommand> {
    slash_commands_in(&super::home(), cwd.as_deref())
}

// ---------- @ の候補（ファイル） ----------

/// cwd のファイルとフォルダの一覧。git の中なら ls-files（.gitignore に従う）、外なら浅く歩く。30秒は前の一覧を使う
/// 覚えた時刻と一覧
type FilesEntry = (Instant, Vec<String>);
static FILES_CACHE: Mutex<Option<HashMap<String, FilesEntry>>> = Mutex::new(None);
const FILES_MAX: usize = 30000;

fn list_files(cwd: &str) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"])
        .output();
    let mut files: Vec<String> = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).lines().take(FILES_MAX).map(|s| s.to_string()).collect(),
        _ => {
            let mut v = Vec::new();
            fn walk(base: &Path, d: &Path, v: &mut Vec<String>, depth: usize) {
                if depth > 6 || v.len() >= 5000 {
                    return;
                }
                let Ok(rd) = fs::read_dir(d) else { return };
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n == ".git" || n == "node_modules" || n == "target" {
                        continue;
                    }
                    let p = e.path();
                    let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().to_string();
                    if p.is_dir() {
                        walk(base, &p, v, depth + 1);
                    } else {
                        v.push(rel);
                    }
                }
            }
            walk(Path::new(cwd), Path::new(cwd), &mut v, 0);
            v
        }
    };
    // フォルダも候補にする（CLI は「+ .claude/」のようにフォルダも出す）
    let mut dirs = HashSet::new();
    for f in &files {
        let mut p = Path::new(f).parent();
        while let Some(d) = p {
            if d.as_os_str().is_empty() {
                break;
            }
            dirs.insert(format!("{}/", d.to_string_lossy()));
            p = d.parent();
        }
    }
    files.extend(dirs);
    files
}

/// 何も打っていなければ浅いものから。打っていれば、名前の先頭が合うもの、名前に含むもの、パスに含むもの、飛び飛びに合うものの順
pub fn rank_files(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let q = query.to_lowercase();
    let mut scored: Vec<(u32, usize, &String)> = Vec::new();
    for f in files {
        let lower = f.to_lowercase();
        let base = lower.trim_end_matches('/').rsplit('/').next().unwrap_or(&lower).to_string();
        let score = if q.is_empty() {
            Some(f.trim_end_matches('/').matches('/').count() as u32)
        } else if base.starts_with(&q) {
            Some(0)
        } else if base.contains(&q) {
            Some(10)
        } else if lower.contains(&q) {
            Some(20)
        } else {
            let mut it = lower.chars();
            if q.chars().all(|c| it.any(|x| x == c)) { Some(30) } else { None }
        };
        if let Some(s) = score {
            scored.push((s, f.len(), f));
        }
    }
    scored.sort();
    scored.into_iter().take(limit).map(|(_, _, f)| f.clone()).collect()
}

pub fn file_suggestions(cwd: String, query: String) -> Result<Vec<String>, String> {
    if cwd.is_empty() || !Path::new(&cwd).is_dir() {
        return Ok(vec![]);
    }
    let files = {
        let mut g = FILES_CACHE.lock().map_err(|e| e.to_string())?;
        let m = g.get_or_insert_with(HashMap::new);
        match m.get(&cwd) {
            Some((t, v)) if t.elapsed() < Duration::from_secs(30) => v.clone(),
            _ => {
                let v = list_files(&cwd);
                m.insert(cwd.clone(), (Instant::now(), v.clone()));
                v
            }
        }
    };
    Ok(rank_files(&files, &query, 15))
}

// ---------- PTY への直接の送信と中断 ----------

/// 貼り付けの終わりの印を本文から外す。本文に入っていると、そこで貼り付けが終わり、残りがキーとして読まれる
pub fn paste_body(text: &str) -> String {
    text.replace("\x1b[201~", "").replace("\x1b[200~", "")
}

/// チャット欄の文を、このアプリが立てた端末の入力欄へ貼り、Enter を押す。/ と ! の文も、CLI に打ったのと同じに動く。
/// 承認待ちのときに Enter を送ると、許可を押したことになるので、送る前に状態を見る（check_direct）
pub fn send_direct(session_id: String, text: String) -> Result<(), String> {
    super::refuse_if_disabled()?;
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    match gate(&session_id)? {
        Gate::Ready => paste_enter(&session_id, &text),
        Gate::Booting => Err(NOT_BOOTED.into()),
        Gate::Refused(e) => Err(e),
    }
}

const NOT_BOOTED: &str = "claude がまだ起動していない（信頼の確認の画面かもしれない）。ターミナルで確かめてから送って";
const WAITING: &str = "承認待ちなので送らなかった。先にターミナルで承認に答えて";

fn paste_enter(session_id: &str, text: &str) -> Result<(), String> {
    super::pty::write(session_id, &format!("\x1b[200~{}\x1b[201~", paste_body(text)))?;
    // 貼り付けと Enter の間を空ける。続けて書くと、貼り付けの最後と Enter が1つの入力として読まれ、改行になることがある
    std::thread::sleep(Duration::from_millis(150));
    super::pty::write(session_id, "\r")
}

/// 今この端末へ送ってよいか
#[derive(Debug, PartialEq)]
pub enum Gate {
    Ready,
    /// claude がまだ起動していない（信頼の確認の画面を含む）。起動を待てば送れる
    Booting,
    /// 承認待ちなど、待っても自分からは送れるようにならない理由
    Refused(String),
}

/// 送る直前の状態。承認待ちかは sessions/<pid>.json を読み直して決める。一覧（2〜8秒おき）の値を使うと、
/// 承認の画面に入った直後に送った文と Enter が、承認の画面に届く
fn gate(session_id: &str) -> Result<Gate, String> {
    let started = super::pty::started_at(session_id).ok_or("このセッションの端末はこのアプリに無い")?;
    let row = super::pty::pid_of_id(session_id).and_then(|pid| super::native::sessions::fresh_row(&super::native::claude_home(), pid));
    let hooked = hooked_since(&super::fc_path(super::Scope::Shared, &format!("state/{session_id}.json")), started);
    Ok(gate_of(row.as_ref(), hooked, started, super::now_ms() as u64))
}

/// claude が入力を受け付けるところまで起動したか（アプリが立てた端末だけ。ほかは None）。町の一覧の booting に使う
pub fn booted(session_id: &str) -> Option<bool> {
    gate(session_id).ok().map(|g| g != Gate::Booting)
}

/// hook の状態ファイル（state/<id>.json）が、この起動の後に書かれたか。claude --resume で立て直すと（pty.rs の resume）、
/// 前の起動のファイルが残っているので、あるかどうかだけでは起動済みの印にならない
pub fn hooked_since(path: &Path, started_at: u64) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .is_some_and(|d| d.as_millis() as u64 >= started_at)
}

/// 直接送ってよい状態か。row は Claude Code の記録（sessions/<pid>.json）から読んだ行（まだ無ければ None）。
/// hooked は hook の状態ファイル（state/<id>.json）がこの起動の後に書かれたか（hooked_since）
pub fn gate_of(row: Option<&Value>, hooked: bool, started_at: u64, now_ms: u64) -> Gate {
    if let Some(r) = row
        && r.get("state").and_then(|s| s.as_str()) == Some("waiting_permission") {
            return Gate::Refused(WAITING.into());
        }
    // claude が起動し、信頼の確認を抜けたか。信頼の確認の画面で Enter を送ると、既定の「No, exit」が選ばれて claude が終わる
    // （2026-11-13 に画面で見た）。SessionStart の hook が届くと state/<id>.json が書かれ、sessions/<pid>.json の updatedAt が startedAt より進む。
    // どちらかがあれば起動したとみる。入力の受け付けは SessionStart の 0.3〜1.4 秒後なので、起動から3秒は待つ
    let active = row.map(|r| r["lastActivityAt"].as_u64().unwrap_or(0) > r["startedAt"].as_u64().unwrap_or(u64::MAX)).unwrap_or(false);
    if !(hooked || active) || now_ms.saturating_sub(started_at) < 3000 {
        return Gate::Booting;
    }
    Gate::Ready
}

/// gate_of を文で返す形（switch.rs が使う）
pub fn check_direct(row: Option<&Value>, hooked: bool, started_at: u64, now_ms: u64) -> Result<(), String> {
    match gate_of(row, hooked, started_at, now_ms) {
        Gate::Ready => Ok(()),
        Gate::Booting => Err(NOT_BOOTED.into()),
        Gate::Refused(e) => Err(e),
    }
}

// ---------- 起動を待って送る ----------
//
// claude の起動が終わる前（信頼の確認の画面を含む）にチャット欄から送った文は、ここで持ち、起動したら古い順に送る。
// 送る直前に毎回 gate を通すので、起動したと確かめられないまま Enter を押すことはない。
// 見張りは Rust のスレッドで回す（画面の時計は、窓が隠れると止まる）。持っている文は、取り消すか、端末が終わるまで残す。
// アプリを閉じたら消える（アプリが立てた claude もアプリと一緒に止まる）

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Waiting {
    pub text: String,
    /// 預かった時刻（ms）
    pub at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Sent {
    pub text: String,
    pub at: u64,
    /// 送った（送れなかった）時刻
    #[serde(rename = "doneAt")]
    pub done_at: u64,
    /// 送れなかった理由。送れたら None
    pub error: Option<String>,
}

#[derive(Default)]
struct Waits {
    queue: HashMap<String, Vec<Waiting>>,
    /// 見張りが今送っている文。取り消しても戻さない（もう端末に書いている）
    sending: HashMap<String, Waiting>,
    /// 送り終えた文（画面が「届けた」の印に替えるため、と送れなかった理由を出すため）。セッションごとに新しい DONE_MAX 件
    done: HashMap<String, Vec<Sent>>,
    running: bool,
}

const DONE_MAX: usize = 10;
static WAITS: Mutex<Option<Waits>> = Mutex::new(None);

fn waits<T>(f: impl FnOnce(&mut Waits) -> T) -> T {
    let mut g = WAITS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Waits::default))
}

fn finish(w: &mut Waits, id: &str, item: Waiting, error: Option<String>) {
    let d = w.done.entry(id.to_string()).or_default();
    d.push(Sent { text: item.text, at: item.at, done_at: super::now_ms() as u64, error });
    let n = d.len();
    if n > DONE_MAX {
        d.drain(..n - DONE_MAX);
    }
}

/// 送る。起動がまだなら預かり、起動したら送る。預かったら queued: true を返す。
/// 先に預かった文があれば、順番を守るため、起動していても後ろに並べる
pub fn send_or_queue(session_id: String, text: String) -> Result<Value, String> {
    super::refuse_if_disabled()?;
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    let item = Waiting { text: text.clone(), at: super::now_ms() as u64 };
    let queued = waits(|w| {
        if w.queue.get(&session_id).is_some_and(|q| !q.is_empty()) || w.sending.contains_key(&session_id) {
            w.queue.entry(session_id.clone()).or_default().push(item.clone());
            true
        } else {
            false
        }
    });
    if queued {
        return Ok(serde_json::json!({ "queued": true }));
    }
    match gate(&session_id)? {
        Gate::Ready => paste_enter(&session_id, &text).map(|_| serde_json::json!({ "queued": false })),
        Gate::Refused(e) => Err(e),
        Gate::Booting => {
            let start = waits(|w| {
                w.queue.entry(session_id.clone()).or_default().push(item);
                !std::mem::replace(&mut w.running, true)
            });
            if start {
                std::thread::spawn(watch_waits);
            }
            Ok(serde_json::json!({ "queued": true }))
        }
    }
}

/// 預かった文を取り消し、その文を古い順に返す（画面が入力欄に戻す）。見張りが今送っている文は返さない
pub fn cancel_queued(session_id: &str) -> Vec<String> {
    waits(|w| w.queue.remove(session_id).unwrap_or_default().into_iter().map(|x| x.text).collect())
}

/// 起動したかと、預かっている文、送り終えた文。アプリが立てた端末でなければ booted: true（待つものが無い）
pub fn boot_status(session_id: &str) -> Value {
    let started = super::pty::started_at(session_id);
    let booted = booted(session_id).unwrap_or(true);
    // 信頼する前は sessions/<pid>.json が作られない（pty.rs の real_claude_pty で実測）。無いまま長いときは、信頼の確認の画面を疑う
    let row_seen = super::pty::pid_of_id(session_id).and_then(|pid| super::native::sessions::fresh_row(&super::native::claude_home(), pid)).is_some();
    let (queue, done) = waits(|w| {
        let mut q: Vec<Waiting> = w.sending.get(session_id).cloned().into_iter().collect();
        q.extend(w.queue.get(session_id).cloned().unwrap_or_default());
        (q, w.done.get(session_id).cloned().unwrap_or_default())
    });
    serde_json::json!({ "booted": booted, "rowSeen": row_seen, "startedAt": started, "queued": queue, "done": done })
}

/// 預かった文を、起動したら送る見張り。預かった文が無くなったら終わる
fn watch_waits() {
    loop {
        let ids: Vec<String> = waits(|w| {
            w.queue.retain(|_, q| !q.is_empty());
            if w.queue.is_empty() {
                w.running = false;
            }
            w.queue.keys().cloned().collect()
        });
        if ids.is_empty() {
            return;
        }
        for id in ids {
            let g = gate(&id);
            if matches!(g, Ok(Gate::Booting)) || matches!(g, Ok(Gate::Refused(_))) {
                // 起動を待つ。承認待ち（端末で何かを打った後）も、答え終わるまで待つ
                continue;
            }
            if let Err(e) = g {
                // 端末が無くなった。預かった文は全部、送れなかったことにする
                waits(|w| {
                    for item in w.queue.remove(&id).unwrap_or_default() {
                        finish(w, &id, item, Some(format!("送れなかった: {e}")));
                    }
                });
                continue;
            }
            let Some(item) = waits(|w| {
                let q = w.queue.get_mut(&id)?;
                if q.is_empty() {
                    return None;
                }
                let item = q.remove(0);
                w.sending.insert(id.clone(), item.clone());
                Some(item)
            }) else { continue };
            let r = if super::send_disabled() { Err("送信を止めている（~/.family-computing/send-disabled がある）".to_string()) } else { paste_enter(&id, &item.text) };
            eprintln!("[boot] {id} 預かった文を送った: {r:?}");
            waits(|w| {
                w.sending.remove(&id);
                finish(w, &id, item, r.err());
            });
            // 続けて送る文は、前の文が入力として読まれてから送る
            std::thread::sleep(Duration::from_millis(500));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// 今のターンを止める。端末で Esc を押したのと同じ
pub fn interrupt_session(session_id: String) -> Result<(), String> {
    super::refuse_if_disabled()?;
    super::pty::write(&session_id, "\x1b")
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    #[tauri::command]
    pub async fn prompt_history(cwd: Option<String>, all: Option<bool>) -> Result<super::History, String> {
        crate::blocking(move || super::prompt_history(cwd, all.unwrap_or(false))).await
    }
    #[tauri::command]
    pub async fn slash_commands(cwd: Option<String>) -> Result<Vec<super::SlashCommand>, String> {
        crate::blocking(move || Ok(super::slash_commands(cwd))).await
    }
    #[tauri::command]
    pub async fn file_suggestions(cwd: String, query: String) -> Result<Vec<String>, String> {
        crate::blocking(move || super::file_suggestions(cwd, query)).await
    }
    #[tauri::command]
    pub async fn send_direct(session_id: String, text: String) -> Result<(), String> {
        crate::app_guard(&session_id)?;
        crate::blocking(move || super::send_direct(session_id, text)).await
    }
    #[tauri::command]
    pub async fn send_or_queue(session_id: String, text: String) -> Result<serde_json::Value, String> {
        crate::app_guard(&session_id)?;
        crate::blocking(move || super::send_or_queue(session_id, text)).await
    }
    #[tauri::command]
    pub async fn cancel_queued(session_id: String) -> Result<Vec<String>, String> {
        Ok(super::cancel_queued(&session_id))
    }
    #[tauri::command]
    pub async fn boot_status(session_id: String) -> Result<serde_json::Value, String> {
        crate::blocking(move || Ok(super::boot_status(&session_id))).await
    }
    #[tauri::command]
    pub async fn interrupt_session(session_id: String) -> Result<(), String> {
        crate::app_guard(&session_id)?;
        crate::blocking(move || super::interrupt_session(session_id)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_ccn_from_line() {
        assert_eq!(strip_from_line("from local via konaito-pro\n\n/ct-echo hi"), "/ct-echo hi");
        assert_eq!(strip_from_line("from agent:konaito-pro/29cf3311/lead via konaito-pro\n\n親から"), "親から");
        assert_eq!(strip_from_line("from here on, do X\nnext"), "from here on, do X\nnext");
        assert_eq!(strip_from_line("hello"), "hello");
    }

    #[test]
    fn history_is_newest_first_per_project() {
        let home = Path::new("/nonexistent");
        let lines = [
            json!({"display":"a","project":"/p"}),
            json!({"display":"b","project":"/q"}),
            json!({"display":"c","project":"/p"}),
            json!({"display":"a","project":"/p"}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(history_from(&lines, Some("/p"), false, home).project, vec!["a", "c"]);
        assert_eq!(history_from(&lines, Some("/p"), true, home).all, vec!["a", "c", "b"]);
    }

    #[test]
    fn reads_front_matter() {
        let md = "---\nname: ct-echo\ndescription: \"Reply PONG\"\nargument-hint: <word>\nuser-invocable: false\n---\nbody";
        let fm = front_matter(md);
        assert_eq!(fm.get("name").unwrap(), "ct-echo");
        assert_eq!(fm.get("description").unwrap(), "Reply PONG");
        assert_eq!(fm.get("argument-hint").unwrap(), "<word>");
        assert_eq!(fm.get("user-invocable").unwrap(), "false");
    }

    #[test]
    fn scans_project_skills_and_commands() {
        let root = std::env::temp_dir().join(format!("ct-composer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let proj = root.join("proj");
        fs::create_dir_all(proj.join(".claude/skills/deploy")).unwrap();
        fs::create_dir_all(proj.join(".claude/commands/frontend")).unwrap();
        fs::create_dir_all(proj.join(".claude/skills/hidden")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(proj.join(".claude/skills/deploy/SKILL.md"), "---\ndescription: Deploy it\n---\n").unwrap();
        fs::write(proj.join(".claude/skills/hidden/SKILL.md"), "---\nuser-invocable: false\n---\n").unwrap();
        fs::write(proj.join(".claude/commands/frontend/component.md"), "# Make a component\n").unwrap();
        let got = slash_commands_in(&home, Some(proj.to_str().unwrap()));
        let names: Vec<_> = got.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["deploy", "frontend:component"]);
        assert_eq!(got[1].description, "Make a component");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ranks_files() {
        let f: Vec<String> = ["src/App.tsx", "a.txt", "src/", "docs/app-notes.md", "README.md"].iter().map(|s| s.to_string()).collect();
        assert_eq!(rank_files(&f, "app", 10), vec!["src/App.tsx", "docs/app-notes.md"]);
        assert_eq!(rank_files(&f, "", 2), vec!["src/", "a.txt"]);
    }

    #[test]
    fn direct_send_refuses_while_waiting() {
        let ok = json!({"state":"idle","startedAt":1000,"lastActivityAt":1800});
        let now = 10_000;
        assert!(check_direct(Some(&ok), false, 1000, now).is_ok());
        assert!(check_direct(None, true, 1000, now).is_ok());
        // 信頼の確認の画面（hook がまだ来ていない）と、起動の直後
        assert!(check_direct(Some(&json!({"state":"idle","startedAt":1000,"lastActivityAt":1000})), false, 1000, now).is_err());
        assert!(check_direct(None, false, 1000, now).is_err());
        assert!(check_direct(Some(&ok), true, 1000, 2000).is_err());
        assert!(check_direct(Some(&json!({"state":"waiting_permission","startedAt":1000,"lastActivityAt":1800})), true, 1000, now).is_err());
        assert_eq!(paste_body("a\x1b[201~b"), "ab");
        // 起動待ちだけが「待てば送れる」。承認待ちは待たない理由として返す（預かって送る見張りが、起動待ちと見分ける）
        assert_eq!(gate_of(None, false, 1000, now), Gate::Booting);
        assert_eq!(gate_of(Some(&ok), true, 1000, 2000), Gate::Booting);
        assert!(matches!(gate_of(Some(&json!({"state":"waiting_permission","startedAt":1000,"lastActivityAt":1800})), true, 1000, now), Gate::Refused(_)));
        assert_eq!(gate_of(Some(&ok), false, 1000, now), Gate::Ready);
    }

    #[test]
    fn stale_state_file_is_not_booted() {
        // claude --resume で立て直すと、前の起動の state/<id>.json が残っている。それを起動済みの印にしない
        let dir = std::env::temp_dir().join(format!("ct-hooked-{}-{}", std::process::id(), fastrand::u64(..)));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("state.json");
        assert!(!hooked_since(&f, 0));
        fs::write(&f, "{}").unwrap();
        let mtime = fs::metadata(&f).unwrap().modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
        assert!(hooked_since(&f, mtime.saturating_sub(5_000)), "起動の後に書かれた");
        assert!(!hooked_since(&f, mtime + 60_000), "起動の前に書かれた");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod bench {
    /// 手元の ~/.claude/history.jsonl で、prompt_history の時間と返す大きさを測る。`cargo test --lib history_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn history_cost() {
        let t = std::time::Instant::now();
        let cwd = || Some("/Users/konaito/Documents/family-computing".to_string());
        let h = super::prompt_history(cwd(), false).unwrap();
        let first = t.elapsed();
        let t = std::time::Instant::now();
        let h2 = super::prompt_history(cwd(), false).unwrap();
        let second = t.elapsed();
        let t = std::time::Instant::now();
        let a = super::prompt_history(cwd(), true).unwrap();
        let third = t.elapsed();
        let size = |x: &super::History| serde_json::to_string(x).unwrap().len();
        println!("project: 1回目 {first:?}、2回目 {second:?}、{} 件、JSON {} バイト／all: {third:?}、{} 件、JSON {} バイト", h.project.len(), size(&h2), a.all.len(), size(&a));
    }
}
