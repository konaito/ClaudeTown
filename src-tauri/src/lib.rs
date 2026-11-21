// family-computing の裏側。画面から呼ばれる命令:
// - snapshot: この機械の Claude Code の記録（native/）、このアプリが立てた端末（pty.rs）、hook の報告、close-check の判定を1つにまとめる
// - conversation(session_id, since): セッションの jsonl を差分で読み、画面に出す形（発言と道具の1行）に縮め、画面がまだ持っていない分だけ返す
// - create_session / stop_session: 新しい世帯の claude をこのアプリの中の端末で起動する、止める（pty.rs）
// - term_open / term_close / term_input / term_resize: このアプリが立てた端末を読み書きし、開いた画面の Channel へ流す
// - house_places: 新しい世帯のペインの「最近の場所」の材料（places.rs）
// - prompt_history / slash_commands / file_suggestions / send_direct / interrupt_session: チャットの入力欄を CLI と同じ動きにする（composer.rs）
// ファイルを読む命令は spawn_blocking で動かし、メインスレッドを止めない（下の「画面から呼ぶ命令」）。
// 操作（送信、停止、端末）は、このアプリが立てたセッションにだけできる。ほかのセッションは記録から読むだけ。

mod attach;
mod avatars;
mod composer;
mod naming;
mod places;
mod pty;
mod repo;
mod native;

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
/// snapshot は一覧を取るたびに、セッションごとの state/{id}.json と close-check/{id}.json を読む。
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
        r["capabilities"] = if mine { app_caps() } else { native::read_only_caps() };
        if mine {
            r["source"] = json!("app");
        }
    }
    native::register(native::paths_of(&rows.iter().collect::<Vec<_>>()));
    *LAST_ROWS.lock().unwrap_or_else(|e| e.into_inner()) = rows.iter()
        .filter_map(|r| Some((r["id"].as_str()?.to_string(), json!({ "state": r["state"], "startedAt": r["startedAt"], "lastActivityAt": r["lastActivityAt"] }))))
        .collect();
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

/// 最後に作った一覧の、id ごとの状態（state、startedAt、lastActivityAt）。送る前の確認（composer::check_direct）に使う
static LAST_ROWS: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());

fn native_state(id: &str) -> Option<Value> {
    LAST_ROWS.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| k == id).map(|(_, v)| v.clone())
}

/// このアプリが立てたセッションでできること。承認は端末で答える（構造化した承認の口は無い）
fn app_caps() -> Value {
    json!({ "send": true, "permissions": false, "interrupt": true, "stop": true, "terminal": true, "events": false })
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
                read_json_cached(&home().join(format!(".claude/close-check/{id}.json"))),
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

// ---------- 家の名前 ----------

/// 世帯の名前の置き場所。（共有の分, アプリが書く分）を返す。
/// 旧版が書いた houses.json の置き場所。今は名前に使わない（--paths の表示だけに残してある）。
/// 安定版では2つは同じファイル。FC_HOUSES があれば、両方ともそのファイルにする
fn houses_paths() -> (PathBuf, PathBuf) {
    match std::env::var("FC_HOUSES") {
        Ok(p) if !p.is_empty() => (PathBuf::from(&p), PathBuf::from(p)),
        _ => (fc_path(Scope::Shared, "houses.json"), fc_path(Scope::App, "houses.json")),
    }
}

// ---------- 会話 ----------

#[derive(Default)]
struct Conv {
    /// jsonl の次の読み位置（バイト）
    next: u64,
    /// next の数え方の印（native:<inode>）。ファイルが入れ替わったら変わる
    epoch: Option<String>,
    /// これまでに縮めた項目の数。項目の通し番号 n は 0 から数える
    total: u64,
    /// 最後の KEEP_MESSAGES 件
    items: Vec<Value>,
    /// 最後に読まれた時刻（ms）
    used: u128,
    /// 今の動き（#59）
    live: Live,
}

/// 今の動き（#59）。会話を頭から読みながら、結果がまだ無い道具、最後の出来事、ターンの始まりを持つ。
/// 時刻は jsonl の timestamp（ISO の文字列。data で包んだ形では at の ms）のまま渡し、画面が Date で読む
#[derive(Default, Clone, Serialize, Debug, PartialEq)]
struct Live {
    /// 結果がまだ無い道具（古い順）
    tools: Vec<LiveTool>,
    /// 最後の出来事の種類（user、thinking、text、tool、result）と時刻
    last: Option<&'static str>,
    last_at: Value,
    /// 最後に人（かほかのセッション）から文が届いた時刻
    turn_at: Value,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
struct LiveTool {
    id: String,
    /// まとめるときの種類（シェル、MCP のサーバー名など）
    kind: String,
    /// 1行の中身（Bash ならコマンドの頭）
    text: String,
    at: Value,
}

#[derive(Debug, Clone)]
enum LiveEv {
    User(Value),
    Thinking(Value),
    Text(Value),
    Tool(LiveTool),
    Result(Vec<String>, Value),
}

impl Live {
    fn apply(&mut self, ev: LiveEv) {
        let (kind, at) = match ev {
            // 新しい文が来たら、前のターンで結果が来なかった道具（中断など）は捨てる
            LiveEv::User(at) => { self.tools.clear(); self.turn_at = at.clone(); ("user", at) }
            LiveEv::Thinking(at) => ("thinking", at),
            LiveEv::Text(at) => ("text", at),
            LiveEv::Tool(t) => { let at = t.at.clone(); self.tools.retain(|x| x.id != t.id); self.tools.push(t); ("tool", at) }
            LiveEv::Result(ids, at) => { self.tools.retain(|x| !ids.contains(&x.id)); ("result", at) }
        };
        self.last = Some(kind);
        self.last_at = at;
    }
}

/// 道具をまとめるときの種類
fn tool_kind(name: &str) -> String {
    match name {
        "Bash" | "BashOutput" | "KillShell" => "シェル".into(),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "書く".into(),
        "Read" => "読む".into(),
        "Grep" | "Glob" => "探す".into(),
        "WebSearch" | "WebFetch" => "調べる".into(),
        "Agent" | "Task" => "手伝い".into(),
        n if n.starts_with("mcp__") => n.split("__").nth(1).unwrap_or(n).into(),
        n => n.into(),
    }
}

/// CLI が貼り付けた文に付ける包み（`<pasted_content id="…">` と `</pasted_content id="…">`）を外す。
/// 文を端末に貼って送ると、送った文が包まれて記録されることがある（2026-11-14 の meta、8074d764 の jsonl）。
/// 包みのまま `<` で始まると、hook の差し込みと見分けられず会話から落ちていた（#69）。外した後の前後の空白は落とす
fn unwrap_pasted(text: &str) -> String {
    const TAGS: [&str; 2] = ["<pasted_content", "</pasted_content"];
    if !text.contains("pasted_content") {
        return text.trim().to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((i, tag)) = TAGS.iter().filter_map(|t| rest.find(t).map(|i| (i, *t))).min_by_key(|(i, _)| *i) {
        let tail = &rest[i..];
        // 包みの印は、名前の直後が空白か > で、1行に収まり > で閉じるもの
        let end = tail.find('>').filter(|&j| !tail[..j].contains('\n'));
        let named = matches!(tail[tag.len()..].chars().next(), Some(' ') | Some('>'));
        match end {
            Some(j) if named => {
                out.push_str(&rest[..i]);
                rest = &tail[j + 1..];
            }
            _ => {
                out.push_str(&rest[..i + 1]);
                rest = &rest[i + 1..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 先頭に並んだ画像の印（[Image #3]）と、その後ろの文に分ける。印が無ければ ("", text)
fn split_image_marks(text: &str) -> (&str, &str) {
    let mut i = 0;
    while let Some(r) = text[i..].strip_prefix("[Image #") {
        let digits = r.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || !r[digits..].starts_with(']') {
            break;
        }
        i += "[Image #".len() + digits + 1;
        i += text[i..].len() - text[i..].trim_start_matches([' ', '\t']).len();
    }
    (text[..i].trim_end(), &text[i..])
}

/// user の行の文。文の部分をつなぎ、貼り付けの包みを外す
fn user_text(content: &Value) -> String {
    match content {
        Value::String(s) => unwrap_pasted(s),
        Value::Array(a) => unwrap_pasted(&a.iter().filter(|c| c["type"] == "text").filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")),
        _ => String::new(),
    }
}

/// 会話の1行から、今の動きに効く出来事を取り出す。simplify と同じく、jsonl の行と data で包んだ形の両方を読む
fn live_events(m: &Value) -> Vec<LiveEv> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, if d["timestamp"].is_string() { d["timestamp"].clone() } else { m["at"].clone() }),
        None => (m, m["timestamp"].clone()),
    };
    let content = &m["message"]["content"];
    let mut out = vec![];
    match m["type"].as_str().unwrap_or("") {
        "user" => {
            let ids: Vec<String> = content.as_array().map(|a| a.iter()
                .filter(|c| c["type"] == "tool_result")
                .filter_map(|c| c["tool_use_id"].as_str().map(String::from))
                .collect()).unwrap_or_default();
            if !ids.is_empty() {
                out.push(LiveEv::Result(ids, at));
            } else {
                let text = user_text(content);
                // hook やシステムの差し込み（<...>、Caveat:）はターンの始まりにしない。お手紙（<cross-session-message>）は始まりにする
                let letter = text.contains("<cross-session-message");
                if !text.is_empty() && !m["isMeta"].as_bool().unwrap_or(false) && (letter || !(text.starts_with('<') || text.starts_with("Caveat:"))) {
                    out.push(LiveEv::User(at));
                }
            }
        }
        "assistant" => {
            for c in content.as_array().into_iter().flatten() {
                match c["type"].as_str() {
                    Some("thinking") | Some("redacted_thinking") => out.push(LiveEv::Thinking(at.clone())),
                    Some("text") => out.push(LiveEv::Text(at.clone())),
                    Some("tool_use") => {
                        let name = c["name"].as_str().unwrap_or("");
                        let inp = &c["input"];
                        // Bash はコマンドそのもの、MCP の道具は宛先（session、name）を頭に出す。終わった道具の行（tool_line）は変えない
                        let text = match (name, inp["command"].as_str()) {
                            ("Bash", Some(cmd)) => format!("コマンド: {}", clip(cmd, 70)),
                            _ => {
                                let line = tool_line(name, inp);
                                match ["session", "name"].iter().find_map(|k| inp[*k].as_str()).filter(|_| !line.contains(": ")) {
                                    Some(to) => format!("{line}: {}", clip(to, 70)),
                                    None => line,
                                }
                            }
                        };
                        out.push(LiveEv::Tool(LiveTool { id: c["id"].as_str().unwrap_or("").into(), kind: tool_kind(name), text, at: at.clone() }));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// 会話のキャッシュを残す時間（#15）。画面は開いている会話だけを 2.5 秒ごとに読むので、
/// これより長く読まれていない会話（閉じたセッション、ほかのセッションに切り替えた後）は捨てる。
/// 捨てた後に開き直したら、jsonl を頭から読み直し、画面は reset で受け取る
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
    /// 今の動き（#59）。毎回、全部を返す
    live: Live,
}

impl Conv {
    /// 読み位置 from から next まで読んだ分を足す。同じセッションの取得が重なり、
    /// ほかの呼び出しが先に同じ範囲を足していたら（c.next が読み始めと違う）、足さない
    /// 項目が増えたら true
    fn absorb(&mut self, from: u64, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
        if self.next != from {
            return false;
        }
        self.next = next;
        if epoch.is_some() {
            self.epoch = epoch;
        }
        let grew = !fresh.is_empty();
        for e in evs {
            self.live.apply(e);
        }
        self.push(fresh);
        grew
    }

    /// after=0 から読み直した中身で置き換える。読み始めたとき（from、seen）から誰も進めていなければ置き換えて true。
    /// 通し番号 n は前の続きから1つ空けて振る。画面が持っている数（since）は必ず新しい範囲の手前に落ちるので、
    /// since() が reset を返し、画面は持っている分を捨てて置き換える（App.tsx と conv.ts は変えない）。
    /// n は減らないので、送ったばかりの仮の項目（pending の after）とも比べられる
    /// 今の動き（#59）も、頭から読んだ出来事（evs）で作り直す
    fn replace(&mut self, from: u64, seen: &Option<String>, next: u64, fresh: Vec<Value>, evs: Vec<LiveEv>, epoch: Option<String>) -> bool {
        if self.next != from || &self.epoch != seen {
            return false;
        }
        self.total += 1;
        self.items.clear();
        self.next = next;
        self.epoch = epoch;
        self.live = Live::default();
        for e in evs {
            self.live.apply(e);
        }
        self.push(fresh);
        true
    }

    fn push(&mut self, fresh: Vec<Value>) {
        let start = self.total;
        for mut v in fresh {
            // 止めた印の直後の印は重ねない。-p の子は、止めると止めた印の文に続いて error_during_execution の result を書く（#83）
            if v["role"] == "event" && self.items.last().map(|l| l["role"] == "event" && l["kind"] == "interrupted").unwrap_or(false) {
                continue;
            }
            // 道具の結果は、持っている道具の行に付ける。道具の行が今回の分にあれば、それで画面に届くので項目にしない。
            // 前に渡した道具の行の結果だけ、小さい result の項目で送り、画面が道具の行に付け直す。道具の行が無ければ捨てる（#83）
            if v["role"] == "result" {
                let id = v["id"].clone();
                let hit = self.items.iter_mut().rev().find(|t| t["role"] == "tool" && t["id"] == id && t.get("result").is_none());
                let Some(t) = hit else { continue };
                t["result"] = json!({ "text": v["text"], "error": v["error"] });
                if t["n"].as_u64().map(|n| n >= start).unwrap_or(false) {
                    continue;
                }
            }
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
                ConvDelta { items: self.items[(s - base) as usize..].to_vec(), total: self.total, reset: false, live: self.live.clone() }
            }
            _ => ConvDelta { items: self.items.clone(), total: self.total, reset: true, live: self.live.clone() },
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
/// 読むのは jsonl の行そのまま（type、message、timestamp）。{at, type, data: {type, message, …}, seq} の形
/// （中身が data に入り、時刻が at の ms にある。前に ccn の PTY の会話が返した形で、試験の材料がこの形で残っている）も読む。
/// 道具の結果を画面に出す長さ（字）と行数。長い出力は頭だけを持つ
const RESULT_CHARS: usize = 1500;
const RESULT_LINES: usize = 40;

/// 道具の結果（tool_result の content）を文にする。content は文字列か、text と image の並び。改行は残し、頭だけを持つ
fn result_text(content: &Value) -> String {
    let t = match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|c| match c["type"].as_str() {
            Some("text") => c["text"].as_str().unwrap_or("").to_string(),
            Some("image") => "[画像]".to_string(),
            _ => String::new(),
        }).filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    let t = t.trim();
    let mut out: String = t.lines().take(RESULT_LINES).collect::<Vec<_>>().join("\n");
    if out.chars().count() > RESULT_CHARS {
        out = out.chars().take(RESULT_CHARS).collect();
    }
    if out.len() < t.len() {
        out.push_str("\n…（続きは省いた）");
    }
    out
}

fn simplify(m: &Value) -> Vec<Value> {
    let (m, at) = match m.get("data").filter(|d| m.get("message").is_none() && d.is_object()) {
        Some(d) => (d, m["at"].clone()),
        None => (m, m["timestamp"].clone()),
    };
    let ty = m["type"].as_str().unwrap_or("");
    let content = &m["message"]["content"];
    let mut out = vec![];
    match ty {
        // ターンの終わり。止めた（interrupted）と失敗（is_error）だけを会話に出す（#83）。成功は返事の文が出ているので出さない
        "result" => {
            if m["subtype"].as_str() == Some("interrupted") {
                out.push(json!({ "role": "event", "kind": "interrupted", "text": "ここで止めた", "at": at }));
            } else if m["is_error"].as_bool() == Some(true) {
                let t = clip(m["result"].as_str().unwrap_or(""), 300);
                out.push(json!({ "role": "event", "kind": "error", "text": if t.is_empty() { "ターンが失敗で終わった".to_string() } else { format!("ターンが失敗で終わった: {t}") }, "at": at }));
            }
        }
        "user" if content.as_array().map(|a| a.iter().any(|c| c["type"] == "tool_result")).unwrap_or(false) => {
            // 道具の結果。画面は道具の行を開いたときに出す。Conv::push が道具の行に付ける（#83）
            for c in content.as_array().into_iter().flatten().filter(|c| c["type"] == "tool_result") {
                if let Some(id) = c["tool_use_id"].as_str() {
                    out.push(json!({ "role": "result", "id": id, "text": result_text(&c["content"]), "error": c["is_error"].as_bool() == Some(true), "at": at }));
                }
            }
        }
        "user" => {
            // 貼り付けの包み（<pasted_content>）は外してから見る。外さないと `<` で始まり、下の除外で落ちる（#69）
            let text = user_text(content);
            let text = text.as_str();
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
            // 止めたときに claude が書く印（-p の子で見た。2026-11-21）。吹き出しにせず、止めた印にする（#83）
            if text.starts_with("[Request interrupted by user") {
                out.push(json!({ "role": "event", "kind": "interrupted", "text": "ここで止めた", "at": at }));
                return out;
            }
            // 道具の結果だけの user、hook やシステムの差し込み（<...> で始まる）は出さない
            if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
                return out;
            }
            // 別のセッションからの文は1行目が from 行。画像のパスを含む文を端末に貼ると、CLI はパスを画像の添付にし、
            // 先頭に [Image #3] を置く（from 行はその後ろに回る、#69）。印を外して from 行を探し、印は本文の頭に戻す
            // 画像だけを送ると、印の後ろが from 行だけになり改行が無いことがある（観測はしていない。来ても from 行を本文に出さない）
            let (imgs, rest) = split_image_marks(text);
            let (first, after) = rest.split_once('\n').unwrap_or((rest, ""));
            let (from, body) = if first.starts_with("from ") && first.contains(" via ") && (rest.contains('\n') || !imgs.is_empty()) {
                let after = after.trim();
                (Some(first.trim_end().to_string()), if imgs.is_empty() { after.to_string() } else if after.is_empty() { imgs.to_string() } else { format!("{imgs}\n{after}") })
            } else {
                (None, text.to_string())
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
                            // 送ったお手紙（SendMessage と、MCP の mcp__ccn__send_message、mcp__ccn__create_session）は、宛先と1行目を付ける。
                            // ccn の MCP は別のプロダクトの道具で、ここでは記録の道具名を読むだけ
                            let first = |v: &Value| v.as_str().unwrap_or("").lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
                            let sent = match name {
                                "SendMessage" if inp["message"].is_string() => Some(json!({ "to": inp["to"], "summary": inp["summary"].as_str().map(String::from).unwrap_or_else(|| first(&inp["message"])), "text": inp["message"] })),
                                "mcp__ccn__send_message" => Some(json!({ "to": inp["session"], "peer": inp["peer"], "summary": first(&inp["text"]), "text": inp["text"] })),
                                "mcp__ccn__create_session" if inp["prompt"].is_string() => Some(json!({ "to": null, "peer": inp["peer"], "summary": first(&inp["prompt"]), "text": inp["prompt"], "create": true })),
                                _ => None,
                            };
                            let mut item = json!({ "role": "tool", "text": tool_line(name, inp), "at": at, "sent": sent, "id": c["id"] });
                            // 計画の確認（ExitPlanMode）の本文。承認の hook の tool_input は、計画ファイルが無いと空で来るので、
                            // 承認の欄は会話の最後の計画で補う（#83、2026-11-21 に PTY の子で見た）
                            if name == "ExitPlanMode" {
                                if let Some(p) = inp["plan"].as_str().filter(|p| !p.trim().is_empty()) {
                                    item["plan"] = json!(p);
                                }
                            }
                            out.push(item);
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

/// 持っている cursor（from）が、今の jsonl の読み位置と続いていないか。前に読んだ印（inode）と違えば、from から先を読むと欠けるか重なる
fn cursor_is_stale(from: u64, seen: &Option<String>, got: &Option<String>) -> bool {
    from > 0 && got.is_some() && got != seen
}

/// セッションの jsonl を読み位置 from から読む。返すのは (次の読み位置, 縮めた項目, 今の動きの出来事, 印)。読み位置はバイト、印は native:<inode>。
/// ファイルが読み位置より短くなったら、印に :restarted を付けて返し、conversation が頭から読み直した扱いにする
fn read_native(path: &std::path::Path, from: u64) -> Result<(u64, Vec<Value>, Vec<LiveEv>, Option<String>), String> {
    let c = native::conv::read(path, from)?;
    let fresh = c.lines.iter().flat_map(simplify).collect();
    let evs = c.lines.iter().flat_map(live_events).collect();
    let epoch = if c.restarted { format!("{}:restarted", c.epoch) } else { c.epoch };
    Ok((c.next, fresh, evs, Some(epoch)))
}

fn conversation(session_id: String, since: Option<u64>) -> Result<ConvDelta, String> {
    // jsonl の場所は一覧を作るときに登録する。起動したばかりで、まだ jsonl が無いセッションは空で返す
    let Some(path) = native::path_of(&session_id) else {
        return Ok(ConvDelta { items: vec![], total: 0, reset: true, live: Live::default() });
    };
    let key = session_id.clone();
    let (from, seen) = {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        g.as_ref().and_then(|m| m.get(&key)).map(|c| (c.next, c.epoch.clone())).unwrap_or((0, None))
    };
    let (mut next, mut fresh, mut evs, mut epoch) = read_native(&path, from)?;
    let restarted = epoch.as_deref().is_some_and(|e| e.ends_with(":restarted"));
    let stale = restarted || cursor_is_stale(from, &seen, &epoch);
    if restarted {
        // 頭から読み直した分は、そのまま置き換えに使う。印は元の形に戻す
        epoch = epoch.map(|e| e.trim_end_matches(":restarted").to_string());
    } else if stale && from > 0 {
        // 読んだ分は捨て、頭から読み直して置き換える。読み直しに失敗したら何も変えない（次の呼び出しでもう一度気づく）
        (next, fresh, evs, epoch) = read_native(&path, 0)?;
    }
    let mut g = CONVS.lock().map_err(|e| e.to_string())?;
    let map = g.get_or_insert_with(HashMap::new);
    let now = now_ms();
    forget_idle_convs(map, &key, now);
    let c = map.entry(key).or_insert_with(Conv::default);
    c.used = now;
    if stale {
        // 読み直しが0件で、前に中身があったときは置き換えない（読めなかっただけかもしれないので、持っている分まで消さない）
        if !(fresh.is_empty() && !c.items.is_empty()) {
            c.replace(from, &seen, next, fresh, evs, epoch);
        }
    } else {
        c.absorb(from, next, fresh, evs, epoch);
    }
    Ok(c.since(since))
}

// ---------- 作る・止める ----------

/// 新しい世帯を立てる。claude をこのアプリの中の端末で起動する（pty.rs）。cwd を省くと ~/Documents/meta（本人の指定）。
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
    refuse_if_disabled()?;
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(default_place);
    let ok = |v: Option<u16>, d: u16| v.filter(|n| (10..=1000).contains(n)).unwrap_or(d);
    let r = pty::spawn(&cwd, name.as_deref(), ok(cols, 120), ok(rows, 40), town_kick)?;
    town_kick();
    Ok(r)
}

/// 場所を設定していないときに新しい世帯を立てる場所（本人の指定）
fn default_place() -> String {
    home().join("Documents/meta").to_string_lossy().to_string()
}

/// 新しい世帯のペイン（#89）の「最近使った場所」の材料。形は画面の src/newHouse/places.ts の PlacesInput。
/// defaultPlace は、画面が設定の場所を持っていないときに、一覧から除く場所（決定 4、2026-11-21）
fn house_places() -> Result<Value, String> {
    let live: Vec<Value> = town_rows().into_iter().filter(|r| r["kind"] == "terminal").map(|r| json!({ "cwd": r["cwd"], "lastActivityAt": r["lastActivityAt"] })).collect();
    Ok(json!({ "roots": [], "lobby": null, "sessions": live, "places": places::recent(&native::claude_home()), "defaultPlace": default_place() }))
}

/// このアプリが立てたセッションを止める
fn stop_session(session_id: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::kill(&session_id)?;
    town_kick();
    Ok(())
}

// ---------- 端末（PTY） ----------
// このアプリが立てた claude の端末（pty.rs）を、開いた画面の Channel にだけ送る（#9）。
// 出力は UTF-8 の文字列に戻し、16ms に1回までにまとめて送る。バイト列のままは送らない。Channel は 1KB 以上の生のバイト列を
// fetch でもう1往復して渡し、1KB 未満は数の配列の JSON にする。JSON は 8KB 未満なら1回の eval で届く
// （tauri 2.12 の ipc/channel.rs、MAX_RAW_DIRECT_EXECUTE_THRESHOLD と MAX_JSON_DIRECT_EXECUTE_THRESHOLD）。
// 画面は開いている端末の分だけ term_open を呼び、閉じたら term_close を呼ぶ。
// term_open は世代の番号を返し、term_close はその番号の接続だけを閉じる（A→B→A と素早く切り替えても、新しい接続を閉じない）。

/// 出力をまとめる間隔。前に送ってからこれだけたっていれば、すぐ送る（打った文字の返りを遅らせない）
const TERM_FLUSH: Duration = Duration::from_millis(16);

static TERM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 画面へ送るスレッド。出力は TERM_FLUSH に1回までにまとめ、ほかのイベントの前には必ずたまった分を送る（順を変えない）
fn spawn_term_sender(ch: tauri::ipc::Channel<Value>) -> std::sync::mpsc::Sender<pty::TermOut> {
    use pty::TermOut;
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
fn term_open(session_id: String, on_event: tauri::ipc::Channel<Value>) -> Result<u64, String> {
    app_guard(&session_id)?;
    let generation = TERM_GEN.fetch_add(1, Ordering::SeqCst);
    pty::subscribe(&session_id, generation, spawn_term_sender(on_event))?;
    Ok(generation)
}

/// ターミナルを閉じる。generation を渡したら、その世代の接続のときだけ閉じる。claude は止めない
#[tauri::command]
fn term_close(session_id: String, generation: Option<u64>) -> Result<(), String> {
    pty::unsubscribe(&session_id, generation);
    Ok(())
}

/// 打ったキー。PTY への書き込みはすぐ終わるので、届いた順にそのまま書く
#[tauri::command]
fn term_input(session_id: String, text: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::write(&session_id, &text)
}

#[tauri::command]
fn term_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    app_guard(&session_id)?;
    pty::resize(&session_id, cols, rows)
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
    #[tauri::command]
    pub async fn conversation(session_id: String, since: Option<u64>) -> Result<super::ConvDelta, String> {
        blocking(move || super::conversation(session_id, since)).await
    }
    #[tauri::command]
    pub async fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
        blocking(move || super::create_session(cwd, name, cols, rows)).await
    }
    #[tauri::command]
    pub async fn house_places() -> Result<Value, String> { blocking(super::house_places).await }
    /// 新しい世帯の一覧の各場所に連携しているリポジトリ名（owner/repo）。.git/config を読むだけ（#99）
    #[tauri::command]
    pub async fn place_repos(paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> { blocking(move || Ok(super::repo::repos_of(&paths))).await }
    #[tauri::command]
    pub async fn stop_session(session_id: String) -> Result<(), String> {
        blocking(move || super::stop_session(session_id)).await
    }
    #[tauri::command]
    pub async fn prompt_history(cwd: Option<String>, all: Option<bool>) -> Result<super::composer::History, String> {
        blocking(move || super::composer::prompt_history(cwd, all.unwrap_or(false))).await
    }
    #[tauri::command]
    pub async fn slash_commands(cwd: Option<String>) -> Result<Vec<super::composer::SlashCommand>, String> {
        blocking(move || Ok(super::composer::slash_commands(cwd))).await
    }
    #[tauri::command]
    pub async fn file_suggestions(cwd: String, query: String) -> Result<Vec<String>, String> {
        blocking(move || super::composer::file_suggestions(cwd, query)).await
    }
    #[tauri::command]
    pub async fn send_direct(session_id: String, text: String) -> Result<(), String> {
        super::app_guard(&session_id)?;
        blocking(move || super::composer::send_direct(session_id, text)).await
    }
    #[tauri::command]
    pub async fn interrupt_session(session_id: String) -> Result<(), String> {
        super::app_guard(&session_id)?;
        blocking(move || super::composer::interrupt_session(session_id)).await
    }
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

// ---------- 町の一覧の見張り（#5） ----------
//
// 画面が決まった間隔で snapshot を呼ぶのをやめ、Rust のスレッドが一覧を作り、前回と変わったときだけ Channel で画面へ送る。
// 変化が無ければ画面（JS）は一度も起きない。
// 間隔は、変化が無い回が続くと 2秒→4秒→8秒と延ばし、8秒で止める。変わったら2秒に戻す。
// 上限を8秒にしたのは、静かな町で承認待ちや返事待ちが出たとき、画面に出るまでの遅れを8秒までに抑えるため（「あなたの番」を早く見せる）
// 画面が見えていない間は、画面が town_unwatch で止める（#6）。端末を立てた、止めた、終わったときは town_kick ですぐ作り直す。

/// 変化が無い回が続いたときの間隔の下限と上限
const WATCH_MIN: Duration = Duration::from_secs(2);
const WATCH_MAX: Duration = Duration::from_secs(8);

enum WatchCmd {
    Kick,
    Stop,
}

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

/// 見張りの本体。一覧を作り、前回と変わったときだけ send に渡す。send が false を返すか Stop で終わる
fn watch_loop(rx: std::sync::mpsc::Receiver<WatchCmd>, mut send: impl FnMut(Value) -> bool) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut last: Option<String> = None;
    let mut wait = WATCH_MIN;
    loop {
        let s = snapshot();
        let key = snapshot_key(&s);
        let changed = last.as_deref() != Some(key.as_str());
        if changed && !send(serde_json::to_value(&s).unwrap_or(Value::Null)) {
            break;
        }
        wait = next_wait(wait, changed);
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
fn town_watch(on_event: tauri::ipc::Channel<Value>) -> u64 {
    let (tx, rx) = std::sync::mpsc::channel::<WatchCmd>();
    let generation = WATCH_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some((_, old)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).replace((generation, tx)) {
        let _ = old.send(WatchCmd::Stop);
    }
    std::thread::spawn(move || watch_loop(rx, |v| on_event.send(v).is_ok()));
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

/// 軽さの計測（scripts/bench.ts、#2）で、窓を隠すか最小化する。FC_PERF_LOG があるとき（計測のとき）だけ動く
#[tauri::command]
fn perf_window(window: tauri::WebviewWindow, op: String) -> Result<(), String> {
    if std::env::var("FC_PERF_LOG").map(|p| p.is_empty()).unwrap_or(true) {
        return Err("計測のときだけ使える".into());
    }
    match op.as_str() {
        "hide" => window.hide(),
        "minimize" => window.minimize(),
        _ => return Err(format!("知らない操作: {op}")),
    }
    .map_err(|e| e.to_string())
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
        let (houses_shared, houses_own) = houses_paths();
        println!("{}", serde_json::to_string_pretty(&json!({
            "identifier": APP_ID.get(),
            "shared": fc_path(Scope::Shared, ""),
            "app": fc_path(Scope::App, ""),
            "avatars": avatars_path(),
            "avatarsRecent": avatars::recent_path(&avatars_path()),
            "housesShared": houses_shared,
            "houses": houses_own,
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
        println!("{}", serde_json::to_string_pretty(&snapshot()).unwrap_or_default());
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
            cmd::snapshot, cmd::conversation, cmd::create_session, cmd::stop_session, cmd::house_places, cmd::place_repos,
            term_open, term_close, term_input, term_resize,
            perf_log, perf_ping, perf_window, town_watch, town_unwatch, town_kick,
            cmd::prompt_history, cmd::slash_commands, cmd::file_suggestions, cmd::send_direct, cmd::interrupt_session, cmd::paste_clipboard, cmd::stage_files
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
mod tests {
    use super::*;

    #[test]
    fn live_tracks_open_tools_and_thinking() {
        use super::{live_events, Live};
        use serde_json::json;
        let pty = |ts: &str, data: serde_json::Value| json!({ "at": 1, "type": "x", "seq": 0, "data": { "timestamp": ts, "type": data["type"], "message": data["message"] } });
        let mut l = Live::default();
        let feed = |l: &mut Live, m: serde_json::Value| for e in live_events(&m) { l.apply(e) };
        feed(&mut l, pty("t0", json!({ "type": "user", "message": { "content": "やって" } })));
        assert_eq!(l.turn_at, json!("t0"));
        feed(&mut l, pty("t1", json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "" }] } })));
        assert_eq!(l.last, Some("thinking"));
        feed(&mut l, pty("t2", json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "a", "name": "Bash", "input": { "command": "git status", "description": "見る" } },
            { "type": "tool_use", "id": "b", "name": "mcp__ccn__send_message", "input": { "session": "abc", "text": "x" } } ] } })));
        assert_eq!(l.tools.len(), 2);
        assert_eq!(l.tools[0].text, "コマンド: git status");
        assert_eq!(l.tools[1].kind, "ccn");
        assert_eq!(l.tools[1].text, "send_message: abc");
        // node の形（timestamp が外）でも読む
        feed(&mut l, json!({ "type": "user", "timestamp": "t3", "message": { "content": [{ "type": "tool_result", "tool_use_id": "a" }] } }));
        assert_eq!(l.tools.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!((l.last, l.last_at.clone()), (Some("result"), json!("t3")));
        // hook の差し込みはターンの始まりにしない。人の文が来たら、結果の来なかった道具は捨てる
        feed(&mut l, pty("t4", json!({ "type": "user", "message": { "content": "<system-reminder>x</system-reminder>" } })));
        assert_eq!(l.tools.len(), 1);
        feed(&mut l, pty("t5", json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "[Request interrupted by user]" }] } })));
        assert!(l.tools.is_empty());
        assert_eq!(l.turn_at, json!("t5"));
    }

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
        c.absorb(0, 5, fresh(), vec![], None);
        c.absorb(0, 5, fresh(), vec![], None);
        assert_eq!(c.total, 1);
        assert_eq!(c.next, 5);
        c.absorb(5, 6, fresh(), vec![], None);
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
    fn a_changed_epoch_means_the_cursor_does_not_continue() {
        use super::cursor_is_stale;
        let s = |x: &str| Some(x.to_string());
        // 初めて読む（from=0）ときは、印が何でも続きとして読む
        assert!(!cursor_is_stale(0, &None, &s("a")));
        // 同じ印なら続き
        assert!(!cursor_is_stale(3, &s("a"), &s("a")));
        // 印が変わった（jsonl が入れ替わった）
        assert!(cursor_is_stale(3, &s("a"), &s("b")));
        assert!(cursor_is_stale(3, &s("a"), &s("history")));
        // 前の印が無い（読んだことが無い）のに読み位置がある
        assert!(cursor_is_stale(3, &None, &s("b")));
        // 印が無ければ今までどおり
        assert!(!cursor_is_stale(3, &None, &None));
        assert!(!cursor_is_stale(3, &s("a"), &None));
    }

    /// 読み直して置き換えた後は、画面が前に持っていた数（since）で呼んでも必ず reset になる。
    /// 読み直しが前より短い、同じ、長い（KEEP_MESSAGES を超える）の3通り
    #[test]
    fn replacing_after_a_reread_always_resets_the_screen() {
        use super::{Conv, KEEP_MESSAGES};
        use serde_json::json;
        let item = |i: usize| json!({ "role": "assistant", "text": format!("t{i}") });
        let a = Some("a".to_string());
        for len in [1usize, 3, KEEP_MESSAGES + 7] {
            let mut c = Conv::default();
            c.absorb(0, 3, (0..3).map(item).collect(), vec![], a.clone());
            let old = c.since(None).total;
            assert!(c.replace(3, &a, 5, (0..len).map(item).collect(), vec![], Some("b".into())));
            let d = c.since(Some(old));
            assert!(d.reset, "len={len}");
            assert_eq!(d.items.len(), len.min(KEEP_MESSAGES));
            assert_eq!(d.items.last().unwrap()["text"], json!(format!("t{}", len - 1)));
            // n は前より大きいところから続く
            assert!(d.items[0]["n"].as_u64().unwrap() > old);
            assert_eq!((c.next, c.epoch.as_deref()), (5, Some("b")));
            // 画面が追いついた後は、続きの差分だけ
            assert!(c.absorb(5, 6, vec![item(99)], vec![], Some("b".into())));
            let e = c.since(Some(d.total));
            assert!(!e.reset);
            assert_eq!(e.items.len(), 1);
        }
        // 0件に読み直しても、画面は reset で空になり、その後は reset を繰り返さない
        let mut c = Conv::default();
        c.absorb(0, 3, (0..3).map(item).collect(), vec![], a.clone());
        assert!(c.replace(3, &a, 0, vec![], vec![], Some("b".into())));
        let d = c.since(Some(3));
        assert!(d.reset && d.items.is_empty());
        assert!(!c.since(Some(d.total)).reset);
    }

    #[test]
    fn a_second_overlapping_reread_does_not_replace_twice() {
        use super::Conv;
        use serde_json::json;
        let a = Some("a".to_string());
        let mut c = Conv::default();
        c.absorb(0, 3, vec![json!({ "role": "user", "text": "x" })], vec![], a.clone());
        assert!(c.replace(3, &a, 5, vec![json!({ "role": "user", "text": "y" })], vec![], Some("b".into())));
        let total = c.total;
        // 同じ時に読み始めたもう1回は、もう進んでいるので置き換えない
        assert!(!c.replace(3, &a, 5, vec![json!({ "role": "user", "text": "y" })], vec![], Some("b".into())));
        assert_eq!(c.total, total);
        // 古い印のまま続きを足そうとした取得も足さない
        assert!(!c.absorb(3, 4, vec![json!({ "role": "user", "text": "z" })], vec![], a.clone()));
        assert_eq!(c.total, total);
    }

    #[test]
    fn conv_delta_is_sent_as_an_object() {
        use super::ConvDelta;
        use serde_json::json;
        let d = ConvDelta { items: vec![json!({ "role": "user", "text": "a", "n": 0 })], total: 1, reset: true, live: Default::default() };
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({ "items": [{ "role": "user", "text": "a", "n": 0 }], "total": 1, "reset": true,
            "live": { "tools": [], "last": null, "last_at": null, "turn_at": null } }));
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
        let mk = |at: u128, n: usize| Snapshot { agents: vec![json!({"id": n})], letters: vec![], fetched_at: at, sources: None };
        assert_eq!(snapshot_key(&mk(1, 1)), snapshot_key(&mk(2, 1)));
        assert_ne!(snapshot_key(&mk(1, 1)), snapshot_key(&mk(1, 2)));
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

    static NATIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

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
    fn tool_results_attach_to_tool_lines() {
        let asst = |id: &str| json!({"type": "assistant", "timestamp": "t", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": "ls"}}]}});
        let res = |id: &str, err: bool| json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": [{"type": "text", "text": "a\nb"}], "is_error": err}]}});
        let mut c = Conv::default();
        // 同じ読み出しの結果は、道具の行に付くだけで項目は増えない
        c.push([asst("t1"), res("t1", false)].iter().flat_map(simplify).collect());
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0]["result"], json!({"text": "a\nb", "error": false}));
        // 後の読み出しの結果は、道具の行に付け、画面に送る result の項目も足す
        c.push(simplify(&asst("t2")));
        c.push(simplify(&res("t2", true)));
        assert_eq!(c.items.len(), 3);
        assert_eq!(c.items[1]["result"]["error"], true);
        assert_eq!(c.items[2]["role"], "result");
        assert_eq!(c.items[2]["id"], "t2");
        // 道具の行が無い結果は捨てる
        c.push(simplify(&res("nope", false)));
        assert_eq!(c.items.len(), 3);
    }

    #[test]
    fn turn_end_events() {
        let r = |o: Value| simplify(&json!({"at": 5, "type": "result", "data": o}));
        assert_eq!(r(json!({"type": "result", "subtype": "interrupted", "is_error": true, "result": ""}))[0]["kind"], "interrupted");
        let e = r(json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": "API Error: limit"}));
        assert_eq!(e[0]["kind"], "error");
        assert!(e[0]["text"].as_str().unwrap().contains("API Error: limit"));
        assert!(r(json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok"})).is_empty());
    }

    #[test]
    fn node_interrupt_is_one_mark() {
        // 2026-11-21 に -p の子を止めたときの行（中身は縮めた）
        let user = json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}, "timestamp": "t"});
        let end = json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "result": ""});
        let mut c = Conv::default();
        c.push(simplify(&user));
        c.push(simplify(&end));
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.items[0]["kind"], "interrupted");
    }

    #[test]
    fn result_text_keeps_the_head() {
        assert_eq!(result_text(&json!("x")), "x");
        assert_eq!(result_text(&json!([{"type": "text", "text": "a"}, {"type": "image"}])), "a\n[画像]");
        let long = (0..100).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let t = result_text(&json!(long));
        assert!(t.ends_with("…（続きは省いた）"));
        assert_eq!(t.lines().count(), RESULT_LINES + 1);
    }

    #[test]
    fn exit_plan_mode_keeps_the_plan() {
        let asst = json!({"type": "assistant", "timestamp": "t", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "name": "ExitPlanMode", "input": {"plan": "# 計画\n- a"}},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b"}}]}});
        let out = simplify(&asst);
        assert_eq!(out[0]["plan"], "# 計画\n- a");
        assert!(out[1].get("plan").is_none());
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

    // 2026-11-14 14:21 に本人が meta（8074d764）へ続けて送った3通。当時の会話の形（data で包んだ形）のまま（#69）。
    // 1通目と3通目は CLI が <pasted_content> で包んでいた。包みのまま `<` で始まるので会話から落ち、仮の吹き出しが消えずに末尾に残った
    #[test]
    fn pasted_content_is_unwrapped_not_dropped() {
        let first = json!({"at": 1794633665654u64, "type": "user", "seq": 442, "data": {"type": "user", "message": {"role": "user",
            "content": "\n\n<pasted_content id=\"9779\">\nfrom local via konaito-pro\n\n/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット\\ 2026-11-14\\ 14.20.54.png \n\nこれ挙動がおかしいぞ、掘ってくれ\n</pasted_content id=\"9779\">\n"}}});
        let second = json!({"at": 1794633683710u64, "type": "user", "seq": 453, "data": {"type": "user", "message": {"role": "user",
            "content": "from local via konaito-pro\n\n先に送ったやつが先に反映されてない"}}});
        let third = json!({"at": 1794633703956u64, "type": "user", "seq": 460, "data": {"type": "user", "message": {"role": "user",
            "content": "<pasted_content id=\"9779\">\nfrom local via konaito-pro\n\n/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_s8ZkFz/スクリーンショット\\ 2026-11-14\\ 14.21.28.png \n今回も、多分送られてるし、読まれてるんだけど、判定がおかしいんだと思う\n</pasted_content id=\"9779\">"}}});
        let a = simplify(&first);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["from"], "from local via konaito-pro");
        assert_eq!(a[0]["text"], "/var/folders/lp/twxk19yd58v9rb7ytpcxt6pm0000gn/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット\\ 2026-11-14\\ 14.20.54.png \n\nこれ挙動がおかしいぞ、掘ってくれ");
        assert_eq!(simplify(&second)[0]["text"], "先に送ったやつが先に反映されてない");
        let c = simplify(&third);
        assert_eq!(c.len(), 1);
        assert!(c[0]["text"].as_str().unwrap().ends_with("判定がおかしいんだと思う"));
        // 包まれた文も、ターンの始まりとして数える
        for m in [&first, &second, &third] {
            assert!(matches!(live_events(m).as_slice(), [LiveEv::User(_)]));
        }
        // hook の差し込みは今までどおり落とす
        let hook = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}});
        assert!(simplify(&hook).is_empty());
    }

    // 2026-11-14、写した画像のパスを入れて送った文を、CLI が画像の添付にした形（当時の会話の形のまま、#69）
    #[test]
    fn image_marks_before_the_from_line() {
        let m = json!({"at": 1794634823274u64, "type": "user", "seq": 51, "data": {"type": "user", "message": {"role": "user",
            "content": "[Image #3]from local via konaito-pro\n（ドロップの確認）上のパスの画像を Read で開いて"}}});
        let out = simplify(&m);
        assert_eq!(out[0]["from"], "from local via konaito-pro");
        assert_eq!(out[0]["text"], "[Image #3]\n（ドロップの確認）上のパスの画像を Read で開いて");
        // 画像だけを送り、from 行の後ろに何も無い形
        let only = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "[Image #4]from local via konaito-pro"}});
        assert_eq!(simplify(&only)[0]["from"], "from local via konaito-pro");
        assert_eq!(simplify(&only)[0]["text"], "[Image #4]");
        // 印が無く改行も無い from 始まりの文は、今までどおり本文として出す
        let plain = json!({"type": "user", "timestamp": "t", "message": {"role": "user", "content": "from A via B"}});
        assert_eq!(simplify(&plain)[0]["text"], "from A via B");
        assert_eq!(split_image_marks("[Image #1] [Image #12]from x"), ("[Image #1] [Image #12]", "from x"));
        assert_eq!(split_image_marks("[Image #]x"), ("", "[Image #]x"));
        assert_eq!(split_image_marks("ふつう"), ("", "ふつう"));
    }

    #[test]
    fn unwrap_pasted_keeps_text_around_and_odd_tags() {
        assert_eq!(unwrap_pasted("  ふつう  "), "ふつう");
        // 打った文と貼った文が混ざっている
        assert_eq!(unwrap_pasted("見て <pasted_content id=\"1\">\n長い文\n</pasted_content id=\"1\"> どう？"), "見て \n長い文\n どう？");
        // 閉じの印に id が無い形も外す
        assert_eq!(unwrap_pasted("<pasted_content id=\"2\">a</pasted_content>"), "a");
        // 名前が続いているもの、> で閉じないものは文のまま残す
        assert_eq!(unwrap_pasted("<pasted_contents>x"), "<pasted_contents>x");
        assert_eq!(unwrap_pasted("<pasted_content\nx"), "<pasted_content\nx");
    }
}
