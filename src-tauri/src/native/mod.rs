// ccn を通さずに、この機械の Claude Code の記録（~/.claude）から町の一覧と会話を読む（#96、#90 の案A の段1）。
// 読むだけで、~/.claude の下には書かない。
// - sessions.rs   生きている対話セッション（sessions/<pid>.json）と、その jsonl の場所、from 行の親
// - subagents.rs  セッションの下の sub-agent と teammate（<sid>/subagents/ の jsonl と meta.json）
// - conv.rs       jsonl を読み位置（バイト）から読み、lib.rs の simplify に渡せる行に整える
// 置き場所は FC_CLAUDE_HOME で差し替えられる（試験と、合成の木での確認に使う）。
//
// ここで作る一覧の1件は、ccn の GET /sessions の1件と同じ形（id、kind、state、cwd、pid、startedAt、lastActivityAt、
// parent、capabilities、title）にして、lib.rs の agents_from がそのまま画面の形に直す。ネイティブだけの項目は native に入れる。

pub mod conv;
pub mod sessions;
pub mod subagents;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Claude Code の記録の置き場所。FC_CLAUDE_HOME があればそこ、無ければ ~/.claude
pub fn claude_home() -> PathBuf {
    match std::env::var("FC_CLAUDE_HOME") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into())).join(".claude"),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// ネイティブの記録から読むものは、送信、承認、割り込み、停止、端末ができない（段1は読むだけ）
pub fn read_only_caps() -> Value {
    json!({ "send": false, "permissions": false, "interrupt": false, "stop": false, "terminal": false, "events": false })
}

/// 一覧を作った結果。agents は ccn の一覧と同じ形の行。stats は報告と画面の確認用の件数
#[derive(Default, Debug)]
pub struct NativeList {
    pub sessions: Vec<Value>,
    pub subagents: Vec<Value>,
    pub stats: Stats,
}

/// 一覧を作ったときの件数。想定外の形は黙って落とさず、ここに数える
#[derive(Default, Debug, Clone, serde::Serialize, PartialEq)]
pub struct Stats {
    /// sessions/ の json の数、生きていた数、裏方の -p として外した数
    pub session_files: usize,
    pub live: usize,
    pub headless: usize,
    /// jsonl が規則の場所に無く、projects/*/ を探して見つけた数と、見つからなかった数
    pub jsonl_searched: usize,
    pub jsonl_missing: usize,
    /// sub-agent の数（全部、出した数、畳んだ数、上限で落とした数、meta.json が無かった数）
    pub sub_total: usize,
    pub sub_shown: usize,
    pub sub_folded: usize,
    pub sub_capped: usize,
    pub sub_no_meta: usize,
    /// 想定外の形（読めない json、知らない kind や status など）。種類ごとの件数
    pub unexpected: HashMap<String, usize>,
    /// 作るのにかかった時間（ms）
    pub ms: u64,
}

impl Stats {
    pub fn odd(&mut self, what: impl Into<String>) {
        *self.unexpected.entry(what.into()).or_default() += 1;
    }
}

/// 会話を読む先の登録。一覧を作るたびに、画面に出したネイティブの id（ccn に同じ id が無いもの）と jsonl の場所を入れ直す。
/// conversation と操作の命令は、ここに id があるかでネイティブかを決める
static PATHS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

pub fn register(paths: HashMap<String, PathBuf>) {
    *PATHS.lock().unwrap_or_else(|e| e.into_inner()) = Some(paths);
}

/// ネイティブの id なら jsonl の場所
pub fn path_of(id: &str) -> Option<PathBuf> {
    PATHS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(id).cloned())
}

/// 操作の命令で、ネイティブの id を断るときの文
pub const READ_ONLY: &str = "このセッションは Claude Code の記録から読んでいるだけなので、Claude Town からは操作できない（ccn を通っていない。端末で操作して）";

pub fn refuse_if_native(id: &str) -> Result<(), String> {
    if path_of(id).is_some() { Err(READ_ONLY.into()) } else { Ok(()) }
}

/// 一覧を作る。生きているセッションと、その下の sub-agent
pub fn list(root: &Path, now: u64) -> NativeList {
    let t0 = std::time::Instant::now();
    let mut stats = Stats::default();
    let live = sessions::live(root, &mut stats);
    let mut out = NativeList::default();
    for s in &live {
        out.subagents.extend(subagents::of_session(s, now, &mut stats));
        out.sessions.push(s.to_row());
    }
    stats.ms = t0.elapsed().as_millis() as u64;
    out.stats = stats;
    out
}

/// 一覧の行から、会話を読む先（id → jsonl）を作る
pub fn paths_of(rows: &[&Value]) -> HashMap<String, PathBuf> {
    rows.iter()
        .filter_map(|r| Some((r["id"].as_str()?.to_string(), PathBuf::from(r["native"]["jsonl"].as_str()?))))
        .collect()
}

#[cfg(test)]
pub mod testtree {
    // 試験用の合成の ~/.claude。本人の記録は使わない
    use std::fs;
    use std::path::{Path, PathBuf};

    pub fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fc-native-{name}-{}-{}", std::process::id(), fastrand::u64(..)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    pub fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    /// 生きている pid（試験のプロセス自身）で sessions/<pid>.json を書く
    pub fn session(root: &Path, sid: &str, cwd: &str, status: &str) {
        let pid = std::process::id();
        write(&root.join(format!("sessions/{pid}.json")), &serde_json::json!({
            "pid": pid, "sessionId": sid, "cwd": cwd, "startedAt": 1_000u64, "kind": "interactive", "entrypoint": "cli",
            "status": status, "updatedAt": 2_000u64, "name": "合成"
        }).to_string());
    }

    pub fn enc(cwd: &str) -> String {
        super::sessions::project_dir_name(cwd)
    }
}
