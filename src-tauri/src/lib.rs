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

fn read_json(p: &PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// 手元の ccn ノードの入口。ccn.json の port を読む（README は 4322、実機は 4323 なので固定しない）。
fn ccn_base() -> String {
    if let Ok(u) = std::env::var("FC_CCN_URL") {
        return u.trim_end_matches('/').to_string();
    }
    for rel in [".config/ccn/ccn.json", ".config/cc/cc.json"] {
        if let Some(port) = read_json(&home().join(rel)).and_then(|v| v.get("port").and_then(|p| p.as_u64())) {
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
}

/// お手紙の記録のうち、直近 LETTERS_WINDOW_MS のものを古い順に返す（多くても LETTERS_MAX 件）
const LETTERS_WINDOW_MS: u128 = 10 * 60 * 1000;
const LETTERS_MAX: usize = 300;
fn recent_letters() -> Vec<Value> {
    let Ok(text) = fs::read_to_string(fc_path(Scope::Shared, "letters.jsonl")) else { return vec![] };
    let since = now_ms().saturating_sub(LETTERS_WINDOW_MS);
    let mut out: Vec<Value> = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .take_while(|v| v["at"].as_u64().map(|a| a as u128 >= since).unwrap_or(false))
        .take(LETTERS_MAX)
        .collect();
    out.reverse();
    out
}

fn peers() -> Result<Value, String> {
    get_json_t(&format!("{}/api/peers", ccn_base()), LIST_TIMEOUT)
}

/// カードの名前。セッションの cwd の最後の名前。cwd が無いときだけ ccn の title、それも無ければ ID の先頭8字
fn display_name(cwd: Option<&str>, title: Option<&str>, id: &str) -> String {
    if let Some(d) = cwd.and_then(|c| c.split('/').filter(|p| !p.is_empty()).last()) {
        return d.to_string();
    }
    title.filter(|t| !t.is_empty()).map(String::from).unwrap_or_else(|| id[..8.min(id.len())].to_string())
}

fn snapshot(peer: Option<String>) -> Snapshot {
    let peer = peer.filter(|p| !p.is_empty());
    let (sessions, ccn_error) = match get_json_t(&format!("{}/sessions", api(&peer)), LIST_TIMEOUT) {
        Ok(Value::Array(v)) => (v, None),
        Ok(_) => (vec![], Some("一覧の形が想定と違う".into())),
        Err(e) => (vec![], Some(e)),
    };
    let live: Vec<&Value> = sessions
        .iter()
        .filter(|s| s.get("state").and_then(|x| x.as_str()) != Some("exited"))
        .collect();
    let live_ids: HashSet<String> = live.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();

    let mut name_of: HashMap<String, String> = HashMap::new();
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let name = display_name(s["cwd"].as_str(), s["title"].as_str(), &id);
        name_of.insert(id, name);
    }
    // ccn の parent は from 行の呼び手（"agent:<ノード>/<sid8>/<役割>"）
    let parent_from_ccn = |s: &Value| -> Option<String> {
        let p = s["parent"].as_str()?;
        let sid8 = p.strip_prefix("agent:")?.split('/').nth(1)?;
        live_ids.iter().find(|id| id.starts_with(sid8)).cloned()
    };

    let houses = read_houses();
    let mut agents = vec![];
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        // 親は ccn の parent（from 行の呼び手）だけから引く。親が生きていなければ根として扱う
        let parent = parent_from_ccn(s).filter(|p| *p != id);
        let (report, close_check) = if peer.is_none() {
            (
                read_json(&fc_path(Scope::Shared, &format!("state/{id}.json"))),
                read_json(&home().join(format!(".claude/close-check/{id}.json"))),
            )
        } else {
            (None, None)
        };
        agents.push(json!({
            "id": id,
            "name": name_of.get(&id),
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
    Snapshot { ccn: ccn_base(), peer, ccn_ok: ccn_error.is_none(), ccn_error, agents, letters, fetched_at: now_ms() }
}

static AVATARS_LOCK: Mutex<()> = Mutex::new(());

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
    let mut out = read_json(&shared).filter(Value::is_object).unwrap_or(json!({}));
    if own != shared {
        if let (Some(base), Some(Value::Object(top))) = (out.as_object_mut(), read_json(&own)) {
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
    let mut next = {
        let g = CONVS.lock().map_err(|e| e.to_string())?;
        g.as_ref().and_then(|m| m.get(&key)).map(|c| c.next).unwrap_or(0)
    };
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
    let c = map.entry(key).or_insert_with(Conv::default);
    c.next = next;
    c.push(fresh);
    Ok(c.since(since))
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
    pub async fn conversation(session_id: String, peer: Option<String>, since: Option<u64>) -> Result<super::ConvDelta, String> {
        blocking(move || super::conversation(session_id, peer, since)).await
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
            cmd::snapshot, cmd::peers, cmd::conversation, cmd::send_message, set_house_name, cmd::answer_permission,
            cmd::create_session, cmd::stop_session, teleport, cmd::teleport_info, cmd::session_detail, term_open, term_close, term_input, term_resize,
            perf_log, perf_ping
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
    fn display_name_is_cwd_basename() {
        use super::display_name;
        assert_eq!(display_name(Some("/Users/x/Documents/meta"), Some("[Image #5] 安定"), "abcdef0123"), "meta");
        assert_eq!(display_name(Some("/a/b/"), None, "abcdef0123"), "b");
        assert_eq!(display_name(None, Some("題"), "abcdef0123"), "題");
        assert_eq!(display_name(Some(""), None, "abcdef0123"), "abcdef01");
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
