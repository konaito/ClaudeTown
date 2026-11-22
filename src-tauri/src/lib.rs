// family-computing の裏側。画面から呼ばれる命令:
// - snapshot: この機械の Claude Code の記録（native/）、このアプリが立てた端末（pty.rs）、hook の報告、close-check の判定を1つにまとめる
// - conversation(session_id, since): セッションの jsonl を差分で読み、画面に出す形（発言と道具の1行）に縮め、画面がまだ持っていない分だけ返す
// - create_session / stop_session: 新しい世帯の claude をこのアプリの中の端末で起動する、止める（pty.rs）
// - term_open / term_close / term_input / term_resize: このアプリが立てた端末を読み書きし、開いた画面の Channel へ流す
// - house_places: 新しい世帯のペインの「最近の場所」の材料（places.rs）
// - prompt_history / slash_commands / file_suggestions / send_direct / interrupt_session: チャットの入力欄を CLI と同じ動きにする（composer.rs）
// - session_settings / switch_session / cancel_switch: モデルと権限モードを読む、替える、予約を取り消す（switch.rs）
// ファイルを読む命令は spawn_blocking で動かし、メインスレッドを止めない（下の「画面から呼ぶ命令」）。
// 操作（送信、停止、端末）は、このアプリが立てたセッションにだけできる。ほかのセッションは記録から読むだけ。

mod account;
mod attach;
mod avatars;
mod composer;
mod dialog;
mod naming;
mod places;
mod pty;
mod repo;
mod switch;
mod native;
mod perf;
use perf::*;
mod conversation;
use conversation::*;
mod session_ops;
mod terminal;
use terminal::*;
mod watch;
use watch::*;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
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

/// ~/.family-computing の下のファイルの置き場所を決める。Rust で置き場所を組み立てるのはここだけにする。
/// FC_SHARED_HOME は ~/.family-computing そのものを差し替える（軽さの計測 scripts/bench.ts が、本物の letters.jsonl と state/ を読まないために使う、#187）
fn fc_path(scope: Scope, name: &str) -> PathBuf {
    let env = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
    place(&home(), env("FC_SHARED_HOME"), APP_ID.get().map(String::as_str), env("FC_APP_HOME"), scope, name)
}

/// fc_path の中身（試験のために環境から切り離してある）。
/// App は、FC_APP_HOME があればそこ、identifier が安定版の値か分からないときは ~/.family-computing、それ以外（開発版）は ~/.family-computing/dev。
/// 分からないときに安定版と同じ場所へ落とすのは、逆にすると安定版が割り当てと世帯の名前を見失うため。
/// shared_home（FC_SHARED_HOME）があれば、~/.family-computing の代わりにそこを使う
fn place(home: &std::path::Path, shared_home: Option<String>, app_id: Option<&str>, app_home: Option<String>, scope: Scope, name: &str) -> PathBuf {
    let shared = shared_home.map(PathBuf::from).unwrap_or_else(|| home.join(".family-computing"));
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
/// snapshot は一覧を取るたびに、セッションごとの state/{id}.json と close-check/{id}.jsonを読む。
/// 無いファイルは覚えない（できたら次の回に読む）
fn read_json_cached(p: &std::path::Path) -> Option<Value> {
    type Entry = (FileStamp, Option<Value>);
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, Entry>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(meta) = fs::metadata(p) else {
        cache.lock().unwrap_or_else(|e| e.into_inner()).remove(p);
        return None;
    };
    let st = stamp_of(&meta);
    if let Some((s, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(p)
        && *s == st && st.modified.is_some() {
            return v.clone();
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
    agents: Vec<Value>,
    /// お手紙（セッションどうしのやり取り）の最近の記録。hook が ~/.family-computing/letters.jsonl に書く
    letters: Vec<Value>,
    fetched_at: u128,
    /// 一覧の出どころの件数（#96）。native は Claude Code の記録から読んだ件数、app はこのアプリが立てた端末の数
    sources: Option<Value>,
}

/// このアプリが立てていないセッションへの操作を断る
fn app_guard(session_id: &str) -> Result<(), String> {
    if pty::owns(session_id) { Ok(()) } else { Err(native::READ_ONLY.into()) }
}

fn refuse_if_disabled() -> Result<(), String> {
    if send_disabled() { Err("送信を止めている（~/.family-computing/send-disabled がある）".into()) } else { Ok(()) }
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

/// 町の一覧の行。Claude Code の記録から読んだセッション、sub-agent、チームメイトに、このアプリが立てた端末を重ねる。
/// このアプリが立てたもので、まだ sessions/<pid>.json が無い（起動したばかり）ものは、台帳から仮の行を作る
fn town_rows() -> Vec<Value> {
    let n = native::list(&native::claude_home(), native::now_ms());
    let mut rows: Vec<Value> = n.sessions.into_iter().chain(n.subagents).collect();
    // /clear で id が変わっても同じ pid なら同じ端末。一覧で見えた id を台帳に足してから、どれがこのアプリのものかを決める
    pty::note_ids(&rows.iter().filter(|r| r["kind"] == "terminal").filter_map(|r| Some((r["id"].as_str()?.to_string(), r["pid"].as_u64()? as u32))).collect::<Vec<_>>());
    let seen: HashSet<String> = rows.iter().filter_map(|r| r["id"].as_str().map(String::from)).collect();
    let mut app = 0;
    for p in pty::list() {
        app += 1;
        if p.ids.iter().any(|i| seen.contains(i)) {
            continue;
        }
        rows.push(json!({
            "id": p.id, "kind": "terminal", "state": "idle", "cwd": p.cwd, "pid": p.pid, "startedAt": p.started_at,
            "lastActivityAt": p.started_at, "parent": null, "title": null,
        }));
    }
    for r in rows.iter_mut() {
        let mine = r["id"].as_str().is_some_and(pty::owns);
        // 記録から読んだ行は、読んだ側が決めた能力を残す（受信ソケットのあるセッションは送れる、#156）
        if mine {
            r["capabilities"] = app_caps();
            r["source"] = json!("app");
            // claude が入力を受け付けるところまで起動していない（信頼の確認の画面を含む）。画面は「起動中」と出す
            if r["id"].as_str().and_then(composer::booted) == Some(false) {
                r["booting"] = json!(true);
            }
        } else if r["capabilities"].is_null() {
            r["capabilities"] = native::read_only_caps();
        }
    }
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
    *LAST_SOURCES.lock().unwrap_or_else(|e| e.into_inner()) = Some(json!({ "native": st, "app": app }));
    rows
}

/// このアプリが立てたセッションでできること。承認は、端末の承認の画面にキーを書いて答える（dialog.rs、#83）
fn app_caps() -> Value {
    json!({ "send": true, "permissions": true, "interrupt": true, "stop": true, "terminal": true, "events": false })
}

/// 一覧の行を、画面に渡すセッションの形に直す。hook の報告と close-check の判定を足す。キャラの割り当ては足さない
fn agents_from(rows: Vec<Value>) -> Vec<Value> {
    let live_ids: HashSet<String> = rows.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();
    // 別のプロダクト（ccn など）が子に付ける from 行の呼び手（"agent:<ノード>/<sid8>/<役割>"）から親を引く。Claude Code の記録の1行目にある
    let parent_from_line = |s: &Value| -> Option<String> {
        let p = s["parent"].as_str()?;
        let sid8 = p.strip_prefix("agent:")?.split('/').nth(1)?;
        live_ids.iter().find(|id| id.starts_with(sid8)).cloned()
    };

    // 名前は、そのセッションが作業しているプロジェクトの名前（src-tauri/src/naming.rs）
    let whos: Vec<naming::Who> = rows.iter().map(|s| {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let cwd = s["cwd"].as_str().filter(|c| !c.is_empty());
        naming::Who {
            cwd: cwd.map(String::from),
            title: s["title"].as_str().map(String::from),
            project: cwd.and_then(|c| naming::project_of(c, true)),
            id,
        }
    }).collect();
    let name_of = naming::card_names(&whos);
    let project_of: HashMap<&str, Option<&String>> = whos.iter().map(|w| (w.id.as_str(), w.project.as_ref())).collect();
    let mut agents = vec![];
    for s in &rows {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        // sub-agent とチームメイトは置き場所で決めた親（#96）。ほかは from 行の呼び手。親が生きていなければ根として扱う
        let native_parent = s["native"]["parentId"].as_str().filter(|p| live_ids.contains(*p)).map(String::from);
        let parent = native_parent.or_else(|| parent_from_line(s)).filter(|p| *p != id);
        // sub-agent と in-process のチームメイトは、リードと同じ session id で hook が届くので、hook の報告を使わない。
        // 様子は meta.json の説明と jsonl の末尾から作る。tmux のチームメイトは自分の session id を持つので hook の報告を読む
        let from_meta = s["native"]["report"].is_object();
        let (report, close_check) = if from_meta {
            (Some(s["native"]["report"].clone()), None)
        } else {
            (
                read_json_cached(&fc_path(Scope::Shared, &format!("state/{id}.json"))),
                read_json_cached(&native::claude_home().join(format!("close-check/{id}.json"))),
            )
        };
        let named = matches!(s["kind"].as_str(), Some("subagent") | Some("teammate"));
        agents.push(json!({
            "id": id,
            // sub-agent とチームメイトは、親と同じプロジェクトの名前になって見分けられないので、チームメイトの名前か種類（Explore など）にする
            "name": if named { s["title"].clone() } else { json!(name_of.get(&id)) },
            // 一覧の出どころ。app はこのアプリが立てた端末、native は Claude Code の記録から読んでいるだけで、操作はできない
            "source": s.get("source").cloned().unwrap_or(json!("native")),
            // cwd のプロジェクトの名前（worktree なら本体の名前）
            "project": project_of.get(id.as_str()).copied().flatten(),
            "kind": s["kind"],
            "state": s["state"],
            "cwd": s["cwd"],
            "pid": s["pid"],
            "startedAt": s["startedAt"],
            "lastActivityAt": s["lastActivityAt"],
            // claude が入力を受け付けるところまで起動していない（town_rows が付ける）。起動していれば null
            "booting": s["booting"].as_bool().filter(|b| *b),
            "canSend": s["capabilities"]["send"],
            "parent": parent,
            "capabilities": s["capabilities"],
            "report": report,
            // status が ok/ng なら short は直下、working/checking なら前回の判定が last に入っている
            "closeCheck": close_check.map(|c| json!({
                "status": c["status"],
                "short": if c["short"].is_string() { c["short"].clone() } else { c["last"]["short"].clone() },
            })),
        }));
    }
    agents
}

/// 最後に作った町の一覧の出どころ（Snapshot の sources）
static LAST_SOURCES: Mutex<Option<Value>> = Mutex::new(None);

/// 画面に渡す町を作る。キャラの割り当て、状態ファイル、お手紙はここで足す
fn snapshot() -> Snapshot {
    let mut agents = agents_from(town_rows());
    // キャラの絵の割り当て。世代（親をたどった深さ）に合う見た目を重み付きの乱数で選び、保存して以後変えない
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
    let path = avatars_path();
    let next = {
        // 読む、決める、書くの間に、同じアプリの別の snapshot が割り込まないようにする
        let _guard = AVATARS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (prev, mut recent) = avatars::load(&path);
        let before = recent.clone();
        let next = avatars::assign(&prev, &mut recent, &live, &mut fastrand::Rng::new());
        if next != prev || recent != before {
            avatars::save(&path, &next, &recent);
        }
        next
    };
    for a in agents.iter_mut() {
        if let Some(v) = a["id"].as_str().and_then(|id| next.get(id)) {
            a["avatar"] = json!({ "char": v.char, "hue": v.hue });
        }
    }
    let sources = LAST_SOURCES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Snapshot { agents, letters: recent_letters(), fetched_at: now_ms(), sources }
}

static AVATARS_LOCK: Mutex<()> = Mutex::new(());

/// キャラの割り当ての保存先。FC_AVATARS で差し替えられる（試すときに本物の割り当てを消さないため）。
/// 直近の記録（avatars-recent.json）は、同じ場所に avatars::recent_path が組み立てる。開発版はどれも dev/ の下になる
fn avatars_path() -> PathBuf {
    std::env::var("FC_AVATARS").map(PathBuf::from).unwrap_or_else(|_| fc_path(Scope::App, "avatars.json"))
}

// ---------- 画面から呼ぶ命令（#3） ----------
// async の付かない命令は Tauri のメインスレッドで動く（Tauri 2 の説明「Calling Rust from the Frontend」:
// "Commands without the async keyword are executed on the main thread unless defined with #[tauri::command(async)]"）。
// ファイルを読む命令（一覧、会話、履歴）は、待つ間に画面の描画と入力を止めないよう、ここで spawn_blocking に移す。
// 中身の関数は同期のまま残し、開発用の --snapshot などからも呼ぶ。

/// 待ってよいスレッドで f を動かし、結果を待つ
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

mod cmd {
    use super::*;

    #[tauri::command]
    pub async fn snapshot() -> Result<Snapshot, String> { blocking(|| Ok(super::snapshot())).await }
}

/// 開発用の引数 --paths。identifier と、状態ファイルの置き場所を出す
fn print_paths() {
    println!("{}", serde_json::to_string_pretty(&json!({
        "identifier": APP_ID.get(),
        "shared": fc_path(Scope::Shared, ""),
        "app": fc_path(Scope::App, ""),
        "avatars": avatars_path(),
        "avatarsRecent": avatars::recent_path(&avatars_path()),
    })).unwrap_or_default());
}

/// 開発用の引数 --native-list。~/.claude（FC_CLAUDE_HOME）から一覧を2回作り、件数と時間だけを出す
fn print_native_list() {
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
}

/// 開発用の引数 --snapshot。画面に渡すのと同じ一覧の JSON を出す
fn print_snapshot() {
    println!("{}", serde_json::to_string_pretty(&snapshot()).unwrap_or_default());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 開発用: 画面に渡すのと同じ JSON を出して終わる（ブラウザでの見た目の確認に使う）
    //   family-computing --snapshot             一覧
    //   family-computing --conversation <id>    会話
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
        print_paths();
        return;
    }
    // family-computing --native-list   ~/.claude（FC_CLAUDE_HOME）から一覧を2回作り、件数と時間だけを出す（中身の文は出さない。#96）。
    // 生きているセッションの会話を末尾から読んだ件数と時間も出す。読むだけで、~/.claude にも ~/.family-computing にも書かない
    if args.iter().any(|a| a == "--native-list") {
        print_native_list();
        return;
    }
    if args.iter().any(|a| a == "--snapshot") {
        print_snapshot();
        return;
    }
    if let Some(id) = arg_after("--conversation") {
        // 出力の形は前と同じ（Ok に項目の配列）。public/dev-conversation.json に使う。jsonl の場所を登録するために、先に一覧を作る
        let _ = town_rows();
        println!("{}", serde_json::to_string_pretty(&conversation(id, None).map(|d| d.items)).unwrap_or_default());
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 前回開いていた端末を立て直す（#152）。ログインシェルに PATH を聞くので（最大5秒）、別のスレッドで
            if std::env::var("FC_NO_RESTORE").is_err() {
                std::thread::spawn(session_ops::restore_terminals);
            }
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
            cmd::snapshot, conversation::cmd::conversation,
            session_ops::cmd::create_session, session_ops::cmd::resume_session, session_ops::cmd::stop_session, session_ops::cmd::house_places, repo::cmd::place_repos,
            term_open, term_close, term_input, term_resize,
            perf_log, perf_ping, perf_window, town_watch, town_unwatch, town_kick,
            composer::cmd::prompt_history, composer::cmd::slash_commands, composer::cmd::file_suggestions, composer::cmd::send_direct, composer::cmd::send_or_queue, composer::cmd::cancel_queued, composer::cmd::boot_status, composer::cmd::interrupt_session, attach::cmd::paste_clipboard, attach::cmd::stage_files,
            switch::cmd::session_settings, dialog::cmd::session_detail, dialog::cmd::answer_dialog, switch::cmd::switch_session, switch::cmd::cancel_switch
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, ev| {
            // アプリを終えるとき、ここから立てた claude を全部止める（pty.rs）。Exit は窓を閉じても ⌘Q でも来る
            if let tauri::RunEvent::Exit = ev {
                pty::kill_all();
            }
        });
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


    /// Report（src/model.ts）の形。hook が足すだけで Report には無いキーは HOOK_ONLY に分ける。
    /// deny_unknown_fields なので、見本に知らないキーが出たら読めずに落ちる
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct ReportShape {
        phase: Option<String>,
        asked: Option<String>,
        doing: Option<String>,
        said: Option<String>,
        next: Option<String>,
        needs: Option<String>,
        tools: Option<u64>,
        turn_started_at: Option<u64>,
        updated_at: Option<u64>,
        pending: Option<PermShape>,
        pending_count: Option<u64>,
        perm_queue: Option<Vec<PermShape>>,
        session_id: Option<String>,
        asked_by: Option<String>,
        cwd: Option<String>,
    }
    /// Report に無く、hook だけが書くキー
    const HOOK_ONLY: [&str; 3] = ["session_id", "asked_by", "cwd"];

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct PermShape {
        tool: String,
        summary: String,
        detail: String,
        id: Option<String>,
    }

    /// src/report-cases.json（hooks/test_report_fixture.py が fc-report.py の実出力と突き合わせる。bun test は src/report.test.ts で同じものを読む）
    #[test]
    fn report_cases() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            state: Value,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../src/report-cases.json")).unwrap();
        assert!(cases.len() >= 8);
        // src/model.ts の Report のキー（型の本体の行から拾う）
        let model = include_str!("../../src/model.ts");
        let body = model.split("export type Report = {").nth(1).and_then(|s| s.split("\n};").next()).unwrap();
        let keys: Vec<&str> = body
            .lines()
            .filter(|l| l.starts_with("  ") && !l.trim_start().starts_with("/**"))
            .filter_map(|l| l.trim_start().split(['?', ':']).next())
            .collect();
        assert_eq!(keys.len(), 12, "Report のキー: {keys:?}");
        let dir = std::env::temp_dir().join(format!("fc-report-cases-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        for (i, c) in cases.iter().enumerate() {
            // snapshot が使う読み方（read_json_cached）で読んだ中身を、Report の形で解釈する
            let p = dir.join(format!("{i}.json"));
            fs::write(&p, c.state.to_string()).unwrap();
            let got = read_json_cached(&p).unwrap();
            assert_eq!(got, c.state, "{}", c.name);
            let shape: ReportShape = serde_json::from_value(got).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            assert!(matches!(shape.phase.as_deref(), Some("working" | "needs_you" | "resting")), "{}", c.name);
            for k in c.state.as_object().unwrap().keys() {
                assert!(keys.contains(&k.as_str()) || HOOK_ONLY.contains(&k.as_str()), "{}: model.ts の Report に無いキー {k}", c.name);
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_keeps_app_files_apart_from_stable() {
        let h = std::path::Path::new("/h");
        let p = |id: Option<&str>, over: Option<&str>, scope, name| place(h, None, id, over.map(String::from), scope, name);
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
        // FC_SHARED_HOME は ~/.family-computing そのものを差し替える（#187）。FC_APP_HOME が無い開発版のアプリの分は、その下の dev/
        let s = |id: Option<&str>, over: Option<&str>, scope, name| place(h, Some("/s".into()), id, over.map(String::from), scope, name);
        assert_eq!(s(dev, None, Scope::Shared, "letters.jsonl"), PathBuf::from("/s/letters.jsonl"));
        assert_eq!(s(dev, None, Scope::Shared, "state/x.json"), PathBuf::from("/s/state/x.json"));
        assert_eq!(s(dev, None, Scope::App, "avatars.json"), PathBuf::from("/s/dev/avatars.json"));
        assert_eq!(s(dev, Some("/t"), Scope::App, "terminals.json"), PathBuf::from("/t/terminals.json"));
    }

    #[test]
    fn town_lets_send_to_native_session_with_socket() {
        // 受信ソケットのあるセッションは、Town が立てていなくても画面で送れる（#156）。割り込みと端末はできない
        let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use native::testtree::*;
        let root = tmp("town-sock");
        let a = "dddddddd-0000-4000-8000-00000000000d";
        let pid = std::process::id();
        let sock = PathBuf::from(format!("/tmp/fc-town-sock-{pid}-{}.sock", fastrand::u32(..)));
        let _l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        write(&root.join(format!("sessions/{pid}.json")), &json!({ "pid": pid, "sessionId": a, "cwd": "/tmp/合成/a", "startedAt": 1_000u64,
            "kind": "interactive", "status": "idle", "updatedAt": 2_000u64, "messagingSocketPath": sock }).to_string());
        native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root.clone()));
        let agents = agents_from(town_rows());
        native::TEST_HOME.with(|h| *h.borrow_mut() = None);
        let _ = std::fs::remove_file(&sock);
        let me = agents.iter().find(|x| x["id"] == a).cloned().unwrap_or(Value::Null);
        assert_eq!(me["source"], "native");
        assert_eq!(me["canSend"], true);
        assert_eq!(me["capabilities"]["interrupt"], false);
        assert_eq!(me["capabilities"]["terminal"], false);
    }

    #[test]
    fn town_reads_native_sessions_and_subagents() {
        // 会話を読む先の登録（native::register）はプロセスで1つなので、使う試験を1本ずつ動かす
        let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use native::testtree::*;
        // 合成の ~/.claude: セッション A（sub-agent 1体）と、from 行で A の子になるセッション B
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
        let agents = agents_from(town_rows());
        let by = |id: &str| agents.iter().find(|x| x["id"] == id).cloned().unwrap_or(Value::Null);
        // どちらもこのアプリが立てたものではないので、読むだけ。B は from 行から A の子になる
        assert_eq!(by(a)["source"], "native");
        assert_eq!(by(a)["canSend"], false);
        assert_eq!(by(b)["capabilities"]["terminal"], false);
        assert_eq!(by(b)["parent"], a);
        let x1 = native::subagents::sub_id("x1", a);
        assert_eq!(by(&x1)["kind"], "subagent");
        assert_eq!(by(&x1)["parent"], a);
        assert_eq!(by(&x1)["name"], "Explore");
        assert_eq!(by(&x1)["report"]["asked"], "探す");
        assert_eq!(agents.len(), 3);
        // 操作は、このアプリが立てていないものを全部断る
        assert!(app_guard(a).is_err());
        assert!(app_guard(&x1).is_err());
        // 会話は jsonl から読む（印は native:）
        let path = native::path_of(b).unwrap();
        let (next, items, _, epoch) = read_native(&path, 0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], "やって");
        assert!(epoch.unwrap().starts_with("native:"));
        assert_eq!(next, fs::metadata(&path).unwrap().len());
        let d = conversation(b.into(), None).unwrap();
        assert_eq!(d.items.len(), 1);
        assert_eq!(LAST_SOURCES.lock().unwrap().as_ref().unwrap()["app"], 0);
        native::TEST_HOME.with(|h| *h.borrow_mut() = None);
    }

    #[test]
    fn stable_conf_identifier_matches() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.stable.conf.json")).unwrap();
        assert_eq!(conf["identifier"], STABLE_ID);
        let dev: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_ne!(dev["identifier"], STABLE_ID);
    }

}
