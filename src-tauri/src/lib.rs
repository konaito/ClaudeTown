// family-computing の裏側。画面から呼ばれる命令:
// - snapshot(peer): ccn の一覧（状態、送信先、親子）、hook の報告、close-check の判定を1つにまとめる
// - peers: ccn につながっている機械の一覧
// - conversation(session_id, peer, since): ccn の messages を差分で読み、画面に出す形（発言と道具の1行）に縮め、画面がまだ持っていない分だけ返す
// - send_message(session_id, text, peer): ccn の POST /api/sessions/<id>/messages で文を届ける
// - create_session / stop_session / teleport / teleport_info / session_detail: ccn の口をそのまま呼ぶ
// - term_open / term_close / term_input / term_resize: ccn の端末（PTY）の口を読み書きし、開いた画面の Channel へ流す
// HTTP を待つ命令は spawn_blocking で動かし、メインスレッドを止めない（下の「画面から呼ぶ命令」）
//
// ccn は Origin 付きの要求を CSRF として断るので、HTTP は必ずこちら（webview ではなく Rust）から出す。
// 別の機械（peer）は手元のノードの中継 /n/<peer>/api/... を通す。

mod avatars;
mod naming;
mod offline;

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
/// ccn では waiting_permission に見えるが、道具の承認ではない待ち（選択肢を選ぶ画面が出る）
const NOT_TOOL_APPROVAL: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];
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
    fc_path(Scope::App, "cache")
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

/// 手元の ccn ノードの入口。ccn.json の port を読む（README は 4322、実機は 4323 なので固定しない）。
fn ccn_base() -> String {
    if let Ok(u) = std::env::var("FC_CCN_URL") {
        return u.trim_end_matches('/').to_string();
    }
    for rel in [".config/ccn/ccn.json", ".config/cc/cc.json"] {
        if let Some(port) = read_json_cached(&home().join(rel)).and_then(|v| v.get("port").and_then(|p| p.as_u64())) {
            return format!("http://127.0.0.1:{port}");
        }
    }
    "http://127.0.0.1:4322".into()
}

fn api(peer: &Option<String>) -> String {
    let base = ccn_base();
    match peer.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => format!("{base}/n/{p}/api"),
        None => format!("{base}/api"),
    }
}

/// ccn への HTTP。接続を使い回すため、1つの Agent を全部の命令で共有する（呼ぶたびに作ると、毎回つなぎ直す）
fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(Duration::from_secs(8)).build())
}

/// 一覧（snapshot、peers）の時間切れ。別の機械への中継は実測 0.42〜0.46 秒（2026-11-12）。
/// 3秒にしたら、ノードが一瞬詰まった回（/api/sessions が最大 1.4 秒、2026-11-12 の meta-9d の実測）で取りこぼし、町が空になった。
/// 命令は非同期で画面を止めず、画面は前の回が終わるまで次を始めないので、長めの5秒にする
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

fn get_json(url: &str) -> Result<Value, String> {
    get_json_t(url, Duration::from_secs(8))
}

fn get_json_t(url: &str, timeout: Duration) -> Result<Value, String> {
    match agent().get(url).timeout(timeout).call() {
        Ok(r) => r.into_json::<Value>().map_err(|e| format!("応答を読めなかった: {e}")),
        Err(ureq::Error::Status(code, r)) => Err(format!("ccn が {code} を返した: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn につながらない（{url}）: {e}")),
    }
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
    match get_json_t(&format!("{}/api/peers", ccn_base()), LIST_TIMEOUT) {
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
    let (sessions, ccn_error) = match get_json_t(&format!("{}/sessions", api(peer)), LIST_TIMEOUT) {
        Ok(Value::Array(v)) => (v, None),
        Ok(_) => (vec![], Some("一覧の形が想定と違う".into())),
        Err(e) => (vec![], Some(e)),
    };
    let live: Vec<&Value> = sessions
        .iter()
        .filter(|s| s.get("state").and_then(|x| x.as_str()) != Some("exited"))
        .collect();
    let live_ids: HashSet<String> = live.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();

    // ccn の parent は from 行の呼び手（"agent:<ノード>/<sid8>/<役割>"）
    let parent_from_ccn = |s: &Value| -> Option<String> {
        let p = s["parent"].as_str()?;
        let sid8 = p.strip_prefix("agent:")?.split('/').nth(1)?;
        live_ids.iter().find(|id| id.starts_with(sid8)).cloned()
    };

    let houses = read_houses();
    // 名前は、そのセッションが作業しているプロジェクトの名前（src-tauri/src/naming.rs）。
    // .git を読むのはこの機械の町だけ。別の機械の cwd はパスの形だけで決める
    let local = peer.is_none();
    let whos: Vec<naming::Who> = live.iter().map(|s| {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let cwd = s["cwd"].as_str().filter(|c| !c.is_empty());
        let house = houses.get(&id);
        naming::Who {
            parent: parent_from_ccn(s).filter(|p| *p != id),
            cwd: cwd.map(String::from),
            title: s["title"].as_str().map(String::from),
            project: cwd.and_then(|c| naming::project_of(c, local)),
            agent_name: house.filter(|h| h["by"] == "agent").and_then(|h| h["name"].as_str()).map(String::from),
            started_at: s["startedAt"].as_u64().unwrap_or(0),
            id,
        }
    }).collect();
    let name_of = naming::card_names(&whos);
    let project_of: HashMap<&str, Option<&String>> = whos.iter().map(|w| (w.id.as_str(), w.project.as_ref())).collect();
    let mut agents = vec![];
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        // 親は ccn の parent（from 行の呼び手）だけから引く。親が生きていなければ根として扱う
        let parent = parent_from_ccn(s).filter(|p| *p != id);
        let (report, close_check) = if peer.is_none() {
            (
                read_json_cached(&fc_path(Scope::Shared, &format!("state/{id}.json"))),
                read_json_cached(&home().join(format!(".claude/close-check/{id}.json"))),
            )
        } else {
            (None, None)
        };
        agents.push(json!({
            "id": id,
            "name": name_of.get(&id),
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
            "house": houses.get(&id).cloned(),
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

fn snapshot(peer: Option<String>) -> Snapshot {
    let peer = peer.filter(|p| !p.is_empty());
    let (mut agents, ccn_error) = fetch_agents(&peer);
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
    Snapshot { ccn: ccn_base(), peer, ccn_ok: ccn_error.is_none(), ccn_error, agents, letters, fetched_at: now_ms(), cached_at }
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

// ---------- 家の名前 ----------

/// 世帯の名前の置き場所。（共有の分, アプリが書く分）を返す。
/// 共有の分には、hook（scripts/hook.py name）でエージェントが付けた名前が入る。アプリは自分の分にだけ書く。
/// 安定版では2つは同じファイル。FC_HOUSES があれば、両方ともそのファイルにする
fn houses_paths() -> (PathBuf, PathBuf) {
    match std::env::var("FC_HOUSES") {
        Ok(p) if !p.is_empty() => (PathBuf::from(&p), PathBuf::from(p)),
        _ => (fc_path(Scope::Shared, "houses.json"), fc_path(Scope::App, "houses.json")),
    }
}

/// 世帯の名前を読む。共有の分を下地にして、アプリの分（開発版なら開発版で付けた名前）を上に重ねる
fn read_houses() -> Value {
    let (shared, own) = houses_paths();
    let mut out = read_json_cached(&shared).filter(Value::is_object).unwrap_or(json!({}));
    if own != shared {
        if let (Some(base), Some(Value::Object(top))) = (out.as_object_mut(), read_json_cached(&own)) {
            base.extend(top);
        }
    }
    out
}

/// 本人が画面で家の名前を付ける。空なら本人の名前を消す（親が付けた名前か仮の名前に戻る）。
/// 開発版では開発版の分にだけ書く。開発版で消しても、共有の分にある名前は残って見える
#[tauri::command]
fn set_house_name(session_id: String, name: String) -> Result<(), String> {
    let p = houses_paths().1;
    let mut houses = read_json(&p).unwrap_or(json!({}));
    let obj = houses.as_object_mut().ok_or("houses.json の形が想定と違う")?;
    let name: String = name.trim().chars().take(24).collect();
    if name.is_empty() {
        obj.remove(&session_id);
    } else {
        obj.insert(session_id, json!({ "name": name, "by": "human", "at": now_ms() as u64 }));
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&houses).unwrap_or_default()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// ---------- 会話 ----------

#[derive(Default)]
struct Conv {
    /// ccn の messages の次の読み出し位置（after=）
    next: u64,
    /// これまでに縮めた項目の数。項目の通し番号 n は 0 から数える
    total: u64,
    /// 最後の KEEP_MESSAGES 件
    items: Vec<Value>,
    /// 最後に読まれた時刻（ms）
    used: u128,
}

/// 会話のキャッシュを残す時間（#15）。画面は開いている会話だけを 2.5 秒ごとに読むので、
/// これより長く読まれていない会話（閉じたセッション、ほかのセッションに切り替えた後）は捨てる。
/// 捨てた後に開き直したら、ccn の after=0 から読み直し、画面は reset で受け取る
const CONV_IDLE_MS: u128 = 10 * 60 * 1000;

fn forget_idle_convs(map: &mut HashMap<String, Conv>, keep: &str, now: u128) {
    map.retain(|k, c| k == keep || now.saturating_sub(c.used) < CONV_IDLE_MS);
}

/// 画面へ渡す差分（#10）。items の各項目には通し番号 n を付ける。
/// reset=true のとき、画面は持っている分を捨てて items に置き換える。total は次の呼び出しの since に渡す
#[derive(Serialize, Debug, PartialEq)]
struct ConvDelta {
    items: Vec<Value>,
    total: u64,
    reset: bool,
}

impl Conv {
    /// ccn の after=from から next まで読んだ分を足す。同じセッションの取得が重なり、
    /// ほかの呼び出しが先に同じ範囲を足していたら（c.next が読み始めと違う）、足さない
    /// 項目が増えたら true
    fn absorb(&mut self, from: u64, next: u64, fresh: Vec<Value>) -> bool {
        if self.next != from {
            return false;
        }
        self.next = next;
        let grew = !fresh.is_empty();
        self.push(fresh);
        grew
    }

    fn push(&mut self, fresh: Vec<Value>) {
        for mut v in fresh {
            if let Value::Object(o) = &mut v {
                o.insert("n".into(), json!(self.total));
            }
            self.total += 1;
            self.items.push(v);
        }
        if self.items.len() > KEEP_MESSAGES {
            let cut = self.items.len() - KEEP_MESSAGES;
            self.items.drain(..cut);
        }
    }

    /// 画面が total=since まで持っているときの差分。持っている分が古すぎる（捨てた分より前）、
    /// 先に進みすぎている（キャッシュを作り直した）、since が無いときは、全部を reset で返す
    fn since(&self, since: Option<u64>) -> ConvDelta {
        let base = self.total - self.items.len() as u64;
        match since {
            Some(s) if s >= base && s <= self.total => {
                ConvDelta { items: self.items[(s - base) as usize..].to_vec(), total: self.total, reset: false }
            }
            _ => ConvDelta { items: self.items.clone(), total: self.total, reset: true },
        }
    }
}

static CONVS: Mutex<Option<HashMap<String, Conv>>> = Mutex::new(None);

fn clip(s: &str, n: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= n { t } else { t.chars().take(n - 1).collect::<String>() + "…" }
}

fn tool_line(name: &str, input: &Value) -> String {
    let verb = match name {
        "Bash" => "コマンド",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "書く",
        "Read" => "読む",
        "Grep" | "Glob" => "探す",
        "WebSearch" | "WebFetch" => "調べる",
        "SendMessage" => "話す",
        "Agent" | "Task" => "手伝いを呼ぶ",
        n if n.contains("spawn_child") => "子を呼ぶ",
        n if n.starts_with("mcp__") => n.split("__").last().unwrap_or(n),
        n => n,
    };
    let target = ["description", "title", "command", "file_path", "pattern", "query", "url", "to"]
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .unwrap_or("");
    let target = if target.contains('/') && matches!(name, "Edit" | "MultiEdit" | "Write" | "Read") {
        target.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/")
    } else {
        target.to_string()
    };
    if target.is_empty() { verb.to_string() } else { format!("{verb}: {}", clip(&target, 70)) }
}

/// SDK の1件を、画面に出す0件以上の項目に縮める。考えた中身と道具の結果は捨てる
/// ccn の messages は、セッションの種類で形が違う。node はトランスクリプトの行そのまま（type、message、timestamp）。
/// pty は {at, type, data: {type, message, …}, seq} で、中身は data に入り、時刻は at（ms）にある。
fn simplify(m: &Value) -> Vec<Value> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, m["at"].clone()),
        None => (m, m["timestamp"].clone()),
    };
    let ty = m["type"].as_str().unwrap_or("");
    let content = &m["message"]["content"];
    let mut out = vec![];
    match ty {
        "user" => {
            let text = match content {
                Value::String(s) => s.clone(),
                Value::Array(a) => a
                    .iter()
                    .filter(|c| c["type"] == "text")
                    .filter_map(|c| c["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            let text = text.trim();
            // ターミナルのセッションには、お手紙の前に「Another Claude session sent a message:」の1行が付く
            let text = text.strip_prefix("Another Claude session sent a message:").map(str::trim_start).unwrap_or(text);
            // 別のセッションからのお手紙（<cross-session-message from=… from-name=…>本文</cross-session-message>、後ろに注記が付くことがある）は、包みの内側の本文だけ出す
            if let Some(rest) = text.strip_prefix("<cross-session-message") {
                let (attrs, body) = rest.split_once('>').unwrap_or(("", ""));
                let body = body.split("</cross-session-message>").next().unwrap_or("");
                let attr = |k: &str| {
                    let key = format!("{k}=\"");
                    attrs.find(&key).and_then(|i| attrs[i + key.len()..].split('"').next()).map(String::from)
                };
                let body = body.trim();
                if !body.is_empty() {
                    out.push(json!({ "role": "user", "text": body, "from": null, "at": at,
                        "letter": { "fromName": attr("from-name"), "fromRaw": attr("from") } }));
                }
                return out;
            }
            // 道具の結果だけの user、hook やシステムの差し込み（<...> で始まる）は出さない
            if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
                return out;
            }
            // 別のセッションからの文は1行目が from 行
            let (from, body) = match text.split_once('\n') {
                Some((first, rest)) if first.starts_with("from ") && first.contains(" via ") => (Some(first.to_string()), rest.trim().to_string()),
                _ => (None, text.to_string()),
            };
            // from agent:<ノード>/<sid8>/<役割> の文は、セッションからのお手紙
            let letter = from.as_deref().and_then(|f| f.strip_prefix("from agent:")).map(|r| {
                let who = r.split_whitespace().next().unwrap_or("");
                json!({ "fromName": null, "fromRaw": who })
            });
            out.push(json!({ "role": "user", "text": body, "from": from, "at": at, "letter": letter }));
        }
        "assistant" => {
            if let Value::Array(a) = content {
                for c in a {
                    match c["type"].as_str() {
                        Some("text") => {
                            let t = c["text"].as_str().unwrap_or("").trim();
                            if !t.is_empty() {
                                out.push(json!({ "role": "assistant", "text": t, "at": at }));
                            }
                        }
                        Some("tool_use") => {
                            let name = c["name"].as_str().unwrap_or("");
                            let inp = &c["input"];
                            // 送ったお手紙（SendMessage、ccn の send_message と create_session）は、宛先と1行目を付ける
                            let first = |v: &Value| v.as_str().unwrap_or("").lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
                            let sent = match name {
                                "SendMessage" if inp["message"].is_string() => Some(json!({ "to": inp["to"], "summary": inp["summary"].as_str().map(String::from).unwrap_or_else(|| first(&inp["message"])), "text": inp["message"] })),
                                "mcp__ccn__send_message" => Some(json!({ "to": inp["session"], "peer": inp["peer"], "summary": first(&inp["text"]), "text": inp["text"] })),
                                "mcp__ccn__create_session" if inp["prompt"].is_string() => Some(json!({ "to": null, "peer": inp["peer"], "summary": first(&inp["prompt"]), "text": inp["prompt"], "create": true })),
                                _ => None,
                            };
                            out.push(json!({ "role": "tool", "text": tool_line(name, inp), "at": at, "sent": sent }));
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn conversation(session_id: String, peer: Option<String>, since: Option<u64>) -> Result<ConvDelta, String> {
    let peer = peer.filter(|p| !p.is_empty());
    let key = format!("{}|{session_id}", peer.clone().unwrap_or_default());
    let from = {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        g.as_ref().and_then(|m| m.get(&key)).map(|c| c.next).unwrap_or(0)
    };
    let mut next = from;
    let mut fresh = vec![];
    // 1回の呼び出しで読むのは最大20ページ（4000件）。続きは次の呼び出しで読む
    for _ in 0..20 {
        let v = get_json(&format!("{}/sessions/{session_id}/messages?after={next}", api(&peer)))?;
        let msgs = v["messages"].as_array().cloned().unwrap_or_default();
        for m in &msgs {
            fresh.extend(simplify(m));
        }
        match v["next"].as_u64() {
            Some(n) if n > next && !msgs.is_empty() => next = n,
            _ => break,
        }
        if msgs.len() < 200 {
            break;
        }
    }
    let mut g = CONVS.lock().map_err(|e| e.to_string())?;
    let map = g.get_or_insert_with(HashMap::new);
    let now = now_ms();
    forget_idle_convs(map, &key, now);
    let c = map.entry(key).or_insert_with(Conv::default);
    c.used = now;
    // 増えたら、画面に出す分（最後の KEEP_MESSAGES 件）を保存する。ネットが切れたときは画面が conversation_cache で読む。
    // 書くのは錠を持ったまま（同じセッションの取得が重なっても、古い中身があとから上書きしない）。80件の JSON なので短い
    if c.absorb(from, next, fresh) {
        let _ = offline::save_conv(&cache_dir(), &peer, &session_id, c.total, &c.items);
    }
    Ok(c.since(since))
}

/// 保存してある会話（offline.rs）。画面はセッションを開いた直後にこれを出し、ccn から読めたら差し替える
fn conversation_cache(session_id: String, peer: Option<String>) -> Option<offline::ConvCache> {
    let peer = peer.filter(|p| !p.is_empty());
    offline::load_conv(&cache_dir(), &peer, &session_id)
}

fn send_message(session_id: String, text: String, peer: Option<String>) -> Result<String, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    if text.trim().is_empty() {
        return Err("文が空".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    match agent()
        .post(&format!("{}/sessions/{session_id}/messages", api(&peer)))
        .send_json(json!({ "text": text }))
    {
        Ok(r) => Ok(r.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, r)) => Err(format!("ccn が {code} を返した: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn に届かない: {e}")),
    }
}

// ---------- 承認 ----------

/// 承認待ちに答える。choice は "allow" か "deny"。ccn の pending と permissions の口で答える（PTY のセッションも同じ口）。
/// 送る前に、今も承認待ちで、承認を求めている requestId が画面で見せたもの（expect_id）と同じかを確かめ、ずれていたら送らない。
/// 質問（AskUserQuestion）と計画の確認（ExitPlanMode）の待ちには許可を送らない。
/// 人が端末で開いたセッション（kind=terminal）は ccn から答えられないので断る。
fn answer_permission(session_id: String, choice: String, expect_id: Option<String>, peer: Option<String>) -> Result<String, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    if choice != "allow" && choice != "deny" {
        return Err("choice は allow か deny".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    let base = api(&peer);
    let detail = get_json(&format!("{base}/sessions/{session_id}"))?;
    if detail["state"].as_str() != Some("waiting_permission") {
        return Err("もう承認待ちではない（ほかで答えたか、終わった）".into());
    }
    if detail["capabilities"]["permissions"].as_bool() != Some(true) {
        return Err("このセッションは ccn から承認に答えられない（人がターミナルで開いたセッション）。そのターミナルで答えて".into());
    }
    let pending = detail["pending"].as_array().cloned().unwrap_or_default();
    let first = pending.first().ok_or("ccn に承認の要求が見当たらない")?;
    let req = first["requestId"].as_str().ok_or("承認の要求に requestId が無い")?.to_string();
    let tool = first["toolName"].as_str().unwrap_or_default();
    if choice == "allow" {
        if NOT_TOOL_APPROVAL.contains(&tool) {
            return Err(format!("{tool} の待ちは道具の承認ではないので、ここからは許可しない。ターミナルで答えて"));
        }
        if expect_id.as_deref() != Some(req.as_str()) {
            return Err("承認を求めている中身が変わった。もう一度見てから答えて".into());
        }
    }
    let body = if choice == "allow" { json!({ "behavior": "allow" }) } else { json!({ "behavior": "deny", "message": "Claude Town から拒否した" }) };
    agent()
        .post(&format!("{base}/sessions/{session_id}/permissions/{req}"))
        .send_json(body)
        .map_err(|e| format!("ccn に答えを届けられなかった: {e}"))?;
    Ok(format!("{}した（{tool}）", if choice == "allow" { "許可" } else { "拒否" }))
}

// ---------- 作る・止める・転出 ----------

/// この機械のノード名（~/.config/ccn/ccn.json の name）。親を名乗るヘッダに使う
fn node_name() -> String {
    for rel in [".config/ccn/ccn.json", ".config/cc/cc.json"] {
        if let Some(n) = read_json(&home().join(rel)).and_then(|v| v["name"].as_str().map(String::from)) {
            return n;
        }
    }
    "local".into()
}

/// 端末（PTY）のセッションを立てる。parent を渡すと、その親の子として立てる（x-ccn-from で親を名乗る）。
/// 渡さなければ新しい世帯（親なし）になる。cwd を省くと ~/Documents/meta（本人の指定）
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
fn create_session(cwd: Option<String>, prompt: Option<String>, parent: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, peer: Option<String>) -> Result<Value, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| home().join("Documents/meta").to_string_lossy().to_string());
    // ccn は 10〜1000 だけを受ける
    let ok = |v: Option<u16>| v.filter(|n| (10..=1000).contains(n));
    let mut body = json!({ "terminal": true, "cwd": cwd, "cols": ok(cols).unwrap_or(120), "rows": ok(rows).unwrap_or(40) });
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) { body["prompt"] = json!(p); }
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) { body["name"] = json!(n); }
    let mut req = agent().post(&format!("{}/sessions", api(&peer)));
    if let Some(pid) = parent.filter(|p| !p.is_empty()) {
        // 親を名乗る。一覧の parent に agent:<ノード>/<親の sid 先頭8>/town が入り、木がつながる
        req = req.set("x-ccn-from", &format!("agent:{}/{}/town", node_name(), &pid[..8.min(pid.len())]));
    }
    match req.send_json(body) {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => Err(format!("ccn が {code} を返した: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn に届かない: {e}")),
    }
}

/// セッションの詳細（承認の pending を含む）
fn session_detail(session_id: String, peer: Option<String>) -> Result<Value, String> {
    let peer = peer.filter(|p| !p.is_empty());
    get_json(&format!("{}/sessions/{session_id}", api(&peer)))
}

/// 転出の下見の1段目（移動元の説明）。副作用は無い。2段目の行き先の下見は clone することがあるので、画面からは呼ばない
fn teleport_info(session_id: String, peer: Option<String>) -> Result<Value, String> {
    let peer = peer.filter(|p| !p.is_empty());
    get_json(&format!("{}/sessions/{session_id}/teleport", api(&peer)))
}

fn stop_session(session_id: String, peer: Option<String>) -> Result<(), String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    agent().delete(&format!("{}/sessions/{session_id}", api(&peer))).call().map_err(|e| format!("止められなかった: {e}"))?;
    // 止めたセッションの会話の保存は要らない
    offline::remove_conv(&cache_dir(), &peer, &session_id);
    Ok(())
}

/// 転出（ccn の teleport。PR #18）。移動元のノードが下見から取り込みまで1回の要求で進め、結果を返す（最大95秒）
#[tauri::command]
async fn teleport(session_id: String, to: String, fork: bool, subtree: Option<bool>, dry_run: Option<bool>, peer: Option<String>) -> Result<Value, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        let a = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
        // subtree は子孫ごと移す口（ccn-pty が作る別 PR）。dry_run は計画だけを返す
        let mut body = json!({ "to": to, "fork": fork });
        if subtree.unwrap_or(false) { body["subtree"] = json!(true); }
        if dry_run.unwrap_or(false) { body["dryRun"] = json!(true); }
        // 移った先でも親とつながるよう、元の parent（agent:<ノード>/<親の sid8>/<役割>）を from 行として付けて頼む。
        // 付けないと、移った先の parent は local になる（2026-11-12、fc-teleport-test の試験ノードで確かめた）
        let mut req = a.post(&format!("{}/sessions/{session_id}/teleport", api(&peer)));
        if let Ok(d) = get_json(&format!("{}/sessions/{session_id}", api(&peer))) {
            if let Some(p) = d["parent"].as_str().filter(|p| p.starts_with("agent:")) {
                req = req.set("x-ccn-from", p);
            }
        }
        match req.send_json(body) {
            Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, r)) => Err(format!("転出できなかった（{code}）: {}", r.into_string().unwrap_or_default())),
            Err(e) => Err(format!("ccn に届かない: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- 端末（PTY） ----------
// ccn の GET /api/sessions/<id>/terminal（SSE）を Rust で読み、開いた画面の Channel にだけ送る（#9）。
// 前は "fc-term" のイベントを全部のウィンドウに emit し、出力の細かい1かたまりごとに JSON と base64 を画面で解いていた。
// 今は、出力（data と replay）の base64 を Rust で外して UTF-8 の文字列に戻し、16ms に1回までにまとめて送る。
// バイト列のままは送らない。Channel は 1KB 以上の生のバイト列を fetch でもう1往復して渡し、1KB 未満は数の配列の JSON にする。
// JSON は 8KB 未満なら1回の eval で届く（tauri 2.12 の ipc/channel.rs、MAX_RAW_DIRECT_EXECUTE_THRESHOLD と MAX_JSON_DIRECT_EXECUTE_THRESHOLD）。
// 画面は開いている端末の分だけ term_open を呼び、閉じたら term_close を呼ぶ（30本を同時に読まない）。
// term_open は世代の番号を返し、term_close はその番号の接続だけを閉じる（A→B→A と素早く切り替えても、新しい接続を閉じない）。
// 切れたら、受け取った最後の位置（id:）から ?after= で読み直す。

/// 出力をまとめる間隔。前に送ってからこれだけたっていれば、すぐ送る（打った文字の返りを遅らせない）
const TERM_FLUSH: Duration = Duration::from_millis(16);

/// 画面へ送るもの。Text は出力（data）の文字列で、まとめて送る。Event は size、replay、exit、error などで、たまった出力を先に送ってから送る
enum TermOut {
    Text(String),
    Event(String, Value),
}

struct TermConn {
    stop: Arc<AtomicBool>,
    generation: u64,
    out: std::sync::mpsc::Sender<TermOut>,
}
static TERMS: Mutex<Option<HashMap<String, TermConn>>> = Mutex::new(None);
static TERM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 開いたターミナルの画面に知らせる（書き手の送りそびれなど）。開いていなければ捨てる
fn term_notice(session_id: &str, ev: &str, data: Value) {
    if let Ok(g) = TERMS.lock() {
        if let Some(c) = g.as_ref().and_then(|m| m.get(session_id)) {
            let _ = c.out.send(TermOut::Event(ev.into(), data));
        }
    }
}

/// 続きのあるバイト列を UTF-8 の文字列に直す。末尾で途中まで来た文字は carry に残し、次の分の頭に付ける。壊れたバイトは U+FFFD にする
fn utf8_stream(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::new();
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => { out.push_str(s); rest = &[]; break; }
            Err(e) => {
                let (ok, after) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(ok).unwrap_or_default());
                match e.error_len() {
                    Some(n) => { out.push('\u{FFFD}'); rest = &after[n..]; }
                    None => { rest = after; break; }
                }
            }
        }
    }
    let keep = rest.to_vec();
    *carry = keep;
    out
}

/// 画面へ送るスレッド。出力は TERM_FLUSH に1回までにまとめ、ほかのイベントの前には必ずたまった分を送る（順を変えない）
fn spawn_term_sender(ch: tauri::ipc::Channel<Value>) -> std::sync::mpsc::Sender<TermOut> {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Instant;
    let (tx, rx) = std::sync::mpsc::channel::<TermOut>();
    std::thread::spawn(move || {
        let send_text = |buf: &mut String| {
            if !buf.is_empty() { let _ = ch.send(json!({ "ev": "data", "data": { "s": std::mem::take(buf) } })); }
        };
        let mut buf = String::new();
        let mut last = Instant::now() - TERM_FLUSH;
        loop {
            let r = if buf.is_empty() {
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                rx.recv_timeout(TERM_FLUSH.saturating_sub(last.elapsed()))
            };
            match r {
                Ok(TermOut::Text(t)) => {
                    buf.push_str(&t);
                    if last.elapsed() >= TERM_FLUSH { send_text(&mut buf); last = Instant::now(); }
                }
                Ok(TermOut::Event(ev, data)) => {
                    send_text(&mut buf);
                    let _ = ch.send(json!({ "ev": ev, "data": data }));
                    last = Instant::now();
                }
                Err(RecvTimeoutError::Timeout) => { send_text(&mut buf); last = Instant::now(); }
                Err(RecvTimeoutError::Disconnected) => { send_text(&mut buf); return; }
            }
        }
    });
    tx
}

/// ターミナルを開く。出力は on_event に送る。戻り値は世代の番号で、閉じるときに term_close に渡す
#[tauri::command]
fn term_open(session_id: String, peer: Option<String>, on_event: tauri::ipc::Channel<Value>) -> Result<u64, String> {
    let peer = peer.filter(|p| !p.is_empty());
    let stop = Arc::new(AtomicBool::new(false));
    let generation = TERM_GEN.fetch_add(1, Ordering::SeqCst);
    let out = spawn_term_sender(on_event);
    {
        let mut g = TERMS.lock().map_err(|e| e.to_string())?;
        let m = g.get_or_insert_with(HashMap::new);
        if let Some(old) = m.insert(session_id.clone(), TermConn { stop: stop.clone(), generation, out: out.clone() }) {
            old.stop.store(true, Ordering::SeqCst);
        }
    }
    let url = format!("{}/sessions/{session_id}/terminal", api(&peer));
    std::thread::spawn(move || {
        use base64::Engine;
        let mut carry: Vec<u8> = vec![];
        read_terminal(&url, &stop, |ev, data| {
            let msg = match ev {
                "data" | "replay" => {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data["b64"].as_str().unwrap_or("")).unwrap_or_default();
                    let text = utf8_stream(&mut carry, &bytes);
                    if ev == "data" { TermOut::Text(text) } else { TermOut::Event("replay".into(), json!({ "s": text })) }
                }
                // 大きさが変わると ccn は replay から送り直す。途中の文字は捨てる
                "size" => { carry.clear(); TermOut::Event(ev.into(), data) }
                _ => TermOut::Event(ev.into(), data),
            };
            let _ = out.send(msg);
        });
    });
    Ok(generation)
}

/// 端末の SSE を読み、イベントごとに emit を呼ぶ。stop が立つか exit を受けたら終わる。
/// 待機中は ping が15〜30秒ごとに来る約束なので、45秒何も来なければ切れたとみなし、最後の位置（id:）から ?after= で繋ぎ直す
fn read_terminal(url: &str, stop: &AtomicBool, mut emit: impl FnMut(&str, Value)) {
    let mut after: Option<u64> = None;
    // バイト位置は claude のプロセスごとに0から数えるので、size の epoch と組で続きを指す（ccn PR #19）
    let mut epoch: Option<String> = None;
    let mut fails = 0;
    while !stop.load(Ordering::SeqCst) {
        let a = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(45)).build();
        let u = match (after, &epoch) {
            (Some(p), Some(e)) => format!("{url}?after={p}&epoch={e}"),
            (Some(p), None) => format!("{url}?after={p}"),
            _ => url.to_string(),
        };
        let resp = match a.get(&u).call() {
            Ok(r) => { fails = 0; r }
            Err(e) => {
                fails += 1;
                emit("error", json!({ "message": format!("ターミナルに繋がらない: {e}"), "retry": fails }));
                if fails > 5 { return; }
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        let reader = BufReader::new(resp.into_reader());
        let (mut ev, mut data, mut id) = (String::new(), String::new(), None::<u64>);
        for line in reader.lines() {
            if stop.load(Ordering::SeqCst) { return; }
            let Ok(line) = line else { break };
            if line.is_empty() {
                if !ev.is_empty() || !data.is_empty() {
                    let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                    if let Some(p) = id { after = Some(p); }
                    if ev == "size" {
                        if let Some(e) = v.get("epoch").filter(|e| !e.is_null()) {
                            epoch = Some(e.as_str().map(String::from).unwrap_or_else(|| e.to_string()));
                        }
                    }
                    if ev != "ping" { emit(&ev, v); }
                    if ev == "exit" { return; }
                }
                ev.clear(); data.clear(); id = None;
            } else if let Some(x) = line.strip_prefix("event:") {
                ev = x.trim().to_string();
            } else if let Some(x) = line.strip_prefix("data:") {
                if !data.is_empty() { data.push('\n'); }
                data.push_str(x.trim_start());
            } else if let Some(x) = line.strip_prefix("id:") {
                id = x.trim().parse().ok();
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// ターミナルを閉じる。generation を渡したら、その世代の接続のときだけ閉じる
#[tauri::command]
fn term_close(session_id: String, generation: Option<u64>) -> Result<(), String> {
    let mut g = TERMS.lock().map_err(|e| e.to_string())?;
    let m = g.get_or_insert_with(HashMap::new);
    if generation.is_some() && m.get(&session_id).map(|c| c.generation) != generation {
        return Ok(());
    }
    if let Some(c) = m.remove(&session_id) {
        c.stop.store(true, Ordering::SeqCst);
    }
    drop(g);
    // 書き手の送り口を落とす。たまっている分を送り切ってからスレッドが終わる
    if let Ok(mut w) = WRITERS.lock() {
        if let Some(m) = w.as_mut() { m.retain(|k, _| !k.ends_with(&format!("|{session_id}"))); }
    }
    Ok(())
}

/// 打ったキーと大きさの変更。送るのはセッションごとの書き手のスレッド（term_send）で、命令はすぐ返る
#[tauri::command]
fn term_input(session_id: String, text: String, peer: Option<String>) -> Result<(), String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    term_send(&session_id, peer.filter(|p| !p.is_empty()), TermCmd::Input(text))
}

#[tauri::command]
fn term_resize(session_id: String, cols: u16, rows: u16, peer: Option<String>) -> Result<(), String> {
    term_send(&session_id, peer.filter(|p| !p.is_empty()), TermCmd::Resize(cols, rows))
}

enum TermCmd {
    Input(String),
    Resize(u16, u16),
}
static WRITERS: Mutex<Option<HashMap<String, std::sync::mpsc::Sender<TermCmd>>>> = Mutex::new(None);

fn writer_key(session_id: &str, peer: &Option<String>) -> String {
    format!("{}|{session_id}", peer.clone().unwrap_or_default())
}

/// キーと大きさの変更を、セッションごとに1本のスレッドで、受けた順に ccn へ送る。
/// 要求ごとに別のスレッドで送ると、打った順と届く順が入れ替わりうるため（#3）。
/// 書き手は term_close で片付ける（送り口を落とすと、残りを送り切ってからスレッドが終わる）。
fn term_send(session_id: &str, peer: Option<String>, cmd: TermCmd) -> Result<(), String> {
    let key = writer_key(session_id, &peer);
    let mut cmd = cmd;
    for _ in 0..2 {
        let tx = {
            let mut g = WRITERS.lock().map_err(|e| e.to_string())?;
            g.get_or_insert_with(HashMap::new)
                .entry(key.clone())
                .or_insert_with(|| spawn_writer(session_id.to_string(), peer.clone()))
                .clone()
        };
        match tx.send(cmd) {
            Ok(()) => return Ok(()),
            Err(std::sync::mpsc::SendError(c)) => {
                // 書き手が終わっていた。作り直してもう1回
                cmd = c;
                if let Ok(mut g) = WRITERS.lock() {
                    if let Some(m) = g.as_mut() { m.remove(&key); }
                }
            }
        }
    }
    Err("ターミナルに書けなかった（書き手を作れなかった）".into())
}

fn spawn_writer(session_id: String, peer: Option<String>) -> std::sync::mpsc::Sender<TermCmd> {
    let (tx, rx) = std::sync::mpsc::channel::<TermCmd>();
    std::thread::spawn(move || {
        let base = format!("{}/sessions/{session_id}/terminal", api(&peer));
        while let Ok(first) = rx.recv() {
            // 送っている間にたまった分をまとめる。続けて打った文字は1回で送り、大きさは続いたら最後だけ送る
            let mut merged: Vec<TermCmd> = vec![first];
            while let Ok(c) = rx.try_recv() {
                let joined = match (merged.last_mut(), &c) {
                    (Some(TermCmd::Input(a)), TermCmd::Input(b)) => { a.push_str(b); true }
                    (Some(TermCmd::Resize(c0, r0)), TermCmd::Resize(c1, r1)) => { *c0 = *c1; *r0 = *r1; true }
                    _ => false,
                };
                if !joined { merged.push(c); }
            }
            for c in merged {
                let (path, body, what) = match &c {
                    TermCmd::Input(t) => ("input", json!({ "text": t }), "ターミナルに書けなかった"),
                    TermCmd::Resize(cols, rows) => ("resize", json!({ "cols": cols, "rows": rows }), "ターミナルの大きさを変えられなかった"),
                };
                if let Err(e) = agent().post(&format!("{base}/{path}")).timeout(Duration::from_secs(5)).send_json(body) {
                    term_notice(&session_id, "input_error", json!({ "message": format!("{what}: {e}") }));
                }
            }
        }
    });
    tx
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
    #[tauri::command]
    pub async fn conversation(session_id: String, peer: Option<String>, since: Option<u64>) -> Result<super::ConvDelta, String> {
        blocking(move || super::conversation(session_id, peer, since)).await
    }
    #[tauri::command]
    pub async fn conversation_cache(session_id: String, peer: Option<String>) -> Result<Option<super::offline::ConvCache>, String> {
        blocking(move || Ok(super::conversation_cache(session_id, peer))).await
    }
    #[tauri::command]
    pub async fn send_message(session_id: String, text: String, peer: Option<String>) -> Result<String, String> {
        blocking(move || super::send_message(session_id, text, peer)).await
    }
    #[tauri::command]
    pub async fn answer_permission(session_id: String, choice: String, expect_id: Option<String>, peer: Option<String>) -> Result<String, String> {
        blocking(move || super::answer_permission(session_id, choice, expect_id, peer)).await
    }
    #[tauri::command]
    pub async fn create_session(cwd: Option<String>, prompt: Option<String>, parent: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, peer: Option<String>) -> Result<Value, String> {
        blocking(move || super::create_session(cwd, prompt, parent, name, cols, rows, peer)).await
    }
    #[tauri::command]
    pub async fn session_detail(session_id: String, peer: Option<String>) -> Result<Value, String> {
        blocking(move || super::session_detail(session_id, peer)).await
    }
    #[tauri::command]
    pub async fn teleport_info(session_id: String, peer: Option<String>) -> Result<Value, String> {
        blocking(move || super::teleport_info(session_id, peer)).await
    }
    #[tauri::command]
    pub async fn stop_session(session_id: String, peer: Option<String>) -> Result<(), String> {
        blocking(move || super::stop_session(session_id, peer)).await
    }
}

// ---------- 町の一覧の見張り（#5） ----------
//
// 画面が決まった間隔で snapshot を呼ぶのをやめ、Rust のスレッドが一覧を取り、前回と変わったときだけ Channel で画面へ送る。
// 変化が無ければ画面（JS）は一度も起きない。ccn に変化を流す口（SSE）が町の全部を覆うまでのつなぎ。
// ccn の GET /api/events は、コードを読んだ範囲では hook の状態ファイル（state/、close-check）とお手紙の変化を含まないので、まだ使わない。
// 間隔は、変化が無い回が続くと 2秒→4秒→8秒と延ばし、8秒で止める。変わったら2秒に戻す。つながらない回は毎回送り、2秒で取り直す。
// 上限を8秒にしたのは、静かな町で承認待ちや返事待ちが出たとき、画面に出るまでの遅れを8秒までに抑えるため（「あなたの番」を早く見せる）
// 画面が見えていない間は、画面が town_unwatch で止める（#6）。

/// 変化が無い回が続いたときの間隔の下限と上限
const WATCH_MIN: Duration = Duration::from_secs(2);
const WATCH_MAX: Duration = Duration::from_secs(8);

enum WatchCmd { Kick, Stop }
/// いま動いている見張り（窓は1つなので1本だけ）。世代と、止めるための口
static WATCH: Mutex<Option<(u64, std::sync::mpsc::Sender<WatchCmd>)>> = Mutex::new(None);
static WATCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 前回と同じかを比べる鍵。取得した時刻（fetched_at）は毎回変わるので除く
fn snapshot_key(s: &Snapshot) -> String {
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("fetched_at");
    }
    v.to_string()
}

/// 次に取るまでの間隔。変わったら下限に戻し、変わらなければ倍にする（上限で止める）
fn next_wait(cur: Duration, changed: bool) -> Duration {
    if changed { WATCH_MIN } else { (cur * 2).min(WATCH_MAX) }
}

/// 見張りの本体。一覧を取り、前回と変わったとき（つながらない回は毎回）だけ send に渡す。send が false を返すか Stop で終わる
fn watch_loop(peer: Option<String>, rx: std::sync::mpsc::Receiver<WatchCmd>, mut send: impl FnMut(Value) -> bool) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut last: Option<String> = None;
    let mut wait = WATCH_MIN;
    loop {
        let s = snapshot(peer.clone());
        let key = snapshot_key(&s);
        let changed = last.as_deref() != Some(key.as_str());
        // つながらない回は、同じ中身でも毎回送る（画面が続けて失敗した回数を数え、「つながりにくい」を出す）
        if (changed || !s.ccn_ok) && !send(serde_json::to_value(&s).unwrap_or(Value::Null)) {
            break;
        }
        wait = if s.ccn_ok { next_wait(wait, changed) } else { WATCH_MIN };
        last = Some(key);
        match rx.recv_timeout(wait) {
            // すぐ取り直す（新しい世帯を作った直後など）。間隔も下限に戻す
            Ok(WatchCmd::Kick) => wait = WATCH_MIN,
            Ok(WatchCmd::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// 町の一覧の見張りを始める。前の見張りがあれば止める。戻り値の世代を town_unwatch に渡す
#[tauri::command]
fn town_watch(peer: Option<String>, on_event: tauri::ipc::Channel<Value>) -> u64 {
    let (tx, rx) = std::sync::mpsc::channel::<WatchCmd>();
    let generation = WATCH_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some((_, old)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).replace((generation, tx)) {
        let _ = old.send(WatchCmd::Stop);
    }
    std::thread::spawn(move || {
        watch_loop(peer, rx, |v| on_event.send(v).is_ok());
    });
    generation
}

/// 見張りを止める。世代が今の見張りと違えば何もしない（後から始めた見張りを止めない）
#[tauri::command]
fn town_unwatch(generation: u64) {
    let mut w = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    if w.as_ref().map(|(g, _)| *g) == Some(generation) {
        if let Some((_, tx)) = w.take() {
            let _ = tx.send(WatchCmd::Stop);
        }
    }
}

/// 見張りに、すぐ取り直させる
#[tauri::command]
fn town_kick() {
    if let Some((_, tx)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = tx.send(WatchCmd::Kick);
    }
}

// ---------- 計測（#18） ----------

/// 画面の計測（src/term/perf.ts）の1行を書く。FC_PERF_LOG があればそのファイルに足し、無ければ標準エラーに出す
#[tauri::command]
fn perf_log(line: String) {
    match std::env::var("FC_PERF_LOG") {
        Ok(p) if !p.is_empty() => {
            use std::io::Write;
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{line}");
            }
        }
        _ => eprintln!("[perf] {line}"),
    }
}

/// 何もしない命令。async を付けないので、メインスレッドで動く。往復が長ければ、メインスレッドが止まっている
#[tauri::command]
fn perf_ping() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 開発用: 画面に渡すのと同じ JSON を出して終わる（ブラウザでの見た目の確認に使う）
    //   family-computing --snapshot             一覧
    //   family-computing --conversation <id>    会話
    //   family-computing --answer <sessionId> <allow|deny> [expectId]
    // identifier はビルド時の設定（開発版は tauri.conf.json、安定版は tauri.stable.conf.json を重ねたもの）から取る。
    // 下の開発用の引数も、画面と同じ置き場所を使う
    let context = tauri::generate_context!();
    let _ = APP_ID.set(context.config().identifier.clone());
    let args: Vec<String> = std::env::args().collect();
    let arg_after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    // family-computing --paths   identifier と、状態ファイルの置き場所を出す（両版で分かれているかの確認に使う）
    if args.iter().any(|a| a == "--paths") {
        let (houses_shared, houses_own) = houses_paths();
        println!("{}", serde_json::to_string_pretty(&json!({
            "identifier": APP_ID.get(),
            "shared": fc_path(Scope::Shared, ""),
            "app": fc_path(Scope::App, ""),
            "avatars": avatars_path(&None),
            "avatarsRecent": avatars::recent_path(&avatars_path(&None)),
            "housesShared": houses_shared,
            "houses": houses_own,
        })).unwrap_or_default());
        return;
    }
    // family-computing --house-name <sessionId> <名前>   世帯の名前を付ける（画面で名前を付けるのと同じ処理）。空にすると消す
    if let Some(i) = args.iter().position(|a| a == "--house-name") {
        println!("{:?}", set_house_name(args.get(i + 1).cloned().unwrap_or_default(), args.get(i + 2).cloned().unwrap_or_default()));
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
        println!("{:?}", answer_permission(sid, choice, args.get(i + 3).cloned(), None));
        return;
    }
    // family-computing --term <sessionId> [秒]   端末の SSE を読んで、イベントを1行ずつ出す（画面の端末と同じ読み方）
    if let Some(i) = args.iter().position(|a| a == "--term") {
        let sid = args.get(i + 1).cloned().unwrap_or_default();
        let secs: u64 = args.get(i + 2).and_then(|x| x.parse().ok()).unwrap_or(3);
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(secs)); s2.store(true, Ordering::SeqCst); });
        let url = format!("{}/api/sessions/{sid}/terminal", ccn_base());
        read_terminal(&url, &stop, |ev, data| {
            let n = data["b64"].as_str().map(|b| b.len()).unwrap_or(0);
            println!("{ev} {}", if n > 0 { format!("b64 {n}字") } else { data.to_string() });
        });
        return;
    }
    // family-computing --create [cwd] [prompt] [parentId]   端末のセッションを立てる（画面の「子を足す」「新しい世帯」と同じ処理）
    if let Some(i) = args.iter().position(|a| a == "--create") {
        println!("{:?}", create_session(args.get(i + 1).cloned(), args.get(i + 2).cloned(), args.get(i + 3).cloned(), None, None, None, None));
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
        .setup(|app| {
            // 開発の計測用（src/term/bench.ts）: 窓が裏にあると WebKit が描画を止め、描画の負荷を測れないので、最前面に出す
            if std::env::var("FC_BENCH_TOP").is_ok() {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(true);
                    let _ = w.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd::snapshot, cmd::town_agents, cmd::peers, cmd::conversation, cmd::conversation_cache, cmd::send_message, set_house_name, cmd::answer_permission,
            cmd::create_session, cmd::stop_session, teleport, cmd::teleport_info, cmd::session_detail, term_open, term_close, term_input, term_resize,
            perf_log, perf_ping, town_watch, town_unwatch, town_kick
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn conversation_returns_only_what_the_screen_lacks() {
        use super::{Conv, KEEP_MESSAGES};
        use serde_json::json;
        let mut c = Conv::default();
        let item = |i: usize| json!({ "role": "assistant", "text": format!("t{i}") });
        c.push((0..3).map(item).collect());
        // 初めて開いたときは全部
        let d = c.since(None);
        assert!(d.reset);
        assert_eq!(d.total, 3);
        assert_eq!(d.items.iter().map(|v| v["n"].as_u64().unwrap()).collect::<Vec<_>>(), vec![0, 1, 2]);
        // 増えていなければ空
        let d = c.since(Some(3));
        assert!(!d.reset && d.items.is_empty() && d.total == 3);
        // 増えた分だけ
        c.push(vec![item(3)]);
        let d = c.since(Some(3));
        assert!(!d.reset);
        assert_eq!(d.items, vec![json!({ "role": "assistant", "text": "t3", "n": 3 })]);
        // 一度に KEEP_MESSAGES を超えて増え、画面の持つ分が捨てた分より前になったら、全部を reset で
        c.push((4..4 + KEEP_MESSAGES + 5).map(item).collect());
        let d = c.since(Some(4));
        assert!(d.reset);
        assert_eq!(d.items.len(), KEEP_MESSAGES);
        assert_eq!(d.items[0]["n"], json!(9));
        assert_eq!(d.total, 4 + KEEP_MESSAGES as u64 + 5);
        // 画面のほうが先に進んでいる（キャッシュを作り直した）ときも reset
        assert!(c.since(Some(d.total + 1)).reset);
    }

    #[test]
    fn overlapping_reads_do_not_add_twice() {
        use super::Conv;
        use serde_json::json;
        let mut c = Conv::default();
        let fresh = || vec![json!({ "role": "user", "text": "a" })];
        // 同じ after=0 から読んだ2回。先に終わった方だけ足す
        c.absorb(0, 5, fresh());
        c.absorb(0, 5, fresh());
        assert_eq!(c.total, 1);
        assert_eq!(c.next, 5);
        c.absorb(5, 6, fresh());
        assert_eq!(c.total, 2);
    }

    #[test]
    fn idle_conversations_are_forgotten() {
        use super::{forget_idle_convs, Conv, CONV_IDLE_MS};
        use std::collections::HashMap;
        let mut m: HashMap<String, Conv> = HashMap::new();
        let now = 100 * CONV_IDLE_MS;
        m.insert("|open".into(), Conv { used: now - 2500, ..Default::default() });
        m.insert("|closed".into(), Conv { used: now - CONV_IDLE_MS - 1, ..Default::default() });
        m.insert("|asked".into(), Conv { used: 0, ..Default::default() });
        forget_idle_convs(&mut m, "|asked", now);
        let mut keys: Vec<_> = m.keys().cloned().collect();
        keys.sort();
        // 読んでいる会話と、いま読もうとしている会話は残し、長く読まれていない会話は捨てる
        assert_eq!(keys, vec!["|asked", "|open"]);
    }

    #[test]
    fn conv_delta_is_sent_as_an_object() {
        use super::ConvDelta;
        use serde_json::json;
        let d = ConvDelta { items: vec![json!({ "role": "user", "text": "a", "n": 0 })], total: 1, reset: true };
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({ "items": [{ "role": "user", "text": "a", "n": 0 }], "total": 1, "reset": true }));
    }

    /// 見張りを、モックの町（FC_CCN_URL）につないで決まった秒数だけ回し、画面へ送った回数を数える（#5）。
    /// ccn への要求の回数は、モックの /__bench/stats で数える。
    /// HOME=<空のディレクトリ> FC_CCN_URL=http://127.0.0.1:<ポート> FC_WATCH_SECS=60 <cargo test --no-run で作った試験のバイナリ> watch_against_mock --ignored --nocapture
    #[test]
    #[ignore]
    fn watch_against_mock() {
        let secs: u64 = std::env::var("FC_WATCH_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
        let (tx, rx) = std::sync::mpsc::channel::<WatchCmd>();
        let sent = Arc::new(Mutex::new(0u32));
        let s2 = sent.clone();
        let t = std::thread::spawn(move || watch_loop(None, rx, |_| { *s2.lock().unwrap() += 1; true }));
        std::thread::sleep(Duration::from_secs(secs));
        let _ = tx.send(WatchCmd::Stop);
        let _ = t.join();
        println!("見張りを {secs} 秒回して、画面へ送ったのは {} 回", sent.lock().unwrap());
    }

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
    fn watch_wait_backs_off_and_resets() {
        let mut w = WATCH_MIN;
        let mut seen = vec![];
        for _ in 0..6 { w = next_wait(w, false); seen.push(w.as_secs()); }
        assert_eq!(seen, vec![4, 8, 8, 8, 8, 8]);
        assert_eq!(next_wait(WATCH_MAX, true), WATCH_MIN);
    }

    #[test]
    fn snapshot_key_ignores_fetched_at() {
        let mk = |at: u128, n: usize| Snapshot { ccn: "x".into(), peer: None, ccn_ok: true, ccn_error: None, agents: vec![json!({"id": n})], letters: vec![], fetched_at: at, cached_at: None };
        assert_eq!(snapshot_key(&mk(1, 1)), snapshot_key(&mk(2, 1)));
        assert_ne!(snapshot_key(&mk(1, 1)), snapshot_key(&mk(1, 2)));
    }

    #[test]
    fn town_is_saved_only_when_it_changes() {
        let dir = std::env::temp_dir().join(format!("fc-town-{}-{}", std::process::id(), fastrand::u64(..)));
        let file = dir.join("towns").join("_local.json");
        let saved_at = || offline::read(&file).and_then(|c| c["savedAt"].as_u64());
        let a = json!({ "id": "a", "state": "idle", "report": { "doing": "x" } });
        let b = json!({ "id": "b", "state": "idle" });
        let t0 = now_ms();
        let mut prev = None;

        // 初めては書く
        assert!(save_town_to(&file, &[a.clone()], t0, &mut prev));
        let first = saved_at().expect("書いた");
        // 同じ中身は、どれだけ時間が経っても書かない（前は30秒ごとに書いていた）
        assert!(!save_town_to(&file, &[a.clone()], t0 + 60_000, &mut prev));
        assert!(!save_town_to(&file, &[a.clone()], t0 + 3_600_000, &mut prev));
        assert_eq!(saved_at(), Some(first));

        // 顔ぶれが変わったら、間隔を待たずに書く
        assert!(save_town_to(&file, &[a.clone(), b.clone()], t0 + 3_600_001, &mut prev));
        assert_eq!(offline::read(&file).unwrap()["agents"], json!([a, b]));

        // 顔ぶれが同じで中身だけ変わったら、前の書き込みから TOWN_SAVE_GAP_MS 空けて書く
        let a2 = json!({ "id": "a", "state": "running", "report": { "doing": "y" } });
        let t1 = t0 + 3_600_001;
        assert!(!save_town_to(&file, &[a2.clone(), b.clone()], t1 + 1_000, &mut prev));
        assert!(save_town_to(&file, &[a2.clone(), b.clone()], t1 + TOWN_SAVE_GAP_MS, &mut prev));
        assert_eq!(offline::read(&file).unwrap()["agents"], json!([a2, b]));

        // 起動し直した（前回の記録が無い）ときは、保存してあるファイルと比べ、同じなら書かない
        let before = saved_at();
        let mut fresh = None;
        assert!(!save_town_to(&file, &[a2.clone(), b.clone()], t0 + 7_200_000, &mut fresh));
        assert_eq!(saved_at(), before);
        // 違えば書く
        let mut fresh = None;
        assert!(save_town_to(&file, &[a.clone()], t0 + 7_200_000, &mut fresh));

        let _ = fs::remove_dir_all(&dir);
    }

    use super::*;

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
    fn stable_conf_identifier_matches() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.stable.conf.json")).unwrap();
        assert_eq!(conf["identifier"], STABLE_ID);
        let dev: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_ne!(dev["identifier"], STABLE_ID);
    }

    // 2026-11-12 に本番のノードの pty のセッションから読んだ messages の形
    #[test]
    fn pty_messages_are_read_from_data() {
        let user = json!({"at": 1794490104245u64, "type": "user", "seq": 1,
            "data": {"type": "user", "message": {"role": "user", "content": "from local via konaito-pro\n\nちゃんと動くのかテスト"}}});
        let out = simplify(&user);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["text"], "ちゃんと動くのかテスト");
        assert_eq!(out[0]["from"], "from local via konaito-pro");
        assert_eq!(out[0]["at"], 1794490104245u64);

        let asst = json!({"at": 1794490107988u64, "type": "assistant", "seq": 2,
            "data": {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "届いてる"}]}}});
        let out = simplify(&asst);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "assistant");
        assert_eq!(out[0]["text"], "届いてる");

        let result = json!({"at": 1794490107988u64, "type": "result", "seq": 3, "data": {"type": "result", "result": "届いてる"}});
        assert!(simplify(&result).is_empty());
    }

    #[test]
    fn utf8_stream_keeps_split_characters() {
        let all = "あ❯x".as_bytes();
        let mut carry = vec![];
        // 「あ」の3バイトを途中で切る
        assert_eq!(utf8_stream(&mut carry, &all[..2]), "");
        assert_eq!(utf8_stream(&mut carry, &all[2..5]), "あ");
        assert_eq!(utf8_stream(&mut carry, &all[5..]), "❯x");
        assert!(carry.is_empty());
        // 壊れたバイトは置き換えて先へ進む
        assert_eq!(utf8_stream(&mut carry, &[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn node_messages_keep_the_transcript_shape() {
        let asst = json!({"type": "assistant", "timestamp": "2026-11-12T13:00:00Z",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "はい"}]}});
        let out = simplify(&asst);
        assert_eq!(out[0]["text"], "はい");
        assert_eq!(out[0]["at"], "2026-11-12T13:00:00Z");
        // トランスクリプトの行に data が付いていても、message があればそちらを読む
        let with_data = json!({"type": "user", "timestamp": "t", "data": {"type": "hook_progress"}, "message": {"role": "user", "content": "やあ"}});
        assert_eq!(simplify(&with_data)[0]["text"], "やあ");
    }
}
