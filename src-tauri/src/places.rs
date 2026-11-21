// 新しい世帯のペイン（#89）の「最近の場所」の候補。Claude Code の入力の履歴（~/.claude/history.jsonl）の project と timestamp から作る。
// 履歴の1行は {display, timestamp, project, sessionId, …}（2026-11-21 に実ファイルで見た。23350 行、8.8MB、project は1000か所）。
// - 同じ場所は、いちばん新しい時刻にまとめる。
// - worktree（<リポジトリ>/.claude/worktrees/<名前>/…）は、リポジトリの場所にまとめる。worktree はすぐ消えるので、新しい世帯の行き先にしない。
// - いまディレクトリとして無い場所（消した一時のディレクトリなど）は出さない。
// ファイルの更新時刻と大きさが変わったときだけ読み直す。読むだけで、~/.claude には書かない。

use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// 返す件数の上限（画面は新しい順に20件を出す。除く場所があっても足りるように多めに返す）
const MAX: usize = 300;

static CACHE: Mutex<Option<((u64, u128), Vec<(String, u64)>)>> = Mutex::new(None);

/// worktree の中なら、リポジトリの場所
pub fn group(path: &str) -> String {
    let p = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    match p.find("/.claude/worktrees/") {
        Some(i) if i > 0 => p[..i].to_string(),
        _ => p.to_string(),
    }
}

/// history.jsonl の中身から、場所ごとの最後の時刻を新しい順に作る
pub fn from_history(text: &str) -> Vec<(String, u64)> {
    let mut at: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let (Some(p), Some(t)) = (v["project"].as_str(), v["timestamp"].as_u64()) else { continue };
        if !p.starts_with('/') {
            continue;
        }
        let e = at.entry(group(p)).or_default();
        *e = (*e).max(t);
    }
    let mut v: Vec<(String, u64)> = at.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// 最近の場所（{path, lastUsedAt} の並び、新しい順）。履歴が読めなければ空
pub fn recent(claude_home: &Path) -> Value {
    let file = claude_home.join("history.jsonl");
    let Ok(meta) = fs::metadata(&file) else { return json!([]) };
    let stamp = (meta.len(), meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0));
    let list = {
        let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some((s, v)) if *s == stamp => v.clone(),
            _ => {
                let v = fs::read_to_string(&file).map(|t| from_history(&t)).unwrap_or_default();
                *g = Some((stamp, v.clone()));
                v
            }
        }
    };
    json!(list
        .into_iter()
        .filter(|(p, _)| Path::new(p).is_dir())
        .take(MAX)
        .map(|(p, t)| json!({ "path": p, "lastUsedAt": t }))
        .collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktrees_fold_into_the_repo() {
        assert_eq!(group("/Users/a/Documents/fc/.claude/worktrees/x"), "/Users/a/Documents/fc");
        assert_eq!(group("/Users/a/Documents/fc/.claude/worktrees/x/sub"), "/Users/a/Documents/fc");
        assert_eq!(group("/Users/a/Documents/fc/"), "/Users/a/Documents/fc");
        assert_eq!(group("/"), "/");
    }

    #[test]
    fn newest_time_per_place() {
        let h = [
            r#"{"display":"a","timestamp":10,"project":"/r"}"#,
            r#"{"display":"b","timestamp":30,"project":"/r/.claude/worktrees/w"}"#,
            r#"{"display":"c","timestamp":20,"project":"/s"}"#,
            r#"{"display":"d","timestamp":5}"#,
            "{",
        ]
        .join("\n");
        assert_eq!(from_history(&h), vec![("/r".to_string(), 30), ("/s".to_string(), 20)]);
    }
}
