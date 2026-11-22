// ネイティブのセッションと sub-agent の会話を、jsonl から読む。
// 読み位置はバイトで数え、最後の改行までしか読まない（書きかけの行は次の回に読む）。
// 番号の印（epoch）は native:<inode>。ファイルが置き換わったら印が変わり、lib.rs の conversation が頭から読み直す。
// ファイルが読み位置より短くなったときも頭から読み直す（restarted）。
// 初めて開くとき（読み位置 0）は、末尾の FIRST_BYTES だけを読む。画面に出すのは最後の 80 件なので、頭からは読まない。
// 最後の行が FIRST_BYTES より長いときは、その行の前の会話も読む。MAX_READ より長い行は読み飛ばし、会話に印を出す（#230）。
//
// 行は lib.rs の simplify と live_events にそのまま渡せる形（トランスクリプトの行）に整える。整えるのは次だけ。
// - isMeta と isCompactSummary の user の行は出さない（スキルの本文、要約などの差し込み。全件で数えて決めた）。
//   ただし origin が peer の行は出す。受信ソケットで届いた文（Town のチャット欄から送った文、別のセッションのお手紙）も isMeta になる（#156）
// - 作業中に受信ソケットで届いた文（attachment の queued_command、origin が peer）は、user の行に直す（#156）
// - teammate の受信文（<teammate-message teammate_id=…>本文</teammate-message>）は、お手紙と同じ形に直す
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
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let start = if from == 0 { tail_start(&mut f, len).map_err(|e| e.to_string())? } else { from };
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    (&mut f).take(MAX_READ).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    // 最後の改行まで。改行が無ければ何も読まない（書きかけ）
    let Some(end) = buf.iter().rposition(|b| *b == b'\n').map(|i| i + 1).or_else(|| {
        // 改行の無い最後の行でも、ファイルの終わりで JSON として読めれば読む（書き終えた最後の行）
        (start + buf.len() as u64 == len && serde_json::from_slice::<Value>(&buf).is_ok()).then_some(buf.len())
    }) else {
        // MAX_READ を読み切っても改行が無いのは、MAX_READ より長い行。次の改行の後へ進み、飛ばした印を出す（#230）。
        // 改行がファイルの終わりまで無ければ、書きかけなので待つ
        if buf.len() as u64 == MAX_READ
            && let Some(nl) = next_newline(&mut f, start + MAX_READ).map_err(|e| e.to_string())? {
                let skipped = json!({ "type": TOO_LONG, "bytes": nl - start });
                return Ok(Chunk { next: nl + 1, lines: vec![skipped], epoch, restarted });
            }
        return Ok(Chunk { next: start, lines: vec![], epoch, restarted });
    };
    let lines = buf[..end].split(|b| *b == b'\n').filter(|l| !l.is_empty()).filter_map(|l| match serde_json::from_slice::<Value>(l) {
        Ok(v) => normalize(v),
        Err(_) => { odd("会話: JSON でない行".into()); None }
    }).collect();
    Ok(Chunk { next: start + end as u64, lines, epoch, restarted })
}

/// 読み飛ばした長すぎる行の印の type。simplify が会話の印（event）にする
pub const TOO_LONG: &str = "fc-too-long-line";

/// 改行を探すときに1回で読む長さ
const SCAN: u64 = 64 << 10;

/// 初めて開くときに読み始める位置（行の頭）。末尾の FIRST_BYTES の中で最初に始まる行の頭を返す。
/// 窓の中で始まる行が無い（最後の行が FIRST_BYTES より長い）ときは、その行の頭から前の FIRST_BYTES を同じように探す。
/// 長い1行の一部だけを読んで捨て、前の会話が出なくなるのを避ける（#230）。長い行は read が読むか、MAX_READ を超えれば飛ばす。
/// 改行で終わっていない最後の行（書きかけ）は、窓の終わりから外して数える。数えると、長い行の後に書きかけの行があるとき、
/// 書きかけの行の頭を返し、何も読めない
fn tail_start(f: &mut fs::File, len: u64) -> std::io::Result<u64> {
    let mut end = line_head_before(f, len)?;
    loop {
        let start = end.saturating_sub(FIRST_BYTES);
        if start == 0 {
            return Ok(0);
        }
        // 1つ前のバイトから読み、最初の改行の次を行の頭とする
        f.seek(SeekFrom::Start(start - 1))?;
        let mut buf = Vec::new();
        (&mut *f).take(end - start + 1).read_to_end(&mut buf)?;
        if let Some(head) = buf.iter().position(|b| *b == b'\n').map(|i| start + i as u64).filter(|h| *h < end) {
            return Ok(head);
        }
        end = line_head_before(f, start - 1)?;
    }
}

/// pos より前で最後の改行の次（pos を含む行の頭）。無ければ 0
fn line_head_before(f: &mut fs::File, pos: u64) -> std::io::Result<u64> {
    let mut hi = pos;
    while hi > 0 {
        let lo = hi.saturating_sub(SCAN);
        f.seek(SeekFrom::Start(lo))?;
        let mut buf = Vec::new();
        (&mut *f).take(hi - lo).read_to_end(&mut buf)?;
        if let Some(i) = buf.iter().rposition(|b| *b == b'\n') {
            return Ok(lo + i as u64 + 1);
        }
        hi = lo;
    }
    Ok(0)
}

/// pos から先で最初の改行の位置。ファイルの終わりまで無ければ None
fn next_newline(f: &mut fs::File, pos: u64) -> std::io::Result<Option<u64>> {
    f.seek(SeekFrom::Start(pos))?;
    let mut at = pos;
    let mut buf = vec![0u8; SCAN as usize];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(None);
        }
        if let Some(i) = buf[..n].iter().position(|b| *b == b'\n') {
            return Ok(Some(at + i as u64));
        }
        at += n as u64;
    }
}

/// トランスクリプトの1行を、simplify に渡す形に整える。出さない行は None
pub fn normalize(mut v: Value) -> Option<Value> {
    let ty = v["type"].as_str().unwrap_or("").to_string();
    match ty.as_str() {
        "user" => {
            let peer = v["origin"]["kind"].as_str() == Some("peer");
            if (v["isMeta"].as_bool() == Some(true) && !peer) || v["isCompactSummary"].as_bool() == Some(true) {
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

    /// 大きいファイルを、試験が落ちても消す
    struct Rm(std::path::PathBuf);
    impl Drop for Rm { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn user_line(text: &str) -> String {
        json!({"type":"user","timestamp":"2026-11-23T00:00:00Z","message":{"role":"user","content":text}}).to_string()
    }

    fn texts(lines: &[Value]) -> Vec<String> {
        items(lines).iter().filter(|x| x["role"] == "user").filter_map(|x| x["text"].as_str().map(String::from)).collect()
    }

    /// 続きから読んでいる途中に MAX_READ を超える1行が足されても、読み位置が進み、後ろの行が取れる（#230）
    #[test]
    fn continues_past_a_line_longer_than_max_read() {
        let d = tmp("conv-huge-next");
        let _rm = Rm(d.clone());
        let p = d.join("s.jsonl");
        let a = user_line("前の文");
        write(&p, &format!("{a}\n"));
        let c = read(&p, 0).unwrap();
        assert_eq!(texts(&c.lines), vec!["前の文"]);
        let huge = user_line(&"x".repeat(17 << 20));
        let b = user_line("後の文");
        write(&p, &format!("{a}\n{huge}\n{b}\n"));
        let len = fs::metadata(&p).unwrap().len();
        let c2 = read(&p, c.next).unwrap();
        assert!(c2.next > c.next, "読み位置が {} から進まない", c.next);
        let c3 = read(&p, c2.next).unwrap();
        let got: Vec<Value> = c2.lines.iter().chain(c3.lines.iter()).cloned().collect();
        assert_eq!(texts(&got), vec!["後の文"]);
        assert_eq!(c3.next, len);
        // 飛ばした行は、会話の印で出る
        let it = items(&got);
        assert!(it.iter().any(|x| x["role"] == "event" && x["text"].as_str().unwrap_or("").contains("大きすぎる")), "{it:?}");
    }

    /// 初めて開くとき、最後の1行が FIRST_BYTES より長くても、前の会話が取れる（#230）
    #[test]
    fn first_open_reads_lines_before_a_long_last_line() {
        let d = tmp("conv-huge-tail");
        let _rm = Rm(d.clone());
        let p = d.join("s.jsonl");
        let big = user_line(&"y".repeat(5 << 20));
        write(&p, &format!("{}\n{}\n{}\n{big}\n", user_line("1"), user_line("2"), user_line("3")));
        let c = read(&p, 0).unwrap();
        let t = texts(&c.lines);
        assert_eq!(&t[..3], &["1", "2", "3"], "{:?}", t.iter().map(|s| s.len()).collect::<Vec<_>>());
        // MAX_READ 以下の長い行は、そのまま読む
        assert_eq!(t.len(), 4);
        assert_eq!(c.next, fs::metadata(&p).unwrap().len());
        // 長い行の後に書きかけの行があっても、前の行を読む
        write(&p, &format!("{}\n{}\n{}\n{big}\n{{\"type\":\"user\",\"mess", user_line("1"), user_line("2"), user_line("3")));
        let c = read(&p, 0).unwrap();
        assert_eq!(texts(&c.lines).len(), 4);
        assert_eq!(c.next, fs::metadata(&p).unwrap().len() - r#"{"type":"user","mess"#.len() as u64);
        // 最後の行が MAX_READ より長いときは、前の行を読み、次の回にその行を飛ばして終わりまで進む
        let huge = user_line(&"z".repeat(17 << 20));
        write(&p, &format!("{}\n{}\n{huge}\n", user_line("1"), user_line("2")));
        let len = fs::metadata(&p).unwrap().len();
        let c = read(&p, 0).unwrap();
        assert_eq!(texts(&c.lines), vec!["1", "2"]);
        let c2 = read(&p, c.next).unwrap();
        assert_eq!(c2.next, len);
        assert_eq!(items(&c2.lines)[0]["role"], "event");
    }

    trait AddNl { fn add_nl(self) -> String; }
    impl AddNl for String { fn add_nl(mut self) -> String { self.push('\n'); self } }
}
