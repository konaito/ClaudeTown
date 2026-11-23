// セッションの下の sub-agent と teammate を、町の子として出す。
// 置き場所: projects/<dir>/<親の sessionId>/subagents/agent-<agentId>.jsonl と agent-<agentId>.meta.json。
// workflow の agent は subagents/workflows/<wf_id>/ の下に同じ形で置かれる。
// 親は置き場所のディレクトリ名で決める（jsonl の先頭行は使わない。先頭行に sessionId が無い fork-context-ref がある）。
// meta.json の parentAgentId があれば、その sub-agent の子にする（見えていなければ、見えている祖先に付け替える）。
//
// 実行中かの決め方（2026-11-21 に自分のセッションの sub-agent で見た）:
// - meta.json の finished は、ターンが止まると true になる。裏でコマンドを待っている間も true になり、その後に jsonl が伸びた。
//   finished は「終わった」の印にならない。finished の無い古い版の記録もある（全件 3613 本のうち finished ありは 777 本）
// - そこで、jsonl の更新が ACTIVE_MS 以内なら実行中、finished が無く STALE_MS 以内でも実行中、それ以外は終わったものとする
// - teammate（taskKind: in_process_teammate）には finished が付かない。更新が ACTIVE_MS 以内のときだけ実行中にする
//
// 畳み方（仮置き。#96 の報告で見せる）: 終わってから FOLD_MS を過ぎた sub-agent は出さない。
// 1つのセッションの下に出すのは MAX_SHOWN 体まで（実行中を先に、新しい順）。workflow は1本で100体を超えることがある

use super::sessions::Session;
use super::{mtime_ms, Stats};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const ACTIVE_MS: u64 = 30_000;
pub const STALE_MS: u64 = 10 * 60_000;
pub const FOLD_MS: u64 = 10 * 60_000;
pub const MAX_SHOWN: usize = 8;
/// 末尾を読む長さ。最後の返事と道具を拾う
const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone)]
struct Sub {
    /// チームに今も入っているチームメイト（畳まない）
    member: bool,
    teammate: bool,
    stem: String,
    jsonl: PathBuf,
    meta: Value,
    mtime: u64,
    created: u64,
    running: bool,
}

/// 末尾から読んだ様子（最後の返事、最後の道具）。ファイルの長さと更新時刻が変わったときだけ読み直す
#[derive(Clone, Default)]
struct Tail {
    said: Option<String>,
    doing: Option<String>,
}
/// ファイルの (更新時刻, 大きさ)
type Stamp = (u64, u64);
static TAILS: Mutex<Option<HashMap<PathBuf, (Stamp, Tail)>>> = Mutex::new(None);
static METAS: Mutex<Option<HashMap<PathBuf, (Stamp, Value)>>> = Mutex::new(None);

fn stamp(m: &fs::Metadata) -> (u64, u64) {
    (m.len(), mtime_ms(m))
}

fn read_meta(p: &Path) -> Option<Value> {
    let m = fs::metadata(p).ok()?;
    let st = stamp(&m);
    let mut g = METAS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if let Some((s, v)) = map.get(p)
        && *s == st {
            return Some(v.clone());
        }
    let v: Value = serde_json::from_str(&fs::read_to_string(p).ok()?).ok()?;
    map.insert(p.to_path_buf(), (st, v.clone()));
    Some(v)
}

fn tail_of(p: &Path, st: (u64, u64)) -> Tail {
    let mut g = TAILS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if let Some((s, t)) = map.get(p)
        && *s == st {
            return t.clone();
        }
    let t = read_tail(p, st.0);
    map.insert(p.to_path_buf(), (st, t.clone()));
    t
}

fn read_tail(p: &Path, len: u64) -> Tail {
    let mut t = Tail::default();
    let Ok(mut f) = fs::File::open(p) else { return t };
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return t;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return t;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // 途中から読んだ1行目は欠けている
    }
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "assistant" {
            continue;
        }
        for c in v["message"]["content"].as_array().into_iter().flatten().rev() {
            match c["type"].as_str() {
                Some("text") if t.said.is_none() => {
                    let s = c["text"].as_str().unwrap_or("").trim();
                    if !s.is_empty() {
                        t.said = Some(crate::clip(s, 200));
                    }
                }
                Some("tool_use") if t.doing.is_none() => {
                    t.doing = Some(crate::tool_line(c["name"].as_str().unwrap_or(""), &c["input"]));
                }
                _ => {}
            }
        }
        if t.said.is_some() && t.doing.is_some() {
            break;
        }
    }
    t
}

/// in-process のチームメイトが、今もチームの config.json（~/.claude/teams/<チーム名>/config.json）の members にいるか。
/// 置き場所は、リードの jsonl（<root>/projects/<dir>/<sid>.jsonl）から3つ上がった root の下
fn in_team(lead_jsonl: &Path, team: Option<&str>, name: Option<&str>) -> bool {
    let (Some(team), Some(name)) = (team, name) else { return false };
    let Some(root) = lead_jsonl.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) else { return false };
    let Some(v) = read_meta(&root.join("teams").join(team).join("config.json")) else { return false };
    v["members"].as_array().into_iter().flatten().any(|m| m["name"].as_str() == Some(name))
}

/// subagents/ と subagents/workflows/*/ の agent-*.jsonl
fn agent_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut scan = |d: &Path| {
        if let Ok(rd) = fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("agent-") && name.ends_with(".jsonl") {
                    out.push(p);
                }
            }
        }
    };
    scan(dir);
    if let Ok(rd) = fs::read_dir(dir.join("workflows")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                scan(&e.path());
            }
        }
    }
    out
}

/// 画面の id。親の sessionId で始めない（親を sid8 の前方一致で探すところがあるので、sub-agent が親に選ばれないように）
pub fn sub_id(stem: &str, session_id: &str) -> String {
    format!("sub-{stem}@{}", &session_id[..session_id.len().min(8)])
}

pub fn of_session(s: &Session, now: u64, stats: &mut Stats) -> Vec<Value> {
    let Some(dir) = s.jsonl.parent().map(|d| d.join(&s.id).join("subagents")) else { return vec![] };
    let mut subs = vec![];
    for jsonl in agent_files(&dir) {
        let Ok(m) = fs::metadata(&jsonl) else { continue };
        stats.sub_total += 1;
        let name = jsonl.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let stem = name.trim_start_matches("agent-").trim_end_matches(".jsonl").to_string();
        let meta_path = jsonl.with_file_name(format!("agent-{stem}.meta.json"));
        // meta の無い古い版の記録も出す（名前は agentId の頭）
        let meta = match read_meta(&meta_path) {
            Some(v) if v.is_object() => v,
            Some(_) => { stats.odd("subagents: meta.json が object でない"); json!({}) }
            None => {
                if meta_path.exists() { stats.odd("subagents: 読めない meta.json") } else { stats.sub_no_meta += 1 }
                json!({})
            }
        };
        let mtime = mtime_ms(&m);
        let created = m.created().ok().and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(mtime);
        let age = now.saturating_sub(mtime);
        let teammate = meta["taskKind"].as_str() == Some("in_process_teammate");
        if let Some(k) = meta["taskKind"].as_str().filter(|k| *k != "in_process_teammate") {
            stats.odd(format!("subagents: 知らない taskKind {k:?}"));
        }
        let finished = meta["finished"].as_bool() == Some(true);
        let running = age < ACTIVE_MS || (!teammate && !finished && age < STALE_MS);
        let member = teammate && in_team(&s.jsonl, meta["teamName"].as_str(), meta["name"].as_str());
        subs.push(Sub { member, teammate, stem, jsonl, meta, mtime, created, running });
    }
    // 畳む: 終わってから FOLD_MS を過ぎたもの。チームに今も入っているチームメイトは、待っている間も畳まない
    let before = subs.len();
    subs.retain(|x| x.member || x.running || now.saturating_sub(x.mtime) < FOLD_MS);
    stats.sub_folded += before - subs.len();
    // 上限: チームのチームメイトを先に、次に実行中を、新しい順
    subs.sort_by(|a, b| b.member.cmp(&a.member).then(b.running.cmp(&a.running)).then(b.mtime.cmp(&a.mtime)));
    if subs.len() > MAX_SHOWN {
        stats.sub_capped += subs.len() - MAX_SHOWN;
        subs.truncate(MAX_SHOWN);
    }
    let shown: HashSet<String> = subs.iter().map(|x| x.stem.clone()).collect();
    // 親: parentAgentId をたどり、見えている sub-agent に当たればその子、当たらなければセッションの子
    let parent_of = |x: &Sub| -> String {
        let mut cur = x.meta["parentAgentId"].as_str().map(String::from);
        let mut seen = HashSet::new();
        while let Some(p) = cur {
            if !seen.insert(p.clone()) {
                break;
            }
            if shown.contains(&p) && p != x.stem {
                return sub_id(&p, &s.id);
            }
            // 見えていない sub-agent の親は、meta をもう一度読んでたどる（畳んだ中間の sub-agent）
            cur = read_meta(&x.jsonl.with_file_name(format!("agent-{p}.meta.json"))).and_then(|m| m["parentAgentId"].as_str().map(String::from));
        }
        s.id.clone()
    };
    let mut out = vec![];
    for x in &subs {
        let tail = tail_of(&x.jsonl, (fs::metadata(&x.jsonl).map(|m| m.len()).unwrap_or(0), x.mtime));
        let meta = &x.meta;
        let title = meta["name"].as_str().or(meta["agentType"].as_str()).map(String::from).unwrap_or_else(|| format!("sub-agent {}", &x.stem[..x.stem.len().min(8)]));
        let cwd = meta["worktreePath"].as_str().or(meta["cwd"].as_str()).unwrap_or(&s.cwd).to_string();
        out.push(json!({
            "id": sub_id(&x.stem, &s.id),
            "kind": if x.teammate { "teammate" } else { "subagent" },
            "state": if x.running { "running" } else { "idle" },
            "cwd": cwd,
            "pid": null,
            "startedAt": x.created,
            // 細かい更新時刻を入れると、一覧が毎回変わったことになり、2秒ごとに画面へ送る。10秒に丸める
            "lastActivityAt": x.mtime / 10_000 * 10_000,
            "parent": null,
            "capabilities": super::read_only_caps(),
            "title": title,
            "native": {
                "jsonl": x.jsonl,
                "parentId": parent_of(x),
                "agentType": meta["agentType"],
                "teamName": meta["teamName"],
                "report": {
                    "phase": if x.running { "working" } else { "resting" },
                    "asked": meta["description"],
                    "doing": if x.running { json!(tail.doing) } else { Value::Null },
                    "said": tail.said,
                },
            },
        }));
    }
    stats.sub_shown += out.len();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;

    fn sess(root: &Path, sid: &str) -> Session {
        let jsonl = root.join(format!("projects/-p/{sid}.jsonl"));
        write(&jsonl, "");
        Session { pid: 1, id: sid.into(), cwd: "/p".into(), started_at: 0, state: "idle", updated_at: 0, title: None, kind: "interactive".into(), jsonl, parent_raw: None, socket: None }
    }

    fn agent(root: &Path, sid: &str, stem: &str, meta: Option<Value>, lines: &[&str]) -> PathBuf {
        let d = root.join(format!("projects/-p/{sid}/subagents"));
        let j = d.join(format!("agent-{stem}.jsonl"));
        write(&j, &lines.join("\n"));
        if let Some(m) = meta {
            write(&d.join(format!("agent-{stem}.meta.json")), &m.to_string());
        }
        j
    }

    const A1: &str = r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"調べた"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#;

    #[test]
    fn running_finished_folded_and_nested() {
        let root = tmp("subs");
        let sid = "44444444-aaaa-bbbb-cccc-000000000004";
        let s = sess(&root, sid);
        agent(&root, sid, "a1", Some(json!({"agentType":"Explore","description":"探す"})), &[A1]);
        agent(&root, sid, "a2", Some(json!({"agentType":"general-purpose","description":"子の子","parentAgentId":"a1","finished":true})), &[A1]);
        agent(&root, sid, "old", Some(json!({"agentType":"Explore","finished":true})), &[A1]);
        agent(&root, sid, "nometa", None, &[A1]);
        // mtime の代わりに now をずらす: いま書いたファイルを、now = 書いた時刻 + 15分 で見ると「古い」
        let now = super::super::now_ms();
        let mut st = Stats::default();
        let v = of_session(&s, now, &mut st);
        assert_eq!(v.len(), 4);
        let a1 = v.iter().find(|x| x["id"] == sub_id("a1", sid)).unwrap();
        assert_eq!(a1["state"], "running");
        assert_eq!(a1["native"]["parentId"], sid);
        assert_eq!(a1["native"]["report"]["asked"], "探す");
        assert_eq!(a1["native"]["report"]["said"], "調べた");
        assert_eq!(a1["native"]["report"]["doing"], "コマンド: ls");
        let a2 = v.iter().find(|x| x["id"] == sub_id("a2", sid)).unwrap();
        assert_eq!(a2["native"]["parentId"], sub_id("a1", sid));
        assert_eq!(st.sub_no_meta, 1);
        assert!(!sub_id("a1", sid).starts_with(&sid[..8]));

        // 15分後: finished のものと meta の無いもの（finished 無し、STALE_MS 超え）は畳まれる
        let mut st = Stats::default();
        let v = of_session(&s, now + 15 * 60_000, &mut st);
        assert_eq!(v.len(), 0);
        assert_eq!(st.sub_folded, 4);
    }

    #[test]
    fn teammates_in_a_live_team_are_not_folded() {
        let root = tmp("subs-team");
        let sid = "77777777-aaaa-bbbb-cccc-000000000007";
        let s = sess(&root, sid);
        let meta = |name: &str| json!({"agentType":name,"name":name,"taskKind":"in_process_teammate","teamName":"session-77777777"});
        agent(&root, sid, "aalpha-1", Some(meta("alpha")), &[A1]);
        agent(&root, sid, "abeta-2", Some(meta("beta")), &[A1]);
        write(&root.join("teams/session-77777777/config.json"), &json!({"members":[{"name":"team-lead"},{"name":"alpha"}]}).to_string());
        let mut st = Stats::default();
        let v = of_session(&s, super::super::now_ms() + 15 * 60_000, &mut st);
        assert_eq!(v.len(), 1, "チームにいる alpha だけ残る");
        assert_eq!(v[0]["kind"], "teammate");
        assert_eq!(v[0]["title"], "alpha");
        assert_eq!(v[0]["state"], "idle");
        assert!(st.unexpected.is_empty(), "{:?}", st.unexpected);
    }

    #[test]
    fn finished_but_recently_written_is_running() {
        let root = tmp("subs2");
        let sid = "55555555-aaaa-bbbb-cccc-000000000005";
        let s = sess(&root, sid);
        agent(&root, sid, "bg", Some(json!({"agentType":"x","finished":true})), &[A1]);
        let now = super::super::now_ms();
        let mut st = Stats::default();
        assert_eq!(of_session(&s, now, &mut st)[0]["state"], "running");
        let mut st = Stats::default();
        assert_eq!(of_session(&s, now + ACTIVE_MS + 1000, &mut st)[0]["state"], "idle");
    }

    #[test]
    fn cap_and_reattach_to_visible_ancestor() {
        let root = tmp("subs3");
        let sid = "66666666-aaaa-bbbb-cccc-000000000006";
        let s = sess(&root, sid);
        for i in 0..12 {
            agent(&root, sid, &format!("w{i:02}"), Some(json!({"agentType":"wf"})), &[A1]);
        }
        // workflow の下も数える
        let d = root.join(format!("projects/-p/{sid}/subagents/workflows/wf_1"));
        write(&d.join("agent-wf9.jsonl"), A1);
        write(&d.join("agent-wf9.meta.json"), &json!({"agentType":"wf","parentAgentId":"zz-hidden"}).to_string());
        let mut st = Stats::default();
        let v = of_session(&s, super::super::now_ms(), &mut st);
        assert_eq!(v.len(), MAX_SHOWN);
        assert_eq!(st.sub_total, 13);
        assert_eq!(st.sub_capped, 13 - MAX_SHOWN);
        for x in &v {
            assert!(x["native"]["parentId"] == sid, "見えていない親の子はセッションに付け替える");
        }
    }
}
