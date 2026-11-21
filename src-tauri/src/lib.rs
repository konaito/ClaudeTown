// family-computing の裏側。画面から呼ばれる命令:
// - snapshot(peer): ccn の一覧（状態、送信先、親子）、hook の報告、close-check の判定を1つにまとめる
// - peers: ccn につながっている機械の一覧
// - conversation(session_id, peer, since): ccn の messages を差分で読み、画面に出す形（発言と道具の1行）に縮め、画面がまだ持っていない分だけ返す
// - send_message(session_id, text, peer): ccn の POST /api/sessions/<id>/messages で文を届ける
// - create_session / stop_session / teleport / teleport_info / session_detail: ccn の口をそのまま呼ぶ
// - term_open / term_close / term_input / term_resize: ccn の端末（PTY）の口を読み書きし、開いた画面の Channel へ流す
// - prompt_history / slash_commands / file_suggestions / send_direct / interrupt_session: チャットの入力欄を CLI と同じ動きにする（composer.rs）
// - session_controls / configure_session / run_command: チャット欄からモデルと権限モードを替え、組み込みコマンドを送る（composer.rs、#97）
// HTTP を待つ命令は spawn_blocking で動かし、メインスレッドを止めない（下の「画面から呼ぶ命令」）
//
// ccn は Origin 付きの要求を CSRF として断るので、HTTP は必ずこちら（webview ではなく Rust）から出す。
// 別の機械（peer）は手元のノードの中継 /n/<peer>/api/... を通す。

mod attach;
mod ccn;
mod avatars;
mod composer;
mod naming;
mod repo;
mod native;
mod offline;
mod perf;
use perf::*;
mod conversation;
use conversation::*;
mod permission;
use permission::*;
mod session_ops;
use session_ops::*;
mod terminal;
use terminal::*;
mod watch;
use watch::*;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 非常停止。~/.family-computing/send-disabled があると、アプリからの送信（注文と承認のキー）を全部断る。
/// `touch ~/.family-computing/send-disabled` で止め、消せば戻る（アプリの再起動は要らない）
fn send_disabled() -> bool {
    fc_path(Scope::Shared, "send-disabled").exists()
}
const KEEP_MESSAGES: usize = 80;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// ---------- 状態ファイルの置き場所（#23） ----------

/// 安定版の identifier（tauri.stable.conf.json と同じ値）
const STABLE_ID: &str = "jp.fybe.family-computing";
/// このバイナリの identifier。run() の最初に、ビルド時の設定（generate_context）から入れる
static APP_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// どちらの置き場所に置くか
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scope {
    /// 両版で同じもの。hook が書くもの（state/、letters.jsonl）と、非常停止（send-disabled）。houses.json も hook が書くので、共有側にもある
    Shared,
    /// アプリが書くもの（avatars*.json、houses.json）。安定版は共有と同じ場所、開発版は dev/ の下
    App,
}

/// ~/.family-computing の下のファイルの置き場所を決める。Rust で置き場所を組み立てるのはここだけにする
fn fc_path(scope: Scope, name: &str) -> PathBuf {
    place(&home(), APP_ID.get().map(String::as_str), std::env::var("FC_APP_HOME").ok().filter(|s| !s.is_empty()), scope, name)
}

/// fc_path の中身（試験のために環境から切り離してある）。
/// App は、FC_APP_HOME があればそこ、identifier が安定版の値か分からないときは ~/.family-computing、それ以外（開発版）は ~/.family-computing/dev。
/// 分からないときに安定版と同じ場所へ落とすのは、逆にすると安定版が割り当てと世帯の名前を見失うため
fn place(home: &std::path::Path, app_id: Option<&str>, app_home: Option<String>, scope: Scope, name: &str) -> PathBuf {
    let shared = home.join(".family-computing");
    let dir = match scope {
        Scope::Shared => shared,
        Scope::App => match (app_home, app_id) {
            (Some(h), _) => PathBuf::from(h),
            (None, Some(id)) if id != STABLE_ID => shared.join("dev"),
            _ => shared,
        },
    };
    dir.join(name)
}

/// オフラインのキャッシュの置き場所（src-tauri/src/offline.rs）。開発版と安定版で分かれる
fn cache_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_CACHE.with(|c| c.borrow().clone()) {
        return p;
    }
    fc_path(Scope::App, "cache")
}

#[cfg(test)]
thread_local! {
    /// 試験のスレッドごとの会話の保存先（本物の ~/.family-computing に書かない）
    static TEST_CACHE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn read_json(p: &PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// ファイルが前に読んだときと同じか（#11）。更新時刻、大きさ、inode で見る。読む前に stat だけする
#[derive(Clone, Copy, PartialEq, Debug)]
struct FileStamp { modified: Option<std::time::SystemTime>, len: u64, ino: u64 }
fn stamp_of(meta: &fs::Metadata) -> FileStamp {
    use std::os::unix::fs::MetadataExt;
    FileStamp { modified: meta.modified().ok(), len: meta.len(), ino: meta.ino() }
}

/// read_json と同じ中身を返す。前に読んだときから更新時刻、大きさ、inode のどれも変わっていなければ、読まずに覚えた中身を返す（#11）。
/// snapshot は一覧を取るたびに、セッションごとの state/{id}.json と close-check/{id}.json、houses.json、ccn.json を読んでいた。
/// 無いファイルは覚えない（できたら次の回に読む）
fn read_json_cached(p: &std::path::Path) -> Option<Value> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, (FileStamp, Option<Value>)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(meta) = fs::metadata(p) else {
        cache.lock().unwrap_or_else(|e| e.into_inner()).remove(p);
        return None;
    };
    let st = stamp_of(&meta);
    if let Some((s, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(p) {
        if *s == st && st.modified.is_some() {
            return v.clone();
        }
    }
    let v = read_json(&p.to_path_buf());
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(p.to_path_buf(), (st, v.clone()));
    v
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[derive(Serialize)]
struct Snapshot {
    ccn: String,
    peer: Option<String>,
    ccn_ok: bool,
    ccn_error: Option<String>,
    agents: Vec<Value>,
    /// お手紙（セッションどうしのやり取り）の最近の記録。hook が ~/.family-computing/letters.jsonl に書く。この機械の町だけ
    letters: Vec<Value>,
    fetched_at: u128,
    /// 一覧を読めず、保存してあった一覧（offline.rs）を agents に入れたときの、保存した時刻（ms）
    cached_at: Option<u64>,
    /// 一覧の出どころ（#96）。この機械の町だけ。ccn は on、off（設定で切った）、つながらなかった理由。native は件数
    sources: Option<Value>,
}

// ---------- ccn を使うかの設定（#96） ----------
// 既定は使う（ネイティブの一覧に、ccn に接続できるときだけ ccn の一覧を重ねる）。切ると ccn の一覧を読まない。
// 読むのは Rust の見張りのスレッドなので、アプリ側の置き場所（開発版は dev/ の下）のファイルに置く。形は {"ccn": true|false}

const SETTINGS_FILE: &str = "town-settings.json";
/// 0 はまだ読んでいない、1 は使う、2 は使わない
static CCN_USE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn ccn_use() -> bool {
    match CCN_USE.load(Ordering::SeqCst) {
        1 => true,
        2 => false,
        _ => {
            let on = read_json(&fc_path(Scope::App, SETTINGS_FILE)).and_then(|v| v["ccn"].as_bool()).unwrap_or(true);
            CCN_USE.store(if on { 1 } else { 2 }, Ordering::SeqCst);
            on
        }
    }
}

#[tauri::command]
fn town_settings() -> Value {
    json!({ "ccn": ccn_use() })
}

#[tauri::command]
fn set_town_settings(ccn: bool) -> Result<Value, String> {
    let p = fc_path(Scope::App, SETTINGS_FILE);
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    fs::write(&p, json!({ "ccn": ccn }).to_string()).map_err(|e| format!("設定を保存できなかった: {e}"))?;
    CCN_USE.store(if ccn { 1 } else { 2 }, Ordering::SeqCst);
    town_kick();
    Ok(town_settings())
}

/// 設定で ccn を切ったときの、ccn の一覧の代わりの理由
const CCN_OFF: &str = "ccn を使わない設定";

/// ネイティブの記録から読んでいるだけのセッションへの操作を断る（この機械の町だけ）
fn native_guard(session_id: &str, peer: &Option<String>) -> Result<(), String> {
    if peer.as_deref().unwrap_or("").is_empty() { native::refuse_if_native(session_id) } else { Ok(()) }
}

/// お手紙の記録のうち、直近 LETTERS_WINDOW_MS のものを古い順に返す（多くても LETTERS_MAX 件）
const LETTERS_WINDOW_MS: u128 = 10 * 60 * 1000;
const LETTERS_MAX: usize = 300;
fn recent_letters() -> Vec<Value> {
    static TAIL: Mutex<Option<LetterTail>> = Mutex::new(None);
    let mut tail = TAIL.lock().unwrap_or_else(|e| e.into_inner());
    letters_from(&fc_path(Scope::Shared, "letters.jsonl"), now_ms(), &mut tail)
}

/// letters.jsonl の、前回までに読んだところ（#11）。2秒ごとに最大 1MB を頭から読み直していたのをやめ、増えた分だけ読む
struct LetterTail {
    stamp: FileStamp,
    /// ここまで読んだ（改行で終わる行の末尾）バイト位置
    offset: u64,
    /// 読んだ記録のうち、まだ窓（LETTERS_WINDOW_MS）に入りうるもの。ファイルの順
    recs: Vec<Value>,
}

/// recent_letters の中身（試験のために置き場所と時刻を受け取る）。返すものは、ファイルを頭から読んでいた前の形と同じ:
/// 末尾から、時刻が窓に入る行が続く間だけ取り、新しいほうから LETTERS_MAX 件を古い順に返す
fn letters_from(path: &std::path::Path, now: u128, tail: &mut Option<LetterTail>) -> Vec<Value> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(meta) = fs::metadata(path) else { *tail = None; return vec![] };
    let st = stamp_of(&meta);
    // 同じファイル（inode）が後ろに伸びただけなら、続きから読む。小さくなった、入れ替わった（1MB で .1 に移した）なら頭から
    let from = match tail.as_ref() {
        Some(t) if t.stamp == st => None,
        Some(t) if t.stamp.ino == st.ino && st.len >= t.offset => Some(t.offset),
        _ => Some(0),
    };
    if let Some(from) = from {
        let mut buf = Vec::new();
        let ok = fs::File::open(path).and_then(|mut f| { f.seek(SeekFrom::Start(from))?; f.read_to_end(&mut buf) }).is_ok();
        if !ok { *tail = None; return vec![] }
        // 書きかけの最後の行（改行が無い）は、次の回に読む
        let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        let mut recs = if from == 0 { vec![] } else { tail.take().map(|t| t.recs).unwrap_or_default() };
        recs.extend(String::from_utf8_lossy(&buf[..end]).lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()));
        *tail = Some(LetterTail { stamp: st, offset: from + end as u64, recs });
    }
    let since = now.saturating_sub(LETTERS_WINDOW_MS);
    let in_window = |v: &Value| v["at"].as_u64().map(|a| a as u128 >= since).unwrap_or(false);
    let t = tail.as_mut().expect("上で入れた");
    // 窓から外れた行より前は、時刻が進んでも二度と返さないので捨てる（末尾から続く間だけ取る、という前の形と同じになる）
    if let Some(i) = t.recs.iter().rposition(|v| !in_window(v)) {
        t.recs.drain(..=i);
    }
    let n = t.recs.len();
    t.recs[n.saturating_sub(LETTERS_MAX)..].to_vec()
}

/// ccn の peers。手元のノードは peers を Cloudflare の API から引くので、ネットが切れると失敗する。
/// 読めたら保存し、読めなければ保存した一覧を返す（別の機械の status は "cached" にして、裏で取りに行かせない）
fn peers() -> Result<Value, String> {
    let file = offline::peers_file(&cache_dir());
    match ccn::peers() {
        Ok(v) => {
            if v.as_array().is_some_and(|a| !a.is_empty()) && offline::read(&file).map(|c| c["peers"] != v).unwrap_or(true) {
                let _ = offline::write(&file, json!({ "peers": v }));
            }
            Ok(v)
        }
        Err(e) => match offline::read(&file).and_then(|c| c["peers"].as_array().cloned()) {
            Some(list) => Ok(Value::Array(list.into_iter().map(|mut p| {
                if p["self"] != json!(true) {
                    p["status"] = json!("cached");
                }
                p
            }).collect())),
            None => Err(e),
        },
    }
}

/// 顔ぶれが同じまま中身だけ変わったときに、前の書き込みから空ける時間。
/// 動いているセッションがあると report の doing などが取るたびに変わるので、毎回は書かない
const TOWN_SAVE_GAP_MS: u128 = 30_000;

/// 町ごとの、前回保存した一覧の鍵と顔ぶれと時刻
struct TownSaved {
    key: u64,
    ids: Vec<String>,
    at: u128,
}
static TOWN_SAVED: Mutex<Option<HashMap<String, Option<TownSaved>>>> = Mutex::new(None);

/// 保存した一覧と同じかを比べる鍵。agents を JSON にしたもののハッシュ（保存した時刻の savedAt は agents の外にあるので入らない）
fn town_key(agents: &[Value]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(agents).unwrap_or_default().hash(&mut h);
    h.finish()
}

fn town_ids(agents: &[Value]) -> Vec<String> {
    agents.iter().filter_map(|a| a["id"].as_str().map(String::from)).collect()
}

fn save_town(peer: &Option<String>, agents: &[Value]) {
    let mut g = TOWN_SAVED.lock().unwrap_or_else(|e| e.into_inner());
    let prev = g.get_or_insert_with(HashMap::new).entry(offline::town(peer)).or_insert(None);
    save_town_to(&offline::town_file(&cache_dir(), peer), agents, now_ms(), prev);
}

/// save_town の中身（試験のために置き場所、時刻、前回の記録を受け取る）。書いたら true。
/// 中身が前回保存と同じなら書かない。顔ぶれが同じで中身だけ変わったときは、前の書き込みから TOWN_SAVE_GAP_MS 空ける
/// （空けている間に変わった分は、間隔が過ぎた後の回で書く）。前回の記録が無い（起動直後）ときは、保存してあるファイルと比べる
fn save_town_to(file: &std::path::Path, agents: &[Value], now: u128, prev: &mut Option<TownSaved>) -> bool {
    if prev.is_none() {
        *prev = offline::read(file).map(|c| {
            let saved = c["agents"].as_array().cloned().unwrap_or_default();
            TownSaved { key: town_key(&saved), ids: town_ids(&saved), at: c["savedAt"].as_u64().unwrap_or(0) as u128 }
        });
    }
    let key = town_key(agents);
    let ids = town_ids(agents);
    if let Some(p) = prev.as_ref() {
        if p.key == key || (p.ids == ids && now.saturating_sub(p.at) < TOWN_SAVE_GAP_MS) {
            return false;
        }
    }
    // 書けたときだけ覚える（書けなかったら、次の回にまた書く）
    if offline::write(file, json!({ "agents": agents })).is_err() {
        return false;
    }
    *prev = Some(TownSaved { key, ids, at: now });
    true
}

/// ccn の一覧を、画面に渡すセッションの形に直す。読めなければ（空の一覧, 理由）。
/// この機械の町（peer が None）だけ、hook の報告と close-check の判定を足す。キャラの割り当ては足さない
fn fetch_agents(peer: &Option<String>) -> (Vec<Value>, Option<String>) {
    agents_from(peer, list_sessions(peer))
}

/// ccn の一覧（GET /sessions）。読めなければ理由
fn list_sessions(peer: &Option<String>) -> Result<Vec<Value>, String> {
    match ccn::sessions(peer) {
        Ok(Value::Array(v)) => Ok(v),
        Ok(_) => Err("一覧の形が想定と違う".into()),
        Err(e) => Err(e),
    }
}

/// ccn の一覧を、画面に渡すセッションの形に直す（fetch_agents の中身）。一覧は GET /sessions でも、一覧の SSE（#5）でもよい
fn agents_from(peer: &Option<String>, got: Result<Vec<Value>, String>) -> (Vec<Value>, Option<String>) {
    let local = peer.is_none();
    let (sessions, mut ccn_error) = match got {
        // 設定で ccn を切ったら、SSE で受けた一覧が残っていても使わない
        Ok(_) if local && !ccn_use() => (vec![], Some(CCN_OFF.to_string())),
        Ok(v) => (v, None),
        Err(e) => (vec![], Some(e)),
    };
    let mut live: Vec<&Value> = sessions
        .iter()
        .filter(|s| s.get("state").and_then(|x| x.as_str()) != Some("exited"))
        .collect();
    // この機械の町は、ネイティブの記録（~/.claude）の一覧を重ねる（#96）。同じ sessionId が ccn にもあれば ccn の行を使う。
    // ccn の行は、送信や承認の口（capabilities）、from 行の親、アカウントを持つ。ネイティブからは、ccn に無いセッションと sub-agent を足す
    let native_rows: Vec<Value> = if local {
        let n = native::list(&native::claude_home(), native::now_ms());
        let ccn_ids: HashSet<&str> = live.iter().filter_map(|s| s["id"].as_str()).collect();
        let rows: Vec<Value> = n.sessions.into_iter().filter(|r| !r["id"].as_str().is_some_and(|id| ccn_ids.contains(id))).chain(n.subagents).collect();
        native::register(native::paths_of(&rows.iter().collect::<Vec<_>>()));
        let mut odd = n.stats.unexpected.clone();
        for (k, v) in native::conv::odd_counts() {
            *odd.entry(k).or_default() += v;
        }
        let mut st = serde_json::to_value(&n.stats).unwrap_or(Value::Null);
        st["unexpected"] = json!(odd);
        // 時間は毎回変わるので、一覧が変わったかの比べ（snapshot_key）に入れない
        if let Some(o) = st.as_object_mut() {
            o.remove("ms");
        }
        *LAST_SOURCES.lock().unwrap_or_else(|e| e.into_inner()) = Some(json!({
            "ccn": match &ccn_error { None => "on".to_string(), Some(e) if e == CCN_OFF => "off".to_string(), Some(e) => e.clone() },
            "native": st,
        }));
        // ccn につながらなくても、ネイティブの一覧は読めているので、町は読めたものとして扱う（保存した一覧に差し替えない）
        ccn_error = None;
        rows
    } else {
        vec![]
    };
    live.extend(native_rows.iter());
    let live_ids: HashSet<String> = live.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();

    // ccn の parent は from 行の呼び手（"agent:<ノード>/<sid8>/<役割>"）
    let parent_from_ccn = |s: &Value| -> Option<String> {
        let p = s["parent"].as_str()?;
        let sid8 = p.strip_prefix("agent:")?.split('/').nth(1)?;
        live_ids.iter().find(|id| id.starts_with(sid8)).cloned()
    };

    // 名前は、そのセッションが作業しているプロジェクトの名前（src-tauri/src/naming.rs）。
    // .git を読むのはこの機械の町だけ。別の機械の cwd はパスの形だけで決める
    let whos: Vec<naming::Who> = live.iter().map(|s| {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let cwd = s["cwd"].as_str().filter(|c| !c.is_empty());
        naming::Who {
            cwd: cwd.map(String::from),
            title: s["title"].as_str().map(String::from),
            project: cwd.and_then(|c| naming::project_of(c, local)),
            id,
        }
    }).collect();
    let name_of = naming::card_names(&whos);
    let project_of: HashMap<&str, Option<&String>> = whos.iter().map(|w| (w.id.as_str(), w.project.as_ref())).collect();
    let mut agents = vec![];
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        // 親は ccn の parent（from 行の呼び手）から引く。sub-agent は置き場所で決めた親（#96）。親が生きていなければ根として扱う
        let native_parent = s["native"]["parentId"].as_str().filter(|p| live_ids.contains(*p)).map(String::from);
        let parent = native_parent.or_else(|| parent_from_ccn(s)).filter(|p| *p != id);
        let sub = s["kind"] == "subagent";
        let (report, close_check) = if sub {
            // sub-agent の様子は hook の報告ではなく、meta.json の説明と jsonl の末尾から作る（hook の報告は親のセッションの分しか無い）
            (Some(s["native"]["report"].clone()), None)
        } else if peer.is_none() {
            (
                read_json_cached(&fc_path(Scope::Shared, &format!("state/{id}.json"))),
                read_json_cached(&home().join(format!(".claude/close-check/{id}.json"))),
            )
        } else {
            (None, None)
        };
        agents.push(json!({
            "id": id,
            // sub-agent は、親と同じプロジェクトの名前になって見分けられないので、teammate の名前か種類（Explore など）にする
            "name": if sub { s["title"].clone() } else { json!(name_of.get(&id)) },
            // 一覧の出どころ（#96）。native は Claude Code の記録から読んでいるだけで、操作はできない
            "source": if s.get("native").is_some() { "native" } else { "ccn" },
            // cwd のプロジェクトの名前（worktree なら本体の名前）。振り分けの場所でも cwd の分を入れる
            "project": project_of.get(id.as_str()).copied().flatten(),
            "kind": s["kind"],
            "state": s["state"],
            "cwd": s["cwd"],
            "pid": s["pid"],
            "startedAt": s["startedAt"],
            "lastActivityAt": s["lastActivityAt"],
            "canSend": s["capabilities"]["send"],
            "parent": parent,
            // ccn の parent の生の値。別の町にいる親を引くのに使う（src/ghost.ts）
            "parentRaw": s["parent"],
            "capabilities": s["capabilities"],
            // どのアカウントで動いているか（cam のコマンド名と email）。ccn の PR #56 から載る。古い ccn と、選べなかったセッションでは null
            "account": s["account"],
            "accountEmail": s["accountEmail"],
            "report": report,
            // status が ok/ng なら short は直下、working/checking なら前回の判定が last に入っている
            "closeCheck": close_check.map(|c| json!({
                "status": c["status"],
                "short": if c["short"].is_string() { c["short"].clone() } else { c["last"]["short"].clone() },
            })),
        }));
    }
    (agents, ccn_error)
}

/// 最後に作ったこの機械の町の一覧の出どころ（Snapshot の sources）
static LAST_SOURCES: Mutex<Option<Value>> = Mutex::new(None);

fn snapshot(peer: Option<String>) -> Snapshot {
    let peer = peer.filter(|p| !p.is_empty());
    // 設定で ccn を切ったら、ccn に一覧を取りに行かない
    let got = if peer.is_none() && !ccn_use() { Err(CCN_OFF.to_string()) } else { list_sessions(&peer) };
    snapshot_from(peer, got)
}

/// 受け取った一覧から、画面に渡す町の形を作る。キャラの割り当て、状態ファイル、お手紙はここで足す
fn snapshot_from(peer: Option<String>, got: Result<Vec<Value>, String>) -> Snapshot {
    let (mut agents, ccn_error) = agents_from(&peer, got);
    // キャラの絵の割り当て。世代（親をたどった深さ）に合う見た目を重み付きの乱数で選び、保存して以後変えない。
    // 別の機械の町も、機械ごとのファイルに保存する（乱数なので、保存しないと読むたびに顔が変わる）
    let mut order: Vec<&Value> = agents.iter().collect();
    order.sort_by(|a, b| a["startedAt"].as_u64().unwrap_or(0).cmp(&b["startedAt"].as_u64().unwrap_or(0)).then(a["id"].as_str().cmp(&b["id"].as_str())));
    let parent_of: HashMap<String, Option<String>> = agents.iter()
        .map(|a| (a["id"].as_str().unwrap_or_default().to_string(), a["parent"].as_str().map(String::from)))
        .collect();
    let depth = avatars::depths(&parent_of);
    let live: Vec<(String, u32)> = order.iter().map(|a| {
        let id = a["id"].as_str().unwrap_or_default().to_string();
        let d = depth.get(&id).copied().unwrap_or(0);
        (id, d)
    }).collect();
    let path = avatars_path(&peer);
    let next = {
        // 読む、決める、書くの間に、同じアプリの別の snapshot が割り込まないようにする
        let _guard = AVATARS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (prev, mut recent) = avatars::load(&path);
        let before = recent.clone();
        let next = avatars::assign(&prev, &mut recent, &live, &mut fastrand::Rng::new());
        // 一覧を読めなかったときは、全員がいなくなったように見えるので書かない
        if ccn_error.is_none() && (next != prev || recent != before) {
            avatars::save(&path, &next, &recent);
        }
        next
    };
    for a in agents.iter_mut() {
        if let Some(v) = a["id"].as_str().and_then(|id| next.get(id)) {
            a["avatar"] = json!({ "char": v.char, "hue": v.hue });
        }
    }
    let letters = if peer.is_none() { recent_letters() } else { vec![] };
    // 読めたら町の一覧を保存する。読めなければ保存した一覧を出す（ネットが切れて起動しても、世帯を選んで会話の保存を見られる）
    let mut cached_at = None;
    if ccn_error.is_none() {
        save_town(&peer, &agents);
    } else if let Some(c) = offline::read(&offline::town_file(&cache_dir(), &peer)) {
        agents = c["agents"].as_array().cloned().unwrap_or_default();
        cached_at = c["savedAt"].as_u64();
    }
    let sources = if peer.is_none() { LAST_SOURCES.lock().unwrap_or_else(|e| e.into_inner()).clone() } else { None };
    Snapshot { ccn: ccn::base(), peer, ccn_ok: ccn_error.is_none(), ccn_error, agents, letters, fetched_at: now_ms(), cached_at, sources }
}

static AVATARS_LOCK: Mutex<()> = Mutex::new(());

/// 別の町（いま見ていない町）のセッションの一覧（#14）。お便りと転出のゴーストにだけ使う。
/// snapshot と違い、キャラを割り当てず保存もしない（前に割り当てた分を読むだけ）。お手紙の記録も読まない。
/// まだ割り当てていないセッションは avatar が無く、画面は ID から決まる仮の顔を出す。その町を開いたときに snapshot が割り当てる
fn town_agents(peer: Option<String>) -> Result<Vec<Value>, String> {
    let peer = peer.filter(|p| !p.is_empty());
    let (mut agents, err) = fetch_agents(&peer);
    if let Some(e) = err {
        return Err(e);
    }
    let (assigned, _) = avatars::load(&avatars_path(&peer));
    for a in agents.iter_mut() {
        if let Some(v) = a["id"].as_str().and_then(|id| assigned.get(id)) {
            a["avatar"] = json!({ "char": v.char, "hue": v.hue });
        }
    }
    Ok(agents)
}

/// キャラの割り当ての保存先。FC_AVATARS で差し替えられる（モックの ccn で試すとき、本物の割り当てを消さないため）。
/// 別の機械の町は、同じ場所の avatars-peer-<機械>.json に分けて置く
/// FC_CCN_URL で別のノード（モックなど）に向けたのに FC_AVATARS が無いときは、avatars-custom-ccn.json に分ける。
/// 本物の avatars.json を使うと、モックにいない本物のセッションの割り当てが全部消える（乱数なので元に戻らない）。
/// 直近の記録（avatars-recent.json）は、同じ場所に avatars::recent_path が組み立てる。開発版はどれも dev/ の下になる
fn avatars_path(peer: &Option<String>) -> PathBuf {
    let default = if std::env::var("FC_CCN_URL").is_ok() { "avatars-custom-ccn.json" } else { "avatars.json" };
    let base = std::env::var("FC_AVATARS").map(PathBuf::from).unwrap_or_else(|_| fc_path(Scope::App, default));
    match peer {
        None => base,
        Some(p) => {
            let safe: String = p.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            base.with_file_name(format!("avatars-peer-{safe}.json"))
        }
    }
}

// ---------- 画面から呼ぶ命令（#3） ----------
// async の付かない命令は Tauri のメインスレッドで動く（Tauri 2 の説明「Calling Rust from the Frontend」:
// "Commands without the async keyword are executed on the main thread unless defined with #[tauri::command(async)]"）。
// メインスレッドで ccn の HTTP を待つと、その間は画面の描画と入力が止まる（2026-11-12 の実測: ccn を3秒遅らせると、
// 何もしない命令の往復が 12.5 秒、描画の間隔が 9.5 秒になった）。HTTP を待つ命令は、ここで spawn_blocking に移す。
// 中身の関数は同期のまま残し、開発用の --snapshot などからも呼ぶ。

/// 待ってよいスレッドで f を動かし、結果を待つ。ureq は同期なので、async の中で直接待たない
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

mod cmd {
    use super::*;

    #[tauri::command]
    pub async fn peers() -> Result<Value, String> { blocking(super::peers).await }
    #[tauri::command]
    pub async fn snapshot(peer: Option<String>) -> Result<Snapshot, String> { blocking(move || Ok(super::snapshot(peer))).await }
    #[tauri::command]
    pub async fn town_agents(peer: Option<String>) -> Result<Vec<Value>, String> { blocking(move || super::town_agents(peer)).await }
    /// 新しい世帯の一覧の各場所に連携しているリポジトリ名（owner/repo）。.git/config を読むだけ（#99）
    #[tauri::command]
    pub async fn place_repos(paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> { blocking(move || Ok(super::repo::repos_of(&paths))).await }
    /// 入力欄への貼り付け（#64）。クリップボードのファイルのパスか、保存した画像のパスを返す
    #[tauri::command]
    pub async fn paste_clipboard(save_image: bool) -> Result<super::attach::Pasted, String> {
        blocking(move || super::attach::clipboard(&super::fc_path(Scope::App, "attachments"), save_image)).await
    }
    /// ドロップと貼り付けで受けたファイルのうち、一時の場所のものを attachments に写し、入力欄に入れるパスを返す（#69）
    #[tauri::command]
    pub async fn stage_files(paths: Vec<String>) -> Result<Vec<String>, String> {
        blocking(move || super::attach::stage(&super::fc_path(Scope::App, "attachments"), paths)).await
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 開発用: 画面に渡すのと同じ JSON を出して終わる（ブラウザでの見た目の確認に使う）
    //   family-computing --snapshot             一覧
    //   family-computing --conversation <id>    会話
    //   family-computing --answer <sessionId> <allow|deny> [expectId]
    // identifier はビルド時の設定（開発版は tauri.conf.json、安定版は tauri.stable.conf.json を重ねたもの）から取る。
    // 下の開発用の引数も、画面と同じ置き場所を使う
    // 軽さの計測（scripts/bench.ts）: プロセスが始まった時刻を書く。画面が町を描いた時刻との差を、起動の時間にする
    if std::env::var("FC_PERF_LOG").map(|p| !p.is_empty()).unwrap_or(false) {
        perf_log(json!({ "bench": "proc", "procStartMs": now_ms() as u64 }).to_string());
    }
    let context = tauri::generate_context!();
    let _ = APP_ID.set(context.config().identifier.clone());
    let args: Vec<String> = std::env::args().collect();
    let arg_after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    // family-computing --paths   identifier と、状態ファイルの置き場所を出す（両版で分かれているかの確認に使う）
    if args.iter().any(|a| a == "--paths") {
        println!("{}", serde_json::to_string_pretty(&json!({
            "identifier": APP_ID.get(),
            "shared": fc_path(Scope::Shared, ""),
            "app": fc_path(Scope::App, ""),
            "avatars": avatars_path(&None),
            "avatarsRecent": avatars::recent_path(&avatars_path(&None)),
        })).unwrap_or_default());
        return;
    }
    // family-computing --native-list   ~/.claude（FC_CLAUDE_HOME）から一覧を2回作り、件数と時間だけを出す（中身の文は出さない。#96）。
    // 生きているセッションの会話を末尾から読んだ件数と時間も出す。読むだけで、~/.claude にも ~/.family-computing にも書かない
    if args.iter().any(|a| a == "--native-list") {
        let root = native::claude_home();
        let first = native::list(&root, native::now_ms());
        let second = native::list(&root, native::now_ms());
        let convs: Vec<Value> = first.sessions.iter().chain(first.subagents.iter()).filter_map(|r| {
            let p = PathBuf::from(r["native"]["jsonl"].as_str()?);
            let t = std::time::Instant::now();
            let c = native::conv::read(&p, 0).ok()?;
            let items: usize = c.lines.iter().map(|l| simplify(l).len()).sum();
            Some(json!({ "kind": r["kind"], "bytes": fs::metadata(&p).map(|m| m.len()).unwrap_or(0), "lines": c.lines.len(), "items": items, "ms": t.elapsed().as_secs_f64() * 1000.0 }))
        }).collect();
        let mut odd = first.stats.unexpected.clone();
        for (k, v) in native::conv::odd_counts() { *odd.entry(k).or_default() += v; }
        println!("{}", serde_json::to_string_pretty(&json!({
            "first": first.stats, "second": second.stats,
            "rows": first.sessions.iter().chain(first.subagents.iter()).map(|r| json!({ "kind": r["kind"], "state": r["state"], "hasParent": !r["parent"].is_null() || !r["native"]["parentId"].is_null() })).collect::<Vec<_>>(),
            "conversations": convs,
            "unexpected": odd,
        })).unwrap_or_default());
        return;
    }
    if args.iter().any(|a| a == "--snapshot") {
        println!("{}", serde_json::to_string_pretty(&snapshot(arg_after("--peer"))).unwrap_or_default());
        return;
    }
    if let Some(id) = arg_after("--conversation") {
        // 出力の形は前と同じ（Ok に項目の配列）。public/dev-conversation.json に使う
        println!("{}", serde_json::to_string_pretty(&conversation(id, None, None).map(|d| d.items)).unwrap_or_default());
        return;
    }
    // family-computing --answer <sessionId> <allow|deny> [requestId]   承認待ちに答える（画面のボタンと同じ処理）
    if let Some(i) = args.iter().position(|a| a == "--answer") {
        let sid = args.get(i + 1).cloned().unwrap_or_default();
        let choice = args.get(i + 2).cloned().unwrap_or_default();
        println!("{:?}", answer_permission(sid, choice, args.get(i + 3).cloned(), None, None, None, None));
        return;
    }
    // family-computing --term <sessionId> [秒]   端末の SSE を読んで、イベントを1行ずつ出す（画面の端末と同じ読み方）
    if let Some(i) = args.iter().position(|a| a == "--term") {
        let sid = args.get(i + 1).cloned().unwrap_or_default();
        let secs: u64 = args.get(i + 2).and_then(|x| x.parse().ok()).unwrap_or(3);
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(secs)); s2.store(true, Ordering::SeqCst); });
        let url = ccn::local_terminal_url(&sid);
        read_terminal(&url, &stop, |ev, data| {
            let n = data["b64"].as_str().map(|b| b.len()).unwrap_or(0);
            println!("{ev} {}", if n > 0 { format!("b64 {n}字") } else { data.to_string() });
        });
        return;
    }
    // family-computing --create [cwd] [prompt] [parentId]   端末のセッションを立てる（画面の「子を足す」「新しい世帯」と同じ処理）
    if let Some(i) = args.iter().position(|a| a == "--create") {
        println!("{:?}", create_session(args.get(i + 1).cloned(), args.get(i + 2).cloned(), args.get(i + 3).cloned(), None, None, None, None, None, None, None));
        return;
    }
    // family-computing --send <sessionId> <文>   注文を送る（画面の送信と同じ処理）
    if let Some(i) = args.iter().position(|a| a == "--send") {
        println!("{:?}", send_message(args.get(i + 1).cloned().unwrap_or_default(), args.get(i + 2).cloned().unwrap_or_default(), None));
        return;
    }
    // 会話の保存のうち、古いものと多すぎる分を消す。起動を待たせないよう別のスレッドで
    std::thread::spawn(|| {
        let n = offline::prune_conv(&cache_dir(), offline::CONV_MAX_AGE, offline::CONV_MAX_FILES);
        if n > 0 {
            eprintln!("[offline] 古い会話の保存を {n} 件消した");
        }
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 開発の計測用（src/term/bench.ts、scripts/bench.ts）: 窓が裏にあると WebKit が描画を止め、描画の負荷を測れないので、
            // 最前面に出し、どのデスクトップにも出す（本人が別のデスクトップに移っても隠れないように）。
            // 前面は奪わない（FC_BENCH_FOCUS=1 のときだけ奪う）。起動のたびに前面を奪うと、本人の作業の邪魔になる
            if std::env::var("FC_BENCH_TOP").is_ok() {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(true);
                    let _ = w.set_visible_on_all_workspaces(true);
                    if std::env::var("FC_BENCH_FOCUS").is_ok() {
                        let _ = w.set_focus();
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd::snapshot, cmd::town_agents, cmd::peers, conversation::cmd::conversation, conversation::cmd::conversation_cache, conversation::cmd::send_message, permission::cmd::answer_permission,
            session_ops::cmd::create_session, session_ops::cmd::stop_session, teleport, session_ops::cmd::teleport_info, session_ops::cmd::session_detail, session_ops::cmd::house_places, cmd::place_repos, term_open, term_close, term_input, term_resize,
            perf_log, perf_ping, perf_window, town_watch, town_unwatch, town_kick, town_settings, set_town_settings,
            composer::cmd::prompt_history, composer::cmd::slash_commands, composer::cmd::file_suggestions, composer::cmd::send_direct, composer::cmd::interrupt_session, composer::cmd::session_controls, composer::cmd::configure_session, composer::cmd::run_command, cmd::paste_clipboard, cmd::stage_files
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
pub(crate) static NATIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_read_only_what_was_added() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("fc-letters-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("letters.jsonl");
        let now = 100 * 60 * 1000u128;
        let line = |id: &str, at: u128| format!("{{\"ev\":\"sent\",\"id\":\"{id}\",\"at\":{at}}}\n");
        fs::write(&p, format!("{}{}", line("old", now - LETTERS_WINDOW_MS - 1), line("a", now - 1000))).unwrap();
        let mut tail = None;
        let ids = |v: Vec<Value>| v.iter().map(|x| x["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(letters_from(&p, now, &mut tail)), vec!["a"]);
        // 書きかけの行は返さず、書き終わったら返す
        let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"ev\":\"sent\",\"id\":\"b\",").unwrap();
        assert_eq!(ids(letters_from(&p, now, &mut tail)), vec!["a"]);
        f.write_all(format!("\"at\":{}}}\n", now).as_bytes()).unwrap();
        assert_eq!(ids(letters_from(&p, now, &mut tail)), vec!["a", "b"]);
        // 足した分だけ読んだ
        assert_eq!(tail.as_ref().unwrap().offset, fs::metadata(&p).unwrap().len());
        // 時刻が進んで a が窓から外れる
        assert_eq!(ids(letters_from(&p, now + LETTERS_WINDOW_MS - 500, &mut tail)), vec!["b"]);
        // 入れ替わった（.1 に移して新しく始めた）ら頭から読む
        fs::rename(&p, dir.join("letters.jsonl.1")).unwrap();
        fs::write(&p, line("c", now)).unwrap();
        assert_eq!(ids(letters_from(&p, now, &mut tail)), vec!["c"]);
        // 消えたら空
        fs::remove_file(&p).unwrap();
        assert!(letters_from(&p, now, &mut tail).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 1MB の letters.jsonl で、頭から読む前の形と、増えた分だけ読む今の形の時間を比べる（#11）。
    /// cargo test --release --lib letters_1mb -- --ignored --nocapture
    #[test]
    #[ignore]
    fn letters_1mb_timing() {
        let dir = std::env::temp_dir().join(format!("fc-letters-1mb-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("letters.jsonl");
        let now = now_ms();
        let mut text = String::new();
        let mut i = 0u64;
        while text.len() < 1_000_000 {
            text.push_str(&format!("{{\"ev\":\"sent\",\"id\":\"l{i}\",\"at\":{},\"kind\":\"send\",\"from\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"to\":\"uds:/tmp/cc-socks/1234.sock\",\"summary\":\"テストのお手紙\"}}\n", now - 3_600_000 + i as u128 * 10));
            i += 1;
        }
        fs::write(&p, &text).unwrap();
        let full = || {
            let text = fs::read_to_string(&p).unwrap();
            let since = now.saturating_sub(LETTERS_WINDOW_MS);
            text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .take_while(|v| v["at"].as_u64().map(|a| a as u128 >= since).unwrap_or(false)).take(LETTERS_MAX).count()
        };
        let t = std::time::Instant::now();
        for _ in 0..20 { full(); }
        let before = t.elapsed() / 20;
        let mut tail = None;
        letters_from(&p, now, &mut tail);
        let t = std::time::Instant::now();
        for _ in 0..20 { letters_from(&p, now, &mut tail); }
        let after = t.elapsed() / 20;
        println!("letters.jsonl {} バイト {} 行: 頭から読む {:?}/回、増えた分だけ読む（変化なし） {:?}/回", text.len(), i, before, after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cached_json_rereads_only_when_the_file_changes() {
        let dir = std::env::temp_dir().join(format!("fc-cache-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("state.json");
        fs::write(&p, r#"{"phase":"working"}"#).unwrap();
        assert_eq!(read_json_cached(&p).unwrap()["phase"], "working");
        // 書き換えたら読み直す（大きさが同じでも、更新時刻が変わる）
        std::thread::sleep(Duration::from_millis(5));
        fs::write(&p, r#"{"phase":"resting"}"#).unwrap();
        assert_eq!(read_json_cached(&p).unwrap()["phase"], "resting");
        fs::remove_file(&p).unwrap();
        assert!(read_json_cached(&p).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_keeps_app_files_apart_from_stable() {
        let h = std::path::Path::new("/h");
        let p = |id: Option<&str>, over: Option<&str>, scope, name| place(h, id, over.map(String::from), scope, name);
        // 安定版と、identifier が分からないときは、今までの場所
        assert_eq!(p(Some(STABLE_ID), None, Scope::App, "avatars.json"), PathBuf::from("/h/.family-computing/avatars.json"));
        assert_eq!(p(None, None, Scope::App, "houses.json"), PathBuf::from("/h/.family-computing/houses.json"));
        // 開発版のアプリの分は dev/ の下
        let dev = Some("jp.fybe.family-computing.dev");
        assert_eq!(p(dev, None, Scope::App, "avatars-recent.json"), PathBuf::from("/h/.family-computing/dev/avatars-recent.json"));
        assert_eq!(p(dev, None, Scope::App, "houses.json"), PathBuf::from("/h/.family-computing/dev/houses.json"));
        // hook が書くものと非常停止は、開発版でも共有
        assert_eq!(p(dev, None, Scope::Shared, "state/x.json"), PathBuf::from("/h/.family-computing/state/x.json"));
        assert_eq!(p(dev, None, Scope::Shared, "letters.jsonl"), PathBuf::from("/h/.family-computing/letters.jsonl"));
        assert_eq!(p(dev, None, Scope::Shared, "send-disabled"), PathBuf::from("/h/.family-computing/send-disabled"));
        // FC_APP_HOME はアプリの分だけを差し替える
        assert_eq!(p(Some(STABLE_ID), Some("/t"), Scope::App, "avatars.json"), PathBuf::from("/t/avatars.json"));
        assert_eq!(p(dev, Some("/t"), Scope::Shared, "letters.jsonl"), PathBuf::from("/h/.family-computing/letters.jsonl"));
    }

    #[test]
    fn agents_carry_account_when_ccn_lists_it() {
        // 別の機械の町として読む（この機械の状態ファイルを読まない）
        let peer = Some("vm".to_string());
        let list = vec![
            json!({ "id": "1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa", "kind": "pty", "state": "idle", "cwd": "/w/a", "account": "acct-a", "accountEmail": "a@example.invalid" }),
            // 古い ccn の一覧にはアカウントが無い
            json!({ "id": "f7a05063-6d62-40d7-b13c-3604a655dfda", "kind": "pty", "state": "idle", "cwd": "/w/b" }),
        ];
        let (agents, err) = agents_from(&peer, Ok(list));
        assert!(err.is_none());
        assert_eq!(agents[0]["account"], "acct-a");
        assert_eq!(agents[0]["accountEmail"], "a@example.invalid");
        assert!(agents[1]["account"].is_null());
        assert!(agents[1]["accountEmail"].is_null());
    }

    #[test]
    fn local_town_merges_native_sessions_and_subagents() {
        // 会話を読む先の登録（native::register）はプロセスで1つなので、使う試験を1本ずつ動かす
        let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use native::testtree::*;
        // 合成の ~/.claude: ccn にもあるセッション A（sub-agent 1体）と、ccn に無いセッション B
        let root = tmp("merge");
        let a = "aaaaaaaa-0000-4000-8000-00000000000a";
        let b = "bbbbbbbb-0000-4000-8000-00000000000b";
        session(&root, a, "/tmp/合成/a", "busy");
        let pid2 = 1; // launchd。生きている pid として使う（読むだけ）
        write(&root.join(format!("sessions/{pid2}.json")), &json!({ "pid": pid2, "sessionId": b, "cwd": "/tmp/合成/b", "startedAt": 5, "kind": "interactive", "status": "idle" }).to_string());
        write(&root.join(format!("projects/{}/{a}.jsonl", enc("/tmp/合成/a"))), "{\"type\":\"user\",\"message\":{\"content\":\"やって\"}}\n");
        write(&root.join(format!("projects/{}/{b}.jsonl", enc("/tmp/合成/b"))), &format!("{{\"type\":\"user\",\"message\":{{\"content\":\"from agent:n/{}/r via n\\n\\nやって\"}}}}\n", &a[..8]));
        let sub = root.join(format!("projects/{}/{a}/subagents", enc("/tmp/合成/a")));
        write(&sub.join("agent-x1.jsonl"), "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"見た\"}]}}\n");
        write(&sub.join("agent-x1.meta.json"), &json!({ "agentType": "Explore", "description": "探す" }).to_string());
        native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root.clone()));
        CCN_USE.store(1, Ordering::SeqCst);
        let ccn = vec![json!({ "id": a, "kind": "pty", "state": "running", "cwd": "/tmp/合成/a", "capabilities": { "send": true, "stop": true }, "parent": "local" })];
        let (agents, err) = agents_from(&None, Ok(ccn));
        assert!(err.is_none());
        let by = |id: &str| agents.iter().find(|x| x["id"] == id).cloned().unwrap_or(Value::Null);
        // A は ccn の行（送れる）、B はネイティブの行（読むだけ）で、from 行から A の子になる
        assert_eq!(by(a)["source"], "ccn");
        assert_eq!(by(a)["canSend"], true);
        assert_eq!(by(b)["source"], "native");
        assert_eq!(by(b)["canSend"], false);
        assert_eq!(by(b)["capabilities"]["permissions"], false);
        assert_eq!(by(b)["parent"], a);
        let x1 = native::subagents::sub_id("x1", a);
        assert_eq!(by(&x1)["kind"], "subagent");
        assert_eq!(by(&x1)["parent"], a);
        assert_eq!(by(&x1)["name"], "Explore");
        assert_eq!(by(&x1)["report"]["asked"], "探す");
        assert_eq!(agents.len(), 3);
        // 操作は、ネイティブの id だけ断る
        assert!(native_guard(b, &None).is_err());
        assert!(native_guard(&x1, &None).is_err());
        assert!(native_guard(a, &None).is_ok());
        assert!(native_guard(b, &Some("vm".into())).is_ok());
        // 会話は jsonl から読む（印は native:）。conversation() は会話の保存（~/.family-computing の cache）を書くので、試験では読む関数だけを通す
        let path = native::path_of(b).unwrap();
        let (next, items, _, epoch) = read_native(&path, 0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], "やって");
        assert!(epoch.unwrap().starts_with("native:"));
        assert_eq!(next, fs::metadata(&path).unwrap().len());
        // ccn につながらなくても、ネイティブで読めたら町は読めたことにする
        let (agents, err) = agents_from(&None, Err("つながらない".into()));
        assert!(err.is_none());
        assert_eq!(agents.len(), 3);
        assert_eq!(LAST_SOURCES.lock().unwrap().as_ref().unwrap()["ccn"], "つながらない");
    }

    #[test]
    fn stable_conf_identifier_matches() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.stable.conf.json")).unwrap();
        assert_eq!(conf["identifier"], STABLE_ID);
        let dev: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_ne!(dev["identifier"], STABLE_ID);
    }

}
