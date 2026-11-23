// 受けた側の jsonl に出たチームメイトの文から、お手紙の「読んだ」の元になる received を作る（#276）。
//
// agent teams のチームメイトの文（<teammate-message>、<agent-message>）を受けても UserPromptSubmit の hook は出ないので、
// hook は letters.jsonl に received を書けない（#271 の実測、Claude Code 2.1.330 の in-process と tmux）。
// 受けた文は受けた側の jsonl に残るので、ここで読み、画面に渡す letters に足す。letters.jsonl には書かない（安定版も読むファイルの形を変えない）。
//
// 作る行: { ev: "received", via: "jsonl", to: 受けた行の id, from_raw: "teammate:<名前>", from_name, summary: 包みの summary 属性, at, id }。
// 送り手はチームの中の名前なので、src/letters.ts の flightsOf が受け手を起点に resolvePeer で引き、対になる sent があるときだけ既読の印にする。
// 会話に出さない包み（shutdown_request など）も、受けた印としては数える。sent の行は SendMessage の分だけあるので、数えないと次の sent に当たる。
//
// 読む先: チームメイトと sub-agent の行、その親（リード）の jsonl。読むのは増えた分だけで、初めて読むときと、間が空いて大きく伸びたときは
// 末尾の FIRST_BYTES だけ読む（仮置き。お手紙の窓は10分なので、それより前の行は要らない）。

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Mutex;

/// 初めて読むとき（と、前に読んだところから大きく伸びたとき）に読む末尾の長さ
pub const FIRST_BYTES: u64 = 2 * 1024 * 1024;

/// jsonl ごとの、前回までに読んだところ
pub struct Tail {
    ino: u64,
    /// ここまで読んだ（改行で終わる行の末尾）バイト位置
    offset: u64,
    /// 作った received のうち、まだ窓に入りうるもの
    recs: Vec<Value>,
}

/// (行の id, jsonl) ごとの Tail
pub type Cache = HashMap<(String, PathBuf), Tail>;

/// 読む先。チームメイトと sub-agent の行と、その親の行（id と jsonl）
pub fn targets(rows: &[Value]) -> Vec<(String, PathBuf)> {
    let subs: HashSet<&str> = rows.iter()
        .filter(|r| matches!(r["kind"].as_str(), Some("teammate") | Some("subagent")))
        .filter_map(|r| r["id"].as_str())
        .collect();
    let parents: HashSet<&str> = rows.iter()
        .filter(|r| r["id"].as_str().is_some_and(|id| subs.contains(id)))
        .filter_map(|r| r["native"]["parentId"].as_str())
        .collect();
    rows.iter()
        .filter_map(|r| {
            let id = r["id"].as_str()?;
            if !subs.contains(id) && !parents.contains(id) {
                return None;
            }
            Some((id.to_string(), PathBuf::from(r["native"]["jsonl"].as_str()?)))
        })
        .collect()
}

/// 読む先の jsonl から、時刻が since 以降の received を、時刻の順に返す。cache は呼ぶ側が持つ
pub fn read(targets: &[(String, PathBuf)], since: u64, cache: &mut Cache) -> Vec<Value> {
    read_with(targets, since, cache, FIRST_BYTES)
}

/// 町の一覧を作るたびに呼ぶ形。cache をここで持つ
pub fn recent(targets: &[(String, PathBuf)], since: u64) -> Vec<Value> {
    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    read(targets, since, g.get_or_insert_with(HashMap::new))
}

fn read_with(targets: &[(String, PathBuf)], since: u64, cache: &mut Cache, first: u64) -> Vec<Value> {
    let keep: HashSet<(String, PathBuf)> = targets.iter().cloned().collect();
    cache.retain(|k, _| keep.contains(k));
    let mut out = vec![];
    for key in targets {
        let prev = cache.remove(key);
        let Ok(m) = fs::metadata(&key.1) else { continue };
        let (ino, len) = (m.ino(), m.len());
        // 同じファイルが後ろに伸びただけなら続きから。初めてか、入れ替わった、縮んだなら末尾から
        let (mut from, mut recs) = match prev {
            Some(t) if t.ino == ino && len >= t.offset => (t.offset, t.recs),
            _ => (0, vec![]),
        };
        // 前の位置は行の頭。末尾から読むときは、途中から始まる1行目を捨てる
        let mut cut = false;
        if len - from > first {
            from = len - first;
            cut = true;
        }
        let mut buf = Vec::new();
        let ok = fs::File::open(&key.1).and_then(|mut f| { f.seek(SeekFrom::Start(from))?; f.take(len - from).read_to_end(&mut buf) }).is_ok();
        if !ok {
            continue;
        }
        // 書きかけの最後の行（改行が無い）は、次の回に読む
        let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        let start = if cut { buf[..end].iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(end) } else { 0 };
        for line in buf[start..end].split(|&b| b == b'\n') {
            recs.extend(from_line(&key.0, line));
        }
        recs.retain(|r| r["at"].as_u64().is_some_and(|a| a >= since));
        out.extend(recs.iter().cloned());
        cache.insert(key.clone(), Tail { ino, offset: from + end as u64, recs });
    }
    out.sort_by(|a, b| a["at"].as_u64().cmp(&b["at"].as_u64()).then(a["id"].as_str().cmp(&b["id"].as_str())));
    out
}

/// jsonl の1行から、チームメイトの包みごとの received を作る
fn from_line(to: &str, line: &[u8]) -> Vec<Value> {
    // 速さのため、包みの名前を含まない行は JSON として読まない
    let has = |pat: &[u8]| line.windows(pat.len()).any(|w| w == pat);
    if !(has(b"teammate-message") || has(b"agent-message")) {
        return vec![];
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return vec![] };
    // user の行と、作業中に取り込まれた文（attachment）だけを normalize に通す。ほかの type は normalize が「知らない type」に数える
    if !matches!(v["type"].as_str(), Some("user") | Some("attachment")) {
        return vec![];
    }
    let Some(v) = super::conv::normalize(v) else { return vec![] };
    let Some(at) = v["timestamp"].as_str().and_then(iso_ms) else { return vec![] };
    crate::conversation::letters_in(&v).into_iter()
        .filter(|h| h.raw.as_deref().is_some_and(|r| r.starts_with("teammate:")))
        .enumerate()
        .map(|(k, h)| json!({
            "ev": "received", "id": format!("jsonl:{to}:{at}:{k}"), "at": at, "to": to,
            "from_raw": h.raw, "from_name": h.name, "summary": h.summary.unwrap_or_default(), "via": "jsonl",
        }))
        .collect()
}

/// jsonl の timestamp（2026-11-23T01:00:00.000Z の形、UTC）を ms にする
pub(crate) fn iso_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z').unwrap_or(s);
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    // 暦の日から 1970-01-01 からの日数（Howard Hinnant の days_from_civil）
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::testtree::*;
    use std::io::Write;

    #[derive(serde::Deserialize)]
    struct Cases {
        files: serde_json::Map<String, Value>,
        received: Vec<Value>,
    }

    fn cases() -> Cases {
        serde_json::from_str(include_str!("../../../src/teammate-read-cases.json")).unwrap()
    }

    /// 事例の files を合成の jsonl に書き、読む先を返す
    fn write_files(c: &Cases, dir: &std::path::Path) -> Vec<(String, PathBuf)> {
        c.files.iter().enumerate().map(|(i, (id, lines))| {
            let p = dir.join(format!("{i}.jsonl"));
            let text: String = lines.as_array().unwrap().iter().map(|l| format!("{l}\n")).collect();
            write(&p, &text);
            (id.clone(), p)
        }).collect()
    }

    const T0: u64 = 1_795_395_600_000;

    #[test]
    fn teammate_messages_in_receiver_jsonl_become_received() {
        let c = cases();
        let dir = tmp("received");
        let t = write_files(&c, &dir);
        let mut cache = Cache::new();
        assert_eq!(read(&t, T0, &mut cache), c.received);
        // 2回目は読んだところから。増えていなければ同じものを返す
        assert_eq!(read(&t, T0, &mut cache), c.received);
    }

    #[test]
    fn reads_only_what_was_added_and_drops_old() {
        let c = cases();
        let dir = tmp("received-add");
        let t = write_files(&c, &dir);
        let mut cache = Cache::new();
        read(&t, T0, &mut cache);
        let bob = &t.iter().find(|(id, _)| id.starts_with("sub-abob")).unwrap().1;
        let line = json!({"type":"user","timestamp":"2026-11-23T01:05:00.000Z","message":{"role":"user","content":"<teammate-message teammate_id=\"team-lead\">\nもう1通\n</teammate-message>"}});
        // 書きかけの行（改行が無い）は読まない
        let mut f = fs::OpenOptions::new().append(true).open(bob).unwrap();
        write!(f, "{line}").unwrap();
        assert_eq!(read(&t, T0, &mut cache).len(), c.received.len());
        writeln!(f).unwrap();
        let v = read(&t, T0, &mut cache);
        assert_eq!(v.len(), c.received.len() + 1);
        assert_eq!(v.last().unwrap()["at"], T0 + 300_000);
        // 窓から外れたものは返さない
        let v = read(&t, T0 + 150_000, &mut cache);
        assert_eq!(v.iter().map(|r| r["at"].as_u64().unwrap()).collect::<Vec<_>>(), vec![T0 + 180_200, T0 + 300_000]);
    }

    #[test]
    fn first_read_takes_only_the_tail() {
        let dir = tmp("received-tail");
        let p = dir.join("big.jsonl");
        let old = json!({"type":"user","timestamp":"2026-11-23T01:00:00.000Z","message":{"content":"<teammate-message teammate_id=\"team-lead\">\n古い\n</teammate-message>"}});
        let new = json!({"type":"user","timestamp":"2026-11-23T01:00:01.000Z","message":{"content":"<teammate-message teammate_id=\"team-lead\">\n新しい\n</teammate-message>"}});
        let pad = json!({"type":"assistant","message":{"content":[{"type":"text","text":"x".repeat(500)}]}});
        write(&p, &format!("{old}\n{pad}\n{new}\n"));
        let t = vec![("me".to_string(), p)];
        // 末尾 300 バイトだけ読むと、古い行と、途中から始まる pad の行は読まない
        let v = read_with(&t, 0, &mut Cache::new(), 300);
        assert_eq!(v.iter().map(|r| r["at"].as_u64().unwrap()).collect::<Vec<_>>(), vec![T0 + 1000]);
    }

    #[test]
    fn targets_are_teammates_subagents_and_their_parents() {
        let rows = vec![
            json!({"id":"lead","kind":"interactive","native":{"jsonl":"/l.jsonl"}}),
            json!({"id":"bob","kind":"teammate","native":{"jsonl":"/b.jsonl","parentId":"lead"}}),
            json!({"id":"lone","kind":"interactive","native":{"jsonl":"/x.jsonl"}}),
            json!({"id":"app","kind":"terminal"}),
        ];
        assert_eq!(targets(&rows), vec![("lead".to_string(), PathBuf::from("/l.jsonl")), ("bob".to_string(), PathBuf::from("/b.jsonl"))]);
    }

    #[test]
    fn iso_to_ms() {
        assert_eq!(iso_ms("2026-11-23T01:00:00.000Z"), Some(T0));
        assert_eq!(iso_ms("2026-11-23T01:00:01.5Z"), Some(T0 + 1500));
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2024-02-29T12:34:56.789Z"), Some(1_709_210_096_789));
        assert_eq!(iso_ms("x"), None);
    }
}
