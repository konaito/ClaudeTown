// この機械の Claude Code の記録（~/.claude）から町の一覧と会話を読む（#96 で入れ、ccn を外してからは唯一の読み方）。
// 読むだけで、~/.claude の下には書かない。
// - sessions.rs   生きている対話セッション（sessions/<pid>.json）と、その jsonl の場所、from 行の親
// - subagents.rs  セッションの下の sub-agent と in-process のチームメイト（<sid>/subagents/ の jsonl と meta.json）
// - teams.rs      tmux のチームメイト（teams/<チーム名>/config.json と、ps の引数）
// - conv.rs       jsonl を読み位置（バイト）から読み、lib.rs の simplify に渡せる行に整える
// 置き場所は FC_CLAUDE_HOME で差し替えられる（試験と、合成の木での確認に使う）。
//
// 一覧の1件の形は id、kind、state、cwd、pid、startedAt、lastActivityAt、parent、capabilities、title。
// lib.rs の agents_from が画面の形に直す。記録から読んだ項目は native に入れる。

pub mod conv;
pub mod received;
pub mod sessions;
pub mod subagents;
pub mod teams;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[cfg(test)]
thread_local! {
    /// 試験のスレッドごとの置き場所（環境変数は試験の間で共有されるので使わない）
    pub static TEST_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Claude Code の記録の置き場所。FC_CLAUDE_HOME があればそこ、無ければ ~/.claude
pub fn claude_home() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_HOME.with(|h| h.borrow().clone()) {
        return p;
    }
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

/// 記録から読むだけのセッションは、送信、承認、割り込み、停止、端末ができない（このアプリが立てたものは lib.rs が上書きする）
pub fn read_only_caps() -> Value {
    caps_with_send(false)
}

/// 受信ソケットのある対話セッションは、文の送信だけできる（#156）。割り込みは外から入れる口が無い
/// （pid への SIGINT はセッションの終了になる。#90 の実測）
pub fn caps_with_send(send: bool) -> Value {
    json!({ "send": send, "permissions": false, "interrupt": false, "stop": false, "terminal": false, "events": false })
}

/// 一覧を作った結果。stats は報告と画面の確認用の件数
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
    /// tmux のチームメイト（出した数、プロセスが無かった数、jsonl が見つからなかった数）
    pub team_shown: usize,
    pub team_gone: usize,
    pub team_no_jsonl: usize,
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

/// 会話を読む先の登録。一覧を作るたびに、画面に出した id と jsonl の場所を入れ直す
static PATHS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

pub fn register(paths: HashMap<String, PathBuf>) {
    *PATHS.lock().unwrap_or_else(|e| e.into_inner()) = Some(paths);
}

/// id の jsonl の場所
pub fn path_of(id: &str) -> Option<PathBuf> {
    PATHS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(id).cloned())
}

/// 操作の命令で、このアプリが立てていないセッションを断るときの文
pub const READ_ONLY: &str = "このセッションは Claude Town の外で起動したもので、Claude Code の記録から読んでいるだけなので、ここからは操作できない。起動した端末で操作して";

/// 一覧を作る。生きているセッションと、その下の sub-agent とチームメイト
pub fn list(root: &Path, now: u64) -> NativeList {
    let t0 = std::time::Instant::now();
    let mut stats = Stats::default();
    let live = sessions::live(root, &mut stats);
    let mut out = NativeList::default();
    // tmux のチームメイトは sessions/<pid>.json を作らない（2回の実測）。もし作る版が来たら、同じ id のセッションの行は
    // 親の分かるチームメイトの行で置き換える
    let mates = teams::tmux_rows(root, &live, now, &mut stats);
    let mate_ids: std::collections::HashSet<&str> = mates.iter().filter_map(|r| r["id"].as_str()).collect();
    for s in &live {
        out.subagents.extend(subagents::of_session(s, now, &mut stats));
        if !mate_ids.contains(s.id.as_str()) {
            out.sessions.push(s.to_row());
        }
    }
    out.subagents.extend(mates);
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
