// チャットの入力欄（src/composer/）が、Claude Code の CLI の入力と同じ動きをするための命令。
// 仕様の出所と実測は docs/research/cli-input.md にある。
// - prompt_history(cwd): CLI の入力履歴（~/.claude/history.jsonl）。上下キーは同じ project の分、Ctrl+R は全部
// - slash_commands(cwd): / の候補にするスキルとコマンド（ユーザー、プロジェクト、有効なプラグイン）。組み込みのコマンドは画面が持つ
// - file_suggestions(cwd, query): @ の候補にするファイルとフォルダ
// - send_direct(session_id, text, peer): PTY のセッションの入力欄へ直接貼って Enter を押す。先頭が / か ! の文に使う
// - interrupt_session(session_id, peer): ccn の interrupt の口（Esc と Ctrl+C）
//
// 手元のファイルを読む命令（履歴、スキル、ファイル）は、この機械のセッションにだけ使う。別の機械の分は ccn の口が無いので返さない。

use serde::Serialize;
use serde_json::{json, Value};
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

const HISTORY_ALL_MAX: usize = 3000;
const HISTORY_PROJECT_MAX: usize = 1000;

/// ccn が本文の前に付ける1行（from <誰> via <ノード>）を外す。人が打ったのは、その後ろの文だから
pub fn strip_from_line(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("from ") {
        if let Some(nl) = rest.find('\n') {
            let w: Vec<&str> = rest[..nl].split(' ').collect();
            if w.len() == 3 && w[1] == "via" && !w[0].is_empty() && !w[2].is_empty() {
                return rest[nl..].trim_start_matches('\n');
            }
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
        if let Some(start) = out.find(&tag) {
            if let Some(end) = out[start..].find(']') {
                out.replace_range(start..start + end + 1, &body);
            }
        }
    }
    out
}

/// history.jsonl の行を新しい順に並べ、同じ文が続いたものは1つにする
pub fn history_from(lines: &str, cwd: Option<&str>, home: &Path) -> History {
    let mut all = Vec::new();
    let mut project = Vec::new();
    let mut seen_all: HashSet<String> = HashSet::new();
    let mut seen_project: HashSet<String> = HashSet::new();
    for line in lines.lines().rev() {
        if all.len() >= HISTORY_ALL_MAX && (cwd.is_none() || project.len() >= HISTORY_PROJECT_MAX) {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(display) = v.get("display").and_then(|d| d.as_str()) else { continue };
        let text = strip_from_line(&expand_pastes(display, v.get("pastedContents"), home)).to_string();
        if text.trim().is_empty() {
            continue;
        }
        if all.len() < HISTORY_ALL_MAX && seen_all.insert(text.clone()) {
            all.push(text.clone());
        }
        if let Some(c) = cwd {
            if v.get("project").and_then(|p| p.as_str()) == Some(c) && project.len() < HISTORY_PROJECT_MAX && seen_project.insert(text.clone()) {
                project.push(text);
            }
        }
    }
    History { project, all }
}

/// history.jsonl は 7MB ほどあるので、変わっていなければ前に読んだ中身を使う
static HISTORY_CACHE: Mutex<Option<(SystemTime, u64, String)>> = Mutex::new(None);

pub fn prompt_history(cwd: Option<String>) -> Result<History, String> {
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
    Ok(history_from(s, cwd.as_deref(), &home))
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
static FILES_CACHE: Mutex<Option<HashMap<String, (Instant, Vec<String>)>>> = Mutex::new(None);
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

/// 先頭が / か ! の文を、PTY のセッションの入力欄へ直接貼り、Enter を押す。
/// ccn の send_message は本文の前に from の1行を付けるので、/ と ! が CLI のコマンドとして動かない（2026-11-13 に実測）。
/// 端末の口は ccn の send が持つ検査（承認待ちの拒否）を通らないので、ここで先に見る。承認待ちのときに Enter を送ると、許可を押したことになる
pub fn send_direct(session_id: String, text: String, peer: Option<String>) -> Result<(), String> {
    if super::send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    let base = super::api(&peer);
    let d = super::get_json(&format!("{base}/sessions/{session_id}"))?;
    check_direct(&d)?;
    let url = format!("{base}/sessions/{session_id}/terminal/input");
    let post = |t: &str| {
        super::agent()
            .post(&url)
            .timeout(Duration::from_secs(5))
            .send_json(json!({ "text": t }))
            .map(|_| ())
            .map_err(|e| format!("ターミナルに書けなかった: {e}"))
    };
    post(&format!("\x1b[200~{}\x1b[201~", paste_body(&text)))?;
    // ccn の PTY の send と同じく、貼り付けと Enter の間を空ける（pasteDelayMs の既定 150ms）
    std::thread::sleep(Duration::from_millis(150));
    post("\r")
}

/// 直接送ってよい状態か。PTY で、claude が動いていて、承認や質問を待っていないこと
pub fn check_direct(d: &Value) -> Result<(), String> {
    if d.pointer("/capabilities/terminal").and_then(|v| v.as_bool()) != Some(true) {
        return Err("このセッションには端末が無いので、/ と ! のコマンドを直接は送れない".into());
    }
    match d.get("state").and_then(|s| s.as_str()) {
        Some("exited") => return Err("セッションが終わっている".into()),
        Some("waiting_permission") => return Err("承認待ちなので送らなかった。先に承認に答えて".into()),
        _ => {}
    }
    if d.get("pending").and_then(|p| p.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
        return Err("承認待ちなので送らなかった。先に承認に答えて".into());
    }
    Ok(())
}

pub fn interrupt_session(session_id: String, peer: Option<String>) -> Result<(), String> {
    if super::send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    super::agent()
        .post(&format!("{}/sessions/{session_id}/interrupt", super::api(&peer)))
        .send_json(json!({}))
        .map(|_| ())
        .map_err(|e| format!("止められなかった: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let h = history_from(&lines, Some("/p"), home);
        assert_eq!(h.project, vec!["a", "c"]);
        assert_eq!(h.all, vec!["a", "c", "b"]);
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
        let ok = json!({"capabilities":{"terminal":true},"state":"idle","pending":[]});
        assert!(check_direct(&ok).is_ok());
        assert!(check_direct(&json!({"capabilities":{"terminal":true},"state":"running","pending":[{"requestId":"r"}]})).is_err());
        assert!(check_direct(&json!({"capabilities":{"terminal":true},"state":"waiting_permission","pending":[]})).is_err());
        assert!(check_direct(&json!({"capabilities":{"terminal":false},"state":"idle"})).is_err());
        assert_eq!(paste_body("a\x1b[201~b"), "ab");
    }
}
