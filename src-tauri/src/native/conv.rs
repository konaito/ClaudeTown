// ネイティブのセッションと sub-agent の会話を、jsonl から読む。
// 読み位置はバイトで数え、最後の改行までしか読まない（書きかけの行は次の回に読む）。
// 番号の印（epoch）は native:<inode>。ファイルが置き換わったら印が変わり、lib.rs の conversation が頭から読み直す。
// ファイルが読み位置より短くなったときも頭から読み直す（restarted）。
// 初めて開くとき（読み位置 0）は、末尾の FIRST_BYTES だけを読む。画面に出すのは最後の 80 件なので、頭からは読まない。
//
// 行は lib.rs の simplify と live_events にそのまま渡せる形（トランスクリプトの行）に整える。整えるのは次だけ。
// - isMeta と isCompactSummary の user の行は出さない（スキルの本文、要約などの差し込み。全件で数えて決めた）
// - teammate の受信文（<teammate-message teammate_id=…>本文</teammate-message>）は、お手紙と同じ形に直す
// - API の失敗（isApiErrorMessage の assistant）は、失敗の印（type: result、is_error）に直す
// 知らない type の行は、黙って捨てずに数える（odd_counts）

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Mutex;

/// 初めて開くときに読む末尾の長さ
pub const FIRST_BYTES: u64 = 4 << 20;
/// 1回で読む上限。続きは次の呼び出しで読む
pub const MAX_READ: u64 = 16 << 20;

/// 画面に出さないが、形を知っている行の type（2.1.330 の実ファイルで数えた。cost-state は --native-list の数え上げで見つけた）
const KNOWN_QUIET: [&str; 23] = [
    "system", "attachment", "file-history-snapshot", "file-history-delta", "last-prompt", "mode", "permission-mode",
    "session-owner", "atis-latch", "api-request-shape", "api-request-blob", "api-request", "ai-title", "custom-title",
    "agent-name", "tools-used", "queue-operation", "summary", "fork-context-ref", "progress", "tag", "pr-link", "cost-state",
];

static ODD: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

fn odd(what: String) {
    *ODD.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).entry(what).or_default() += 1;
}

/// これまでに会話を読んで見つけた想定外の形の件数
pub fn odd_counts() -> HashMap<String, usize> {
    ODD.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

pub struct Chunk {
    /// 次の読み位置（バイト）
    pub next: u64,
    /// 整えた行（simplify と live_events に渡す）
    pub lines: Vec<Value>,
    pub epoch: String,
    /// 読み位置がファイルより先だったので、頭から読み直した
    pub restarted: bool,
}

pub fn read(path: &Path, from: u64) -> Result<Chunk, String> {
    let meta = fs::metadata(path).map_err(|e| format!("会話の記録を読めない: {e}"))?;
    let len = meta.len();
    let epoch = format!("native:{}", meta.ino());
    let restarted = from > len;
    let from = if restarted { 0 } else { from };
    let start = if from == 0 { len.saturating_sub(FIRST_BYTES) } else { from };
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(MAX_READ).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    // 最後の改行まで。改行が無ければ何も読まない（書きかけ）
    let Some(end) = buf.iter().rposition(|b| *b == b'\n').map(|i| i + 1).or_else(|| {
        // 改行の無い最後の行でも、ファイルの終わりで JSON として読めれば読む（書き終えた最後の行）
        (start + buf.len() as u64 == len && serde_json::from_slice::<Value>(&buf).is_ok()).then_some(buf.len())
    }) else {
        return Ok(Chunk { next: start, lines: vec![], epoch, restarted });
    };
    let mut body = &buf[..end];
    // 末尾から読み始めたときは、最初の欠けた行を飛ばす
    if from == 0 && start > 0 {
        match body.iter().position(|b| *b == b'\n') {
            Some(i) => body = &body[i + 1..],
            None => body = &[],
        }
    }
    let lines = body.split(|b| *b == b'\n').filter(|l| !l.is_empty()).filter_map(|l| match serde_json::from_slice::<Value>(l) {
        Ok(v) => normalize(v),
        Err(_) => { odd("会話: JSON でない行".into()); None }
    }).collect();
    Ok(Chunk { next: start + end as u64, lines, epoch, restarted })
}

/// トランスクリプトの1行を、simplify に渡す形に整える。出さない行は None
pub fn normalize(mut v: Value) -> Option<Value> {
    let ty = v["type"].as_str().unwrap_or("").to_string();
    match ty.as_str() {
        "user" => {
            if v["isMeta"].as_bool() == Some(true) || v["isCompactSummary"].as_bool() == Some(true) {
                return None;
            }
            let text = crate::user_text(&v["message"]["content"]);
            if let Some(rest) = text.strip_prefix("<teammate-message") {
                let (attrs, body) = rest.split_once('>').unwrap_or(("", ""));
                let body = body.split("</teammate-message>").next().unwrap_or("").trim();
                let who = attrs.split("teammate_id=\"").nth(1).and_then(|x| x.split('"').next()).unwrap_or("");
                let esc = who.replace('"', "");
                v["message"]["content"] = json!(format!("<cross-session-message from=\"teammate:{esc}\" from-name=\"{esc}\">{body}</cross-session-message>"));
            }
            Some(v)
        }
        "assistant" => {
            if v["isApiErrorMessage"].as_bool() == Some(true) {
                let text = v["message"]["content"].as_array().into_iter().flatten()
                    .filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
                return Some(json!({ "type": "result", "is_error": true, "result": text, "timestamp": v["timestamp"] }));
            }
            Some(v)
        }
        t if KNOWN_QUIET.contains(&t) => None,
        t => {
            odd(format!("会話: 知らない type {t:?}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;

    fn items(lines: &[Value]) -> Vec<Value> {
        lines.iter().flat_map(crate::simplify).collect()
    }

    #[test]
    fn reads_up_to_the_last_newline_and_continues() {
        let d = tmp("conv");
        let p = d.join("s.jsonl");
        let u = r#"{"type":"user","timestamp":"2026-11-21T00:00:00Z","message":{"role":"user","content":"やって"}}"#;
        let a = r#"{"type":"assistant","timestamp":"2026-11-21T00:00:01Z","message":{"content":[{"type":"text","text":"やった"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/b/c.rs"}}]}}"#;
        // 書きかけの行（改行なし、JSON として不完全）
        write(&p, &format!("{u}\n{a}\n{{\"type\":\"user\",\"mess"));
        let c = read(&p, 0).unwrap();
        assert_eq!(c.next as usize, u.len() + a.len() + 2);
        let it = items(&c.lines);
        assert_eq!(it.iter().map(|x| x["role"].as_str().unwrap()).collect::<Vec<_>>(), vec!["user", "assistant", "tool"]);
        assert!(c.epoch.starts_with("native:"));
        // 続きを書き足すと、続きだけを読む
        let r = r#"{"type":"user","timestamp":"2026-11-21T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"中身"}]}}"#;
        write(&p, &format!("{u}\n{a}\n{r}\n"));
        let c2 = read(&p, c.next).unwrap();
        assert_eq!(items(&c2.lines)[0]["role"], "result");
        // 短くなったら頭から
        write(&p, &format!("{u}\n"));
        let c3 = read(&p, c2.next).unwrap();
        assert!(c3.restarted);
        assert_eq!(items(&c3.lines).len(), 1);
    }

    #[test]
    fn normalizes_meta_teammate_and_api_errors() {
        let meta = json!({"type":"user","isMeta":true,"message":{"content":"Base directory for this skill: x"}});
        assert!(normalize(meta).is_none());
        let compact = json!({"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued"}});
        assert!(normalize(compact).is_none());
        let tm = json!({"type":"user","message":{"content":"<teammate-message teammate_id=\"team-lead\" summary=\"s\">\n調べて\n</teammate-message>"}});
        let it = crate::simplify(&normalize(tm).unwrap());
        assert_eq!(it[0]["role"], "user");
        assert_eq!(it[0]["text"], "調べて");
        assert_eq!(it[0]["letter"]["fromName"], "team-lead");
        let err = json!({"type":"assistant","isApiErrorMessage":true,"timestamp":"t","message":{"content":[{"type":"text","text":"API Error: 529"}]}});
        let it = crate::simplify(&normalize(err).unwrap());
        assert_eq!(it[0]["role"], "event");
        assert_eq!(it[0]["kind"], "error");
        assert!(normalize(json!({"type":"api-request"})).is_none());
        let before = odd_counts().get("会話: 知らない type \"zzz-new\"").copied().unwrap_or(0);
        assert!(normalize(json!({"type":"zzz-new"})).is_none());
        assert_eq!(odd_counts().get("会話: 知らない type \"zzz-new\"").copied().unwrap_or(0), before + 1);
    }

    #[test]
    fn first_open_reads_only_the_tail() {
        let d = tmp("conv-tail");
        let p = d.join("big.jsonl");
        let line = format!(r#"{{"type":"user","message":{{"content":"{}"}}}}"#, "あ".repeat(1000));
        let n = (FIRST_BYTES as usize / line.len()) + 50;
        write(&p, &(0..n).map(|_| line.clone()).collect::<Vec<_>>().join("\n").add_nl());
        let c = read(&p, 0).unwrap();
        assert!(c.lines.len() < n && c.lines.len() > 100, "{} / {n}", c.lines.len());
        assert_eq!(c.next, fs::metadata(&p).unwrap().len());
    }

    trait AddNl { fn add_nl(self) -> String; }
    impl AddNl for String { fn add_nl(mut self) -> String { self.push('\n'); self } }
}
