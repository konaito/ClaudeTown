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
/// 承認待ちのときに Enter を送ると、許可を押したことになるので、送る前に状態を見る（deliver）
pub fn send_direct(session_id: String, text: String) -> Result<(), String> {
    super::refuse_if_disabled()?;
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    match deliver(&session_id, &text)? {
        Gate::Ready => Ok(()),
        Gate::Booting => Err(NOT_BOOTED.into()),
        Gate::Refused(e) => Err(e),
    }
}

const NOT_BOOTED: &str = "claude がまだ起動していない（信頼の確認の画面かもしれない）。ターミナルで確かめてから送って";
const WAITING: &str = "承認待ちなので送らなかった。先にターミナルで承認に答えて";

/// 端末の錠（pty::serial）の中で、送ってよいかを見てから貼り、Enter を押す（#168）。Ready を返したら送った。
/// Booting と Refused は何も書かずに返す。状態は錠を取った後に読む（錠を待つ間に、モデルの切り替えや承認への答えで変わる）
fn deliver(session_id: &str, text: &str) -> Result<Gate, String> {
    super::pty::serial(session_id, || {
        let g = gate(session_id)?;
        if g != Gate::Ready {
            return Ok(g);
        }
        if let Some(why) = blocked_now(session_id) {
            return Ok(Gate::Refused(format!("{why}ので送らなかった。先にターミナルで答えて")));
        }
        paste_enter(session_id, text)?;
        Ok(Gate::Ready)
    })
}

/// 錠の中で呼ぶ（deliver）。貼った後、Enter の前に状態を読み直す。貼り付けと Enter の間に承認の画面が出ると、Enter でカーソルの行（Yes）が選ばれる
fn paste_enter(session_id: &str, text: &str) -> Result<(), String> {
    super::pty::write(session_id, &format!("\x1b[200~{}\x1b[201~", paste_body(text)))?;
    // 貼り付けと Enter の間を空ける。続けて書くと、貼り付けの最後と Enter が1つの入力として読まれ、改行になることがある
    std::thread::sleep(Duration::from_millis(150));
    if let Some(why) = blocked_now(session_id) {
        return Err(format!("貼った直後に{why}ので、Enter を送らなかった。ターミナルの入力欄に文が残っているかもしれない"));
    }
    super::pty::write(session_id, "\r")
}

/// 今の sessions/<pid>.json と画面で、Enter を書いてはいけないかを見る（enter_blocked）
pub(crate) fn blocked_now(session_id: &str) -> Option<String> {
    let row = super::pty::pid_of_id(session_id).and_then(|pid| super::native::sessions::fresh_row(&super::native::claude_home(), pid));
    let screen = super::pty::screen_text(session_id).unwrap_or_default();
    enter_blocked(row.as_ref(), &screen)
}

/// 端末にキーを書いてはいけない状態か。承認待ち（row の state）、承認の画面、/model のピッカーのどれかなら、理由を返す（#168）。
/// 道具の承認とピッカーは、選択の行のカーソルが入力欄より下にあるときだけ数える（画面に残った前の入力の「❯ 1. a」で断らない）
pub fn enter_blocked(row: Option<&Value>, screen: &str) -> Option<String> {
    use super::dialog::{menu_below_input, parse, Dialog};
    if row.is_some_and(|r| r.get("state").and_then(|s| s.as_str()) == Some("waiting_permission")) {
        return Some("承認待ちになった".into());
    }
    // ピッカーも parse では Choice に読めるので、先に見る（理由の文を合わせるため）
    if screen.contains(super::switch::PICKER) && super::switch::picker_cursor(screen).is_some() && menu_below_input(screen) {
        return Some("モデルのピッカーが開いている".into());
    }
    match parse(screen) {
        Some(Dialog::Ask { .. } | Dialog::Review { .. }) => Some("質問の画面が出ている".into()),
        Some(Dialog::Choice { .. }) if menu_below_input(screen) => Some("承認の画面が出ている".into()),
        _ => None,
    }
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
    let now = super::now_ms() as u64;
    let seen = if marked(row.as_ref(), hooked) { first_seen(session_id, started, now) } else { None };
    Ok(gate_of(row.as_ref(), hooked, started, seen, now))
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
pub fn gate_of(row: Option<&Value>, hooked: bool, started_at: u64, first_seen: Option<u64>, now_ms: u64) -> Gate {
    if let Some(r) = row
        && r.get("state").and_then(|s| s.as_str()) == Some("waiting_permission") {
            return Gate::Refused(WAITING.into());
        }
    // claude が起動し、信頼の確認を抜けたか。信頼の確認の画面で Enter を送ると、既定の「No, exit」が選ばれて claude が終わる
    // （2026-11-13 に画面で見た）。SessionStart の hook が届くと state/<id>.json が書かれ、sessions/<pid>.json の updatedAt が startedAt より進む。
    // どちらかがあれば起動したとみる。入力の受け付けは SessionStart の 0.3〜1.4 秒後なので、起動からも、印を初めて見てからも3秒は待つ。
    // 信頼の確認の画面で止まってから答えると、印は起動から何十秒も後に出るので、起動からだけ数えると早すぎる。
    // first_seen は印を初めて見た時刻（None は、今が初めて）
    if !marked(row, hooked) {
        return Gate::Booting;
    }
    let from = started_at.max(first_seen.unwrap_or(now_ms));
    if now_ms.saturating_sub(from) < 3000 {
        return Gate::Booting;
    }
    Gate::Ready
}

/// 起動の印があるか（hook の状態ファイルがこの起動の後に書かれたか、sessions/<pid>.json の updatedAt が startedAt より進んだか）
fn marked(row: Option<&Value>, hooked: bool) -> bool {
    hooked || row.map(|r| r["lastActivityAt"].as_u64().unwrap_or(0) > r["startedAt"].as_u64().unwrap_or(u64::MAX)).unwrap_or(false)
}

/// 起動の印を初めて見た時刻。セッションごとに、どの起動（started_at）で見たかと一緒に覚える
static FIRST_SEEN: Mutex<Option<HashMap<String, (u64, u64)>>> = Mutex::new(None);

fn first_seen(session_id: &str, started_at: u64, now_ms: u64) -> Option<u64> {
    let mut g = FIRST_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    match m.get(session_id) {
        Some(&(s, at)) if s == started_at => Some(at),
        _ => {
            m.insert(session_id.to_string(), (started_at, now_ms));
            None
        }
    }
}

/// gate_of を文で返す形（switch.rs が使う。印を見た時刻は覚えず、起動から3秒で数える今までの形）
pub fn check_direct(row: Option<&Value>, hooked: bool, started_at: u64, now_ms: u64) -> Result<(), String> {
    match gate_of(row, hooked, started_at, Some(started_at), now_ms) {
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
    match deliver(&session_id, &text)? {
        Gate::Ready => Ok(serde_json::json!({ "queued": false })),
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
            let r = if super::send_disabled() { Err("送信を止めている（~/.family-computing/send-disabled がある）".to_string()) } else { deliver(&id, &item.text) };
            eprintln!("[boot] {id} 預かった文を送った: {r:?}");
            waits(|w| {
                w.sending.remove(&id);
                match r {
                    Ok(Gate::Ready) => finish(w, &id, item, None),
                    // 錠を待つ間に承認待ちになった、または画面に承認かピッカーが出た。何も書いていないので、先頭に戻して待つ
                    Ok(_) => w.queue.entry(id.clone()).or_default().insert(0, item),
                    Err(e) => finish(w, &id, item, Some(e)),
                }
            });
            // 続けて送る文は、前の文が入力として読まれてから送る
            std::thread::sleep(Duration::from_millis(500));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// 受信ソケットに書く1行。ccn の terminal-driver.ts と同じ形（#156）
pub fn socket_line(text: &str) -> String {
    serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } }).to_string() + "\n"
}

/// 受信ソケットで送れない文か。/ のコマンドと ! のシェルは、CLI のコマンドとして動かず、ただの文として届く
/// （2026-11-22 に 2.1.330 で /model を送って確かめた）
pub fn socket_refusal(text: &str) -> Option<&'static str> {
    let t = text.trim_start();
    let slash = t.strip_prefix('/').map(|r| r.split(char::is_whitespace).next().unwrap_or("")).is_some_and(|w| !w.contains('/'));
    if slash {
        Some("このセッションには / のコマンドを送れない（Claude Town の外で起動したので、文としてしか届かない）。起動した端末で打って")
    } else if t.starts_with('!') {
        Some("このセッションには ! のシェルを送れない（Claude Town の外で起動したので、文としてしか届かない）。起動した端末で打って")
    } else {
        None
    }
}

/// Claude Town の外で起動した対話セッションへ、受信ソケット（cross-session messaging）で文を送る（#156）。
/// 届いた文は、相手には「別の Claude のセッションからの文」として入る（jsonl では origin が peer の user 行）。
/// 承認待ちでも送ってよい。他のセッションからの文は承認の答えにならない（公式の文書）
pub fn send_socket(session_id: String, text: String) -> Result<(), String> {
    use std::io::Write;
    super::refuse_if_disabled()?;
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    if let Some(why) = socket_refusal(&text) {
        return Err(why.into());
    }
    let path = super::native::sessions::live_socket_of(&super::native::claude_home(), &session_id).ok_or(super::native::READ_ONLY)?;
    let mut c = std::os::unix::net::UnixStream::connect(&path).map_err(|e| format!("受信ソケットにつなげなかった（{}）: {e}", path.display()))?;
    c.set_write_timeout(Some(Duration::from_secs(5))).ok();
    c.write_all(socket_line(&text).as_bytes()).map_err(|e| format!("受信ソケットに書けなかった: {e}"))
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
    /// このアプリが立てたセッションは端末の入力欄へ貼る。外で起動したものは受信ソケットで送る（#156）
    #[tauri::command]
    pub async fn send_direct(session_id: String, text: String) -> Result<(), String> {
        if crate::app_guard(&session_id).is_ok() {
            crate::blocking(move || super::send_direct(session_id, text)).await
        } else {
            crate::blocking(move || super::send_socket(session_id, text)).await
        }
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
    fn sends_to_native_session_over_socket() {
        use crate::native::testtree::*;
        use std::io::Read;
        let root = tmp("sock");
        let sid = "cccccccc-0000-4000-8000-00000000000c";
        let pid = std::process::id();
        // macOS の unix ソケットのパスは 104 バイトまでなので、temp_dir ではなく /tmp に置く
        let sock = PathBuf::from(format!("/tmp/fc-sock-{pid}-{}.sock", fastrand::u32(..)));
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let row = |socket: &Path| json!({ "pid": pid, "sessionId": sid, "cwd": "/tmp/合成/s", "startedAt": 1_000u64, "kind": "interactive",
            "status": "busy", "updatedAt": 2_000u64, "messagingSocketPath": socket });
        write(&root.join(format!("sessions/{pid}.json")), &row(&sock).to_string());
        crate::native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root.clone()));
        // 一覧では送れる（ほかの操作はできない）
        let mut st = crate::native::Stats::default();
        let s = crate::native::sessions::live(&root, &mut st).into_iter().find(|s| s.id == sid).unwrap().to_row();
        assert_eq!(s["capabilities"]["send"], true);
        assert_eq!(s["capabilities"]["interrupt"], false);
        assert_eq!(s["capabilities"]["terminal"], false);
        // 送った文は1行の JSON でソケットに届く
        let got = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut b = String::new();
            c.read_to_string(&mut b).unwrap();
            b
        });
        send_socket(sid.into(), "見て\n2行目".into()).unwrap();
        let line = got.join().unwrap();
        assert_eq!(line, socket_line("見て\n2行目"));
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v, json!({ "type": "user", "message": { "role": "user", "content": "見て\n2行目" } }));
        // コマンドとシェルは、文としてしか届かないので送らない。パスで始まる文は送る
        assert!(send_socket(sid.into(), "/model".into()).unwrap_err().contains("/ のコマンド"));
        assert!(send_socket(sid.into(), "!ls".into()).unwrap_err().contains("! のシェル"));
        assert!(socket_refusal("/Users/x/a.png を見て").is_none());
        // ソケットが無くなったら、一覧でも送れず、送っても断る
        fs::remove_file(&sock).unwrap();
        let s = crate::native::sessions::live(&root, &mut st).into_iter().find(|s| s.id == sid).unwrap().to_row();
        assert_eq!(s["capabilities"]["send"], false);
        assert!(send_socket(sid.into(), "やあ".into()).is_err());
        crate::native::TEST_HOME.with(|h| *h.borrow_mut() = None);
    }

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
        assert_eq!(gate_of(None, false, 1000, None, now), Gate::Booting);
        assert_eq!(gate_of(Some(&ok), true, 1000, Some(1000), 2000), Gate::Booting);
        assert!(matches!(gate_of(Some(&json!({"state":"waiting_permission","startedAt":1000,"lastActivityAt":1800})), true, 1000, Some(1000), now), Gate::Refused(_)));
        assert_eq!(gate_of(Some(&ok), false, 1000, Some(1800), now), Gate::Ready);
        // 信頼の確認の画面で長く止まってから答えると、起動の印は起動から何十秒も後に出る。印を初めて見てから3秒は待つ
        assert_eq!(gate_of(Some(&ok), false, 1000, Some(60_000), 60_000), Gate::Booting);
        assert_eq!(gate_of(Some(&ok), false, 1000, Some(60_000), 62_000), Gate::Booting);
        assert_eq!(gate_of(Some(&ok), false, 1000, Some(60_000), 63_000), Gate::Ready);
        // 印をまだ覚えていない（初めて見た回）は、今が初めて見た時刻
        assert_eq!(gate_of(Some(&ok), false, 1000, None, 60_000), Gate::Booting);
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

/// 端末へ分けて書く送信（貼り付けと Enter）が、承認の画面とモデルのピッカーに割り込まれないか（#168）。
/// 代役の claude（FC_CLAUDE_BIN）を本物の PTY で立て、代役が受けたキーを、そのとき出していた画面の種類と一緒に記録させて確かめる
#[cfg(test)]
mod interleave {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::MutexGuard;
    use std::time::{Duration, Instant};

    /// 代役の claude。入力を raw で読み、貼り付けの終わりと Enter を「paste:<画面>:<入力欄の文>」「enter:<画面>:<文>」の形で events に書く。
    /// 画面は input（入力欄）、dialog（道具の承認）、picker（/model のピッカー）のどれか。
    /// __ON_PASTE__ が dialog なら最初の貼り付けの直後に承認の画面を出す（sessions/<pid>.json は idle のまま、画面だけが先に変わる場合）。
    /// dialog-waiting なら、あわせて sessions/<pid>.json を waiting にする。/model と Enter でピッカーを出し、矢印は無視し、Esc で閉じる
    const STAND_IN: &str = r#"#!/usr/bin/env python3
import json, os, time, tty
D = "__DIR__"; ROOT = "__ROOT__"; ON_PASTE = "__ON_PASTE__"
tty.setraw(0)
RULE = "─" * 60
INPUT = RULE + "\n❯ \n" + RULE + "\n  ⏸ manual mode on · ? for shortcuts"
DIALOG = ("⏺ Bash(echo probe-ok > probe2.txt)\n  ⎿  Waiting…\n" + RULE + "\n Bash command\n echo probe-ok > probe2.txt\n"
          " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access\n   3. No\n Esc to cancel · Tab to amend")
PICKER = ("❯ /model\n  Select model\n    1.  Default (recommended)\n    2.  Opus 5.5\n  ❯ 3.  Sonnet 5.5\n    4.  Haiku 5.5\n"
          " Enter to confirm · Esc to exit")
pid = os.getpid()
started = int(time.time() * 1000)
def row(status):
    p = f"{ROOT}/sessions/{pid}.json"
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "w") as f:
        json.dump({"pid": pid, "sessionId": "stand-in", "cwd": D, "startedAt": started, "updatedAt": started + 1, "kind": "interactive", "status": status}, f)
    os.replace(p + ".tmp", p)
def show(s):
    os.write(1, ("\x1b[2J\x1b[H" + s.replace("\n", "\r\n")).encode())
def event(e):
    with open(f"{D}/events", "a") as f:
        f.write(e + "\n")
mode = "input"; text = ""; pasting = False; popped = False
show(INPUT); row("idle")
buf = b""
while True:
    b = os.read(0, 4096)
    if not b:
        break
    buf += b
    while buf:
        if buf.startswith(b"\x1b[200~"):
            pasting = True; buf = buf[6:]
        elif buf.startswith(b"\x1b[201~"):
            pasting = False; buf = buf[6:]
            event(f"paste:{mode}:{text}")
            if mode == "input" and not popped and ON_PASTE.startswith("dialog"):
                popped = True; mode = "dialog"; show(DIALOG)
                if ON_PASTE == "dialog-waiting":
                    row("waiting")
        elif buf.startswith(b"\x1b[2") and len(buf) < 6:
            break
        elif buf.startswith(b"\x1b[") and len(buf) >= 3:
            buf = buf[3:]
        elif buf == b"\x1b[":
            break
        elif buf.startswith(b"\x1b"):
            buf = buf[1:]
            if mode == "picker":
                mode = "input"; show(INPUT)
        elif pasting:
            i = buf.find(b"\x1b")
            i = len(buf) if i < 0 else i
            text += buf[:i].decode("utf-8", "replace"); buf = buf[i:]
        elif buf.startswith(b"\r"):
            buf = buf[1:]
            event(f"enter:{mode}:{text}")
            if mode == "input" and text.strip() == "/model":
                mode = "picker"; show(PICKER)
            text = ""
        else:
            if mode == "input":
                text += chr(buf[0])
            buf = buf[1:]
"#;

    struct Stand {
        id: String,
        dir: PathBuf,
        root: PathBuf,
        // 代役を立てている間は FC_CLAUDE_BIN と台帳をほかの試験と分ける（pty.rs の試験と同じ錠）
        _bin: MutexGuard<'static, ()>,
        // 代役の端末は町の一覧（pty::list）に出るので、一覧の数を数える試験（lib.rs）と重ならないようにする
        _native: MutexGuard<'static, ()>,
    }

    impl Stand {
        fn events(&self) -> String {
            fs::read_to_string(self.dir.join("events")).unwrap_or_default()
        }
        fn screen(&self) -> String {
            crate::pty::screen_text(&self.id).unwrap_or_default()
        }
    }

    impl Drop for Stand {
        fn drop(&mut self) {
            let _ = crate::pty::kill(&self.id);
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(3) && crate::pty::owns(&self.id) {
                std::thread::sleep(Duration::from_millis(50));
            }
            crate::native::TEST_HOME.with(|h| *h.borrow_mut() = None);
        }
    }

    fn until(sec: u64, what: &str, f: impl Fn() -> bool) {
        let t0 = Instant::now();
        while !f() {
            assert!(t0.elapsed() < Duration::from_secs(sec), "{what} が {sec} 秒で来なかった");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 代役を立て、送ってよい状態（gate が Ready）になるまで待つ。TEST_HOME はこのスレッドだけに効く
    fn stand_in(on_paste: &str) -> Stand {
        use std::os::unix::fs::PermissionsExt;
        let guard = crate::pty::BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let native = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-168-{}-{}", std::process::id(), fastrand::u64(..)));
        fs::create_dir_all(dir.join("home/sessions")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let root = dir.join("home");
        let bin = dir.join("claude");
        let script = STAND_IN.replace("__DIR__", &dir.to_string_lossy()).replace("__ROOT__", &root.to_string_lossy()).replace("__ON_PASTE__", on_paste);
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = crate::pty::spawn(dir.to_str().unwrap(), None, &[], 140, 40, || {});
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r.unwrap()["id"].as_str().unwrap().to_string();
        crate::native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root.clone()));
        let s = Stand { id, dir, root, _bin: guard, _native: native };
        until(10, "代役の入力欄", || s.screen().contains("manual mode on"));
        // 起動の印を見てから3秒は Booting（gate_of）。Booting で断っただけの試験にしないため、Ready まで待つ
        until(8, "gate の Ready", || super::booted(&s.id) == Some(true));
        s
    }

    /// 対照: 何も出ていなければ、貼り付けも Enter も入力欄に届く
    #[test]
    fn enter_reaches_the_input_when_nothing_pops_up() {
        let s = stand_in("none");
        super::send_direct(s.id.clone(), "hello".into()).unwrap();
        until(3, "入力欄への Enter", || s.events().contains("enter:input:hello"));
        assert_eq!(s.events(), "paste:input:hello\nenter:input:hello\n");
    }

    /// 貼った直後に承認の画面が出たら、Enter を書かない（書くとカーソルの行の Yes が選ばれる）。
    /// 画面だけが先に変わる場合と、sessions/<pid>.json も waiting になる場合
    #[test]
    fn enter_is_held_when_an_approval_pops_up_after_the_paste() {
        let mut bad = vec![];
        for on_paste in ["dialog", "dialog-waiting"] {
            let s = stand_in(on_paste);
            let r = super::send_direct(s.id.clone(), "hello".into());
            std::thread::sleep(Duration::from_millis(600));
            let ev = s.events();
            assert!(ev.contains("paste:input:hello"), "{on_paste}: 貼り付けが届いていない（競り合いを作れていない）: {ev:?}");
            if ev.contains("enter:dialog") || r.is_ok() {
                bad.push(format!("{on_paste}: 承認の画面に Enter が届いたか、成功を返した: {ev:?} {r:?}"));
            }
        }
        assert!(bad.is_empty(), "{bad:#?}");
    }

    /// モデルを替えている間（/model のピッカーが開いている間）に送った文は、ピッカーに入らず、閉じた後に入力欄へ届く
    #[test]
    fn send_waits_while_the_model_picker_is_open() {
        let s = stand_in("none");
        let (id, root) = (s.id.clone(), s.root.clone());
        let t = std::thread::spawn(move || {
            crate::native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root));
            // 代役のピッカーは矢印で動かないので、Opus の行は見つからず、約1.6秒後に Esc で閉じる
            crate::switch::set_model(&id, "opus")
        });
        until(5, "ピッカー", || s.screen().contains("Select model"));
        let r = super::send_direct(s.id.clone(), "hello".into());
        let m = t.join().unwrap();
        until(3, "入力欄への Enter", || s.events().contains("enter:input:hello") || s.events().contains("enter:picker"));
        let ev = s.events();
        assert!(!ev.contains("paste:picker") && !ev.contains("enter:picker"), "ピッカーに文か Enter が届いた: {ev:?}");
        assert!(ev.contains("enter:input:hello"), "{ev:?}");
        assert!(r.is_ok(), "{r:?}");
        assert!(m.is_err(), "代役のピッカーに Opus の行は無い: {m:?}");
    }
}
