// agent team のチームメイトのうち、tmux で動くもの（teammateMode が tmux）を、リードの子として出す。
// in-process のチームメイトはリードの subagents/ の下に記録されるので、subagents.rs が拾う。
//
// 実物（docs/research/agent-teams-observed.md、2026-11-21 に tmux の回を2回取った）:
// - tmux のチームメイトは別のプロセスで、~/.claude/sessions/<pid>.json を作らない。だから sessions.rs の一覧に入らない。
// - 起動の引数に `--agent-id <名前>@<チーム名>`、`--agent-name`、`--team-name`、`--parent-session-id <リードの sid>` がある。
//   `--agent-type` は1回目にだけあった。ここでは使わない。
// - 会話は projects/<cwd の名前>/<自分の sid>.jsonl。user、assistant、attachment、system の行に teamName と agentName がある。
// - ~/.claude/teams/<チーム名>/config.json の members に backendType: tmux と cwd がある。pid と session id は無い。
// - 終わったセッションのチームは消えずに残る（61件のうち58件はリードが死んでいた）。
//
// 決め方:
// 1. config.json のうち、leadSessionId が生きているセッションの一覧にあり、leadProcess.pid がそのセッションの pid と同じものだけを見る
//    （pid の使い回しで死んだチームを拾わない）。
// 2. members の backendType が tmux のものについて、ps で `--agent-id <agentId>` と `--parent-session-id <リードの sid>` の両方を持つ
//    claude のプロセスを探す。無ければもう終わったとみなして出さない。
// 3. 会話の jsonl は、member の cwd のプロジェクトの下で、joinedAt 以降に書かれたもののうち、teamName と agentName が合うもの。
// 知らない backendType と、jsonl の読めない config.json は Stats::odd に数える。

use super::sessions::{project_dir_name, Session};
use super::{mtime_ms, Stats};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// jsonl の頭から、teamName と agentName を探す長さ
const HEAD_BYTES: u64 = 256 * 1024;

/// config.json の中身を、更新時刻と大きさが変わったときだけ読み直す
static CONFIGS: Mutex<Option<HashMap<PathBuf, ((u64, u64), Option<Value>)>>> = Mutex::new(None);
/// (agentId, pid) ごとに見つけた jsonl
static FOUND: Mutex<Option<HashMap<(String, u32), PathBuf>>> = Mutex::new(None);

fn read_config(p: &Path, stats: &mut Stats) -> Option<Value> {
    let m = fs::metadata(p).ok()?;
    let st = (m.len(), mtime_ms(&m));
    let mut g = CONFIGS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if let Some((s, v)) = map.get(p) {
        if *s == st {
            return v.clone();
        }
    }
    let v = fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    if v.is_none() {
        stats.odd("teams: 読めない config.json");
    }
    map.insert(p.to_path_buf(), (st, v.clone()));
    v
}

/// 生きているチームの、tmux のチームメイト（リードのセッション、チーム名、member）
pub struct Member {
    pub lead: String,
    pub team: String,
    pub agent_id: String,
    pub name: String,
    pub cwd: String,
    pub joined_at: u64,
}

pub fn members(root: &Path, live: &[Session], stats: &mut Stats) -> Vec<Member> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(root.join("teams")) else { return out };
    let lead_pid: HashMap<&str, u32> = live.iter().map(|s| (s.id.as_str(), s.pid)).collect();
    for e in rd.flatten() {
        let cfg = e.path().join("config.json");
        if !cfg.exists() {
            continue;
        }
        let Some(v) = read_config(&cfg, stats) else { continue };
        let Some(lead) = v["leadSessionId"].as_str() else {
            stats.odd("teams: leadSessionId が無い");
            continue;
        };
        // 死んだチーム（リードがいない、pid が別のプロセスに使い回された）は見ない。
        // leadProcess の無い古いチームもある（2026-11-21 に12件）。両方が無いのを「同じ」と見ないよう、両方あるときだけ比べる
        let (Some(live_pid), Some(cfg_pid)) = (lead_pid.get(lead).copied(), v["leadProcess"]["pid"].as_u64()) else { continue };
        if live_pid != cfg_pid as u32 {
            continue;
        }
        let team = v["name"].as_str().unwrap_or_default().to_string();
        for m in v["members"].as_array().into_iter().flatten() {
            match m["backendType"].as_str() {
                Some("in-process") => continue,
                Some("tmux") => {}
                other => {
                    stats.odd(format!("teams: 知らない backendType {other:?}"));
                    continue;
                }
            }
            let (Some(agent_id), Some(name)) = (m["agentId"].as_str(), m["name"].as_str()) else {
                stats.odd("teams: member に agentId か name が無い");
                continue;
            };
            out.push(Member {
                lead: lead.to_string(),
                team: team.clone(),
                agent_id: agent_id.to_string(),
                name: name.to_string(),
                cwd: m["cwd"].as_str().unwrap_or_default().to_string(),
                joined_at: m["joinedAt"].as_u64().unwrap_or(0),
            });
        }
    }
    out
}

/// ps の1行から、チームメイトの印（--agent-id と --parent-session-id）を読む
pub fn teammate_args(command: &str) -> Option<(String, String)> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let after = |flag: &str| words.iter().position(|w| *w == flag).and_then(|i| words.get(i + 1)).map(|s| s.to_string());
    Some((after("--agent-id")?, after("--parent-session-id")?))
}

/// 動いているチームメイトのプロセス。(agentId, 親の sid) → pid
fn processes() -> HashMap<(String, String), u32> {
    let Ok(out) = std::process::Command::new("/bin/ps").args(["-axo", "pid=,command="]).output() else { return HashMap::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains("--parent-session-id"))
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, rest) = l.split_once(' ')?;
            Some((teammate_args(rest)?, pid.parse().ok()?))
        })
        .collect()
}

/// jsonl の頭に、このチームメイトの印（teamName と agentName）があるか
fn is_theirs(p: &Path, team: &str, name: &str) -> bool {
    let Ok(f) = fs::File::open(p) else { return false };
    for line in BufReader::new(f.take(HEAD_BYTES)).lines() {
        let Ok(line) = line else { break };
        if !line.contains("\"teamName\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["teamName"].as_str() == Some(team) {
            return v["agentName"].as_str() == Some(name);
        }
    }
    false
}

fn find_jsonl(root: &Path, m: &Member, pid: u32) -> Option<PathBuf> {
    let key = (m.agent_id.clone(), pid);
    if let Some(p) = FOUND.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|f| f.get(&key)) {
        if p.exists() {
            return Some(p.clone());
        }
    }
    let dir = root.join("projects").join(project_dir_name(&m.cwd));
    let mut cands: Vec<(u64, PathBuf)> = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let t = mtime_ms(&e.metadata().ok()?);
            // 加わる前から書かれていないファイルは見ない（時計のずれに5秒あける）
            (t + 5_000 >= m.joined_at).then_some((t, p))
        })
        .collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0));
    let hit = cands.into_iter().map(|(_, p)| p).find(|p| is_theirs(p, &m.team, &m.name))?;
    FOUND.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(key, hit.clone());
    Some(hit)
}

/// tmux のチームメイトの行。形は sessions.rs の to_row と同じで、親は native.parentId に入れる
pub fn tmux_rows(root: &Path, live: &[Session], now: u64, stats: &mut Stats) -> Vec<Value> {
    let ms = members(root, live, stats);
    if ms.is_empty() {
        return vec![];
    }
    let procs = processes();
    let mut out = vec![];
    for m in &ms {
        let Some(&pid) = procs.get(&(m.agent_id.clone(), m.lead.clone())) else {
            stats.team_gone += 1;
            continue;
        };
        let jsonl = find_jsonl(root, m, pid);
        if jsonl.is_none() {
            stats.team_no_jsonl += 1;
        }
        // jsonl の名前が自分の session id。まだ書かれていなければ仮の id にする（hook の状態ファイルとは合わない）
        let id = jsonl.as_ref().and_then(|p| p.file_stem()).and_then(|s| s.to_str()).map(String::from).unwrap_or_else(|| format!("tm-{}", m.agent_id));
        let mtime = jsonl.as_ref().and_then(|p| fs::metadata(p).ok()).map(|x| mtime_ms(&x)).unwrap_or(m.joined_at);
        let running = now.saturating_sub(mtime) < super::subagents::ACTIVE_MS;
        stats.team_shown += 1;
        out.push(json!({
            "id": id,
            "kind": "teammate",
            "state": if running { "running" } else { "idle" },
            "cwd": m.cwd,
            "pid": pid,
            "startedAt": m.joined_at,
            "lastActivityAt": mtime / 10_000 * 10_000,
            "parent": null,
            "capabilities": super::read_only_caps(),
            "title": m.name,
            "native": { "jsonl": jsonl, "parentId": m.lead, "teamName": m.team, "backend": "tmux" },
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;

    #[test]
    fn reads_the_teammate_flags() {
        let c = "/Users/x/.local/share/claude/versions/2.1.330 --agent-id alpha@session-d35eb879 --agent-name alpha --team-name session-d35eb879 --parent-session-id d35eb879-b166 --model haiku";
        assert_eq!(teammate_args(c), Some(("alpha@session-d35eb879".into(), "d35eb879-b166".into())));
        assert_eq!(teammate_args("claude --model haiku"), None);
    }

    fn lead(root: &Path, sid: &str, pid: u32) -> Session {
        let jsonl = root.join(format!("projects/-p/{sid}.jsonl"));
        write(&jsonl, "");
        Session { pid, id: sid.into(), cwd: "/p".into(), started_at: 0, state: "idle", updated_at: 0, title: None, kind: "interactive".into(), jsonl, parent_raw: None }
    }

    #[test]
    fn only_live_teams_and_known_backends() {
        let root = tmp("teams");
        let sid = "d35eb879-b166-4f7e-a890-c8a462e5ff26";
        let cfg = |name: &str, lead: &str, pid: u32, backend: &str| json!({
            "name": name, "leadSessionId": lead, "leadProcess": { "pid": pid },
            "members": [
                { "agentId": format!("team-lead@{name}"), "name": "team-lead", "backendType": "in-process", "cwd": "/p" },
                { "agentId": format!("alpha@{name}"), "name": "alpha", "backendType": backend, "cwd": "/p", "joinedAt": 1 },
            ]
        }).to_string();
        write(&root.join("teams/live/config.json"), &cfg("live", sid, 42, "tmux"));
        // リードは生きているが pid が違う（使い回し）。リードがいない。知らない backendType
        write(&root.join("teams/reused/config.json"), &cfg("reused", sid, 43, "tmux"));
        write(&root.join("teams/dead/config.json"), &cfg("dead", "00000000-dead", 44, "tmux"));
        write(&root.join("teams/odd/config.json"), &cfg("odd", sid, 42, "iterm2"));
        write(&root.join("teams/broken/config.json"), "{");
        // leadProcess の無い古いチーム（リードは生きていない）。members の backendType も無い
        write(&root.join("teams/old/config.json"), &json!({ "name": "old", "leadSessionId": "11111111-gone", "members": [{ "agentId": "team-lead@old", "name": "team-lead" }] }).to_string());
        let live = vec![lead(&root, sid, 42)];
        let mut st = Stats::default();
        let ms = members(&root, &live, &mut st);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].agent_id, "alpha@live");
        assert_eq!(ms[0].lead, sid);
        assert_eq!(st.unexpected.get("teams: 知らない backendType Some(\"iterm2\")"), Some(&1));
        assert_eq!(st.unexpected.get("teams: 読めない config.json"), Some(&1));
        assert_eq!(st.unexpected.len(), 2, "{:?}", st.unexpected);
    }

    #[test]
    fn the_jsonl_is_found_by_team_and_name() {
        let root = tmp("teams2");
        let dir = root.join(format!("projects/{}", enc("/p")));
        write(&dir.join("lead.jsonl"), r#"{"type":"user","sessionId":"lead","message":{"content":"x"}}"#);
        write(&dir.join("bbbb.jsonl"), r#"{"type":"user","teamName":"t1","agentName":"beta"}"#);
        write(&dir.join("aaaa.jsonl"), &[r#"{"type":"mode","sessionId":"aaaa"}"#, r#"{"type":"attachment","teamName":"t1","agentName":"alpha"}"#].join("\n"));
        let m = Member { lead: "lead".into(), team: "t1".into(), agent_id: "alpha@t1".into(), name: "alpha".into(), cwd: "/p".into(), joined_at: 0 };
        assert_eq!(find_jsonl(&root, &m, 7).unwrap().file_name().unwrap(), "aaaa.jsonl");
    }
}
