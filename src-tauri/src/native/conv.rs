// ネイティブのセッションと sub-agent の会話を、jsonl から読む。
// 読み位置はバイトで数え、最後の改行までしか読まない（書きかけの行は次の回に読む）。
// 番号の印（epoch）は native:<inode>。ファイルが置き換わったら印が変わり、lib.rs の conversation が頭から読み直す。
// ファイルが読み位置より短くなったときも頭から読み直す（restarted）。
// 初めて開くとき（読み位置 0）は、末尾の FIRST_BYTES だけを読む。画面に出すのは最後の 80 件なので、頭からは読まない。
//
// 行は lib.rs の simplify と live_events にそのまま渡せる形（トランスクリプトの行）に整える。整えるのは次だけ。
// - isMeta と isCompactSummary の user の行は出さない（スキルの本文、要約などの差し込み。全件で数えて決めた）。
//   ただし origin が peer の行は出す。受信ソケットで届いた文（Town のチャット欄から送った文、別のセッションのお手紙）も isMeta になる（#156）
// - 作業中に受信ソケットで届いた文（attachment の queued_command、origin が peer）は、user の行に直す（#156）
// - teammate の受信文（<teammate-message>、<agent-message>）は直さずに通す。1行に2通以上入ることがあるので、simplify が包みごとにお手紙にする（#253）
// - API の失敗（isApiErrorMessage の assistant）は、失敗の印（type: result、is_error）に直す
// - ターンの途中で取り込まれた人の文（attachment の queued_command）は、user の行に直す（queued の印付き）
// - 順番待ちの出し入れ（queue-operation）と起動し直した印（SessionStart の attachment を session-start に直す）は、待ちの一覧のために通す
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
const KNOWN_QUIET: [&str; 21] = [
    "system", "file-history-snapshot", "file-history-delta", "last-prompt", "mode", "permission-mode",
    "session-owner", "atis-latch", "api-request-shape", "api-request-blob", "api-request", "ai-title", "custom-title",
    "agent-name", "tools-used", "summary", "fork-context-ref", "progress", "tag", "pr-link", "cost-state",
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
pub fn normalize(v: Value) -> Option<Value> {
    let ty = v["type"].as_str().unwrap_or("").to_string();
    match ty.as_str() {
        "user" => {
            let peer = v["origin"]["kind"].as_str() == Some("peer");
            if (v["isMeta"].as_bool() == Some(true) && !peer) || v["isCompactSummary"].as_bool() == Some(true) {
                return None;
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
        // 順番待ちの出し入れ。会話の項目にはせず、conversation の live_events が待ちの一覧に使う
        "queue-operation" => Some(v),
        "attachment" => {
            let a = &v["attachment"];
            match a["type"].as_str() {
                // 作業中に打った文が、ターンの途中で取り込まれた印。この文は user の行にならず、ここにしか残らない（2.1.330）。
                // 人が打った文（commandMode が prompt、origin が human）と、受信ソケットで届いた文（origin が peer。Town のチャット欄から送った文など、#156）を
                // user の行にし、queued の印を付ける
                Some("queued_command") if a["commandMode"] == "prompt"
                    && ((a["origin"]["kind"] == "human" && a["isMeta"].as_bool() != Some(true)) || a["origin"]["kind"] == "peer") => {
                    Some(json!({ "type": "user", "timestamp": v["timestamp"], "queued": true, "message": { "role": "user", "content": a["prompt"] } }))
                }
                // 起動し直した印。CLI の待ちは起動し直すと空になる
                _ if a["hookEvent"] == "SessionStart" => Some(json!({ "type": "session-start", "timestamp": v["timestamp"] })),
                _ => None,
            }
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
        // 受信ソケットで届いた文は isMeta でも出す（#156）
        let peer = json!({"type":"user","isMeta":true,"origin":{"kind":"peer","from":"unknown"},"message":{"content":"Another Claude session sent a message:\nやあ\n\nThis came from another Claude session — not typed by your user."}});
        let it = crate::simplify(&normalize(peer).unwrap());
        assert_eq!(it[0]["role"], "user");
        assert_eq!(it[0]["text"], "やあ");
        // 作業中に受信ソケットで届いた文は、ターンの途中で取り込まれ、attachment の queued_command にしか残らない（#156）
        let q = json!({"type":"attachment","timestamp":"2026-11-22T13:15:28.000Z","attachment":{"type":"queued_command","prompt":"1通目","commandMode":"prompt","origin":{"kind":"peer","from":"unknown"}}});
        let it = crate::simplify(&normalize(q).unwrap());
        assert_eq!(it[0]["role"], "user");
        assert_eq!(it[0]["text"], "1通目");
        let task = json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>x</task-notification>","commandMode":"task-notification","origin":{"kind":"task-notification"}}});
        assert!(normalize(task).is_none());
        let compact = json!({"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued"}});
        assert!(normalize(compact).is_none());
        let tm = json!({"type":"user","message":{"content":"<teammate-message teammate_id=\"team-lead\" summary=\"s\">\n調べて\n</teammate-message>"}});
        // `<` で始まるが、お手紙なのでターンの始まりとして数える
        assert!(crate::live_events(&normalize(tm.clone()).unwrap()).iter().any(|e| matches!(e, crate::LiveEv::User(_))));
        let it = crate::simplify(&normalize(tm).unwrap());
        assert_eq!(it[0]["role"], "user");
        assert_eq!(it[0]["text"], "調べて");
        assert_eq!(it[0]["letter"]["fromName"], "team-lead");
        // リードに届くチームメイトの文は、前置きの後ろに包みが並ぶ。1行に2通以上入ることがある（2.1.330、#253）
        let two = json!({"type":"user","message":{"content":"Another Claude session sent a message:\n<teammate-message teammate_id=\"fix-1\" color=\"blue\" summary=\"s\">\n1通目\n</teammate-message>\n\n<teammate-message teammate_id=\"fix-2\">\n2通目\n</teammate-message>\n\nThis came from another Claude session — not typed by your user."}});
        let it = crate::simplify(&normalize(two).unwrap());
        assert_eq!(it.len(), 2);
        assert_eq!((it[0]["text"].as_str(), it[0]["letter"]["fromRaw"].as_str()), (Some("1通目"), Some("teammate:fix-1")));
        assert_eq!((it[1]["text"].as_str(), it[1]["letter"]["fromName"].as_str()), (Some("2通目"), Some("fix-2")));
        // 受信ソケットの agent-message（isMeta、origin が peer）と、作業中に取り込まれた agent-message（queued_command）も同じに出す（#253）
        let am = json!({"type":"user","isMeta":true,"origin":{"kind":"peer","from":"unknown"},"message":{"content":"Another Claude session sent a message:\n<agent-message from=\"issue-1\">\n直した\n</agent-message>\n\nThat \"other Claude session\" is an agent working inside this same session."}});
        let it = crate::simplify(&normalize(am).unwrap());
        assert_eq!((it.len(), it[0]["text"].as_str(), it[0]["letter"]["fromName"].as_str()), (1, Some("直した"), Some("issue-1")));
        let aq = json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"<agent-message from=\"issue-1\">\n直した\n</agent-message>","commandMode":"prompt","origin":{"kind":"peer"}}});
        let it = crate::simplify(&normalize(aq).unwrap());
        assert_eq!((it.len(), it[0]["text"].as_str(), it[0]["letter"]["fromName"].as_str()), (1, Some("直した"), Some("issue-1")));
        let err =json!({"type":"assistant","isApiErrorMessage":true,"timestamp":"t","message":{"content":[{"type":"text","text":"API Error: 529"}]}});
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
