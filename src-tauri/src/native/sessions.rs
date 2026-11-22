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
            "capabilities": super::read_only_caps(),
            "title": self.title,
            "native": { "jsonl": self.jsonl, "kind": self.kind },
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

/// id の会話の jsonl を projects/*/ から探す。無ければ None（resume すると exit 1 で終わるので、立て直す前に見る）
pub fn find_jsonl(root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    fs::read_dir(root.join("projects")).ok()?.flatten().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

/// id を名乗っている、生きているプロセスの pid（sessions/<pid>.json を今読む）。無ければ None
pub fn live_pid_of(root: &Path, id: &str) -> Option<u32> {
    fs::read_dir(root.join("sessions")).ok()?.flatten().find_map(|e| {
        let v: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
        let pid = v["pid"].as_u64()? as u32;
        (v["sessionId"].as_str() == Some(id) && pid_alive(pid)).then_some(pid)
    })
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
            if !pid_alive(pid as u32) {
                continue;
            }
            raw.push((pid as u32, id.to_string(), cwd.to_string(), v));
        }
    }
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
}
