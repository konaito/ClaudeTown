// family-computing の裏側。画面から呼ばれる命令:
// - snapshot(peer): ccn の一覧（状態と送信先）、Specter のツリー（親子とペイン）、hook の報告、close-check の判定を1つにまとめる
// - peers: ccn につながっている機械の一覧
// - conversation(session_id, peer): ccn の messages を差分で読み、画面に出す形（発言と道具の1行）に縮めて返す
// - send_message(session_id, text, peer): ccn の POST /api/sessions/<id>/messages で文を届ける
// - focus_pane(terminal_id, pid): Specter の AppleScript で、そのセッションのペインを前に出す
//
// ccn は Origin 付きの要求を CSRF として断るので、HTTP は必ずこちら（webview ではなく Rust）から出す。
// 別の機械（peer）は手元のノードの中継 /n/<peer>/api/... を通す。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

const SPECTER_BUNDLE_ID: &str = "jp.fybe.specter";
const KEEP_MESSAGES: usize = 80;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
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

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build()
}

fn get_json(url: &str) -> Result<Value, String> {
    match agent().get(url).call() {
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
    fetched_at: u128,
}

#[tauri::command]
fn peers() -> Result<Value, String> {
    get_json(&format!("{}/api/peers", ccn_base()))
}

#[tauri::command]
fn snapshot(peer: Option<String>) -> Snapshot {
    let peer = peer.filter(|p| !p.is_empty());
    let (sessions, ccn_error) = match get_json(&format!("{}/sessions", api(&peer))) {
        Ok(Value::Array(v)) => (v, None),
        Ok(_) => (vec![], Some("一覧の形が想定と違う".into())),
        Err(e) => (vec![], Some(e)),
    };
    // Specter のツリーはこの機械のものだけ
    let reg = if peer.is_none() {
        read_json(&home().join(".specter/agents.json"))
            .and_then(|v| v.get("agents").cloned())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Default::default()
    };

    let live: Vec<&Value> = sessions
        .iter()
        .filter(|s| s.get("state").and_then(|x| x.as_str()) != Some("exited"))
        .collect();
    let live_ids: HashSet<String> = live.iter().filter_map(|s| s["id"].as_str().map(String::from)).collect();

    let mut name_of: HashMap<String, String> = HashMap::new();
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let name = reg
            .get(&id)
            .and_then(|r| r["name"].as_str())
            .or(s["title"].as_str())
            .unwrap_or(&id[..8.min(id.len())])
            .to_string();
        name_of.insert(id, name);
    }
    // ccn の parent は from 行の呼び手（"agent:<ノード>/<sid8>/<役割>"）。Specter のツリーに無いときだけ使う
    let parent_from_ccn = |s: &Value| -> Option<String> {
        let p = s["parent"].as_str()?;
        let sid8 = p.strip_prefix("agent:")?.split('/').nth(1)?;
        live_ids.iter().find(|id| id.starts_with(sid8)).cloned()
    };

    let houses = read_json(&houses_path()).unwrap_or(json!({}));
    let mut agents = vec![];
    for s in &live {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let r = reg.get(&id).cloned().unwrap_or(Value::Null);
        // 親が生きていなければ根として扱う
        let parent = r["parent"]
            .as_str()
            .map(String::from)
            .or_else(|| parent_from_ccn(s))
            .filter(|p| live_ids.contains(p) && *p != id);
        let (report, close_check) = if peer.is_none() {
            (
                read_json(&home().join(format!(".family-computing/state/{id}.json"))),
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
            "canSend": s["capabilities"]["send"],
            "parent": parent,
            "depth": r["depth"],
            "title": r["title"],
            "terminalId": r["terminalId"],
            "selfStatus": r["selfStatus"],
            "house": houses.get(&id).cloned(),
            "report": report,
            // status が ok/ng なら short は直下、working/checking なら前回の判定が last に入っている
            "closeCheck": close_check.map(|c| json!({
                "status": c["status"],
                "short": if c["short"].is_string() { c["short"].clone() } else { c["last"]["short"].clone() },
            })),
        }));
    }
    Snapshot { ccn: ccn_base(), peer, ccn_ok: ccn_error.is_none(), ccn_error, agents, fetched_at: now_ms() }
}

// ---------- 家の名前 ----------

fn houses_path() -> PathBuf {
    std::env::var("FC_HOUSES").map(PathBuf::from).unwrap_or_else(|_| home().join(".family-computing/houses.json"))
}

/// 本人が画面で家の名前を付ける。空なら本人の名前を消す（親が付けた名前か仮の名前に戻る）
#[tauri::command]
fn set_house_name(session_id: String, name: String) -> Result<(), String> {
    let p = houses_path();
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
    next: u64,
    items: Vec<Value>,
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
fn simplify(m: &Value) -> Vec<Value> {
    let ty = m["type"].as_str().unwrap_or("");
    let at = m["timestamp"].clone();
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
            // 道具の結果だけの user、hook やシステムの差し込み（<...> で始まる）は出さない
            if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
                return out;
            }
            // 別のセッションからの文は1行目が from 行
            let (from, body) = match text.split_once('\n') {
                Some((first, rest)) if first.starts_with("from ") && first.contains(" via ") => (Some(first.to_string()), rest.trim().to_string()),
                _ => (None, text.to_string()),
            };
            out.push(json!({ "role": "user", "text": body, "from": from, "at": at }));
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
                            out.push(json!({ "role": "tool", "text": tool_line(c["name"].as_str().unwrap_or(""), &c["input"]), "at": at }));
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

#[tauri::command]
fn conversation(session_id: String, peer: Option<String>) -> Result<Vec<Value>, String> {
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
    c.items.extend(fresh);
    if c.items.len() > KEEP_MESSAGES {
        let cut = c.items.len() - KEEP_MESSAGES;
        c.items.drain(..cut);
    }
    Ok(c.items.clone())
}

#[tauri::command]
fn send_message(session_id: String, text: String, peer: Option<String>) -> Result<String, String> {
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

/// 承認待ちに答える。choice は "allow" か "deny"。
/// 送る前に、そのセッションが今も承認待ちで、承認を求めている道具が画面で見せたもの（expect_id）と同じかを確かめ、ずれていたら送らない。
/// 端末のセッションには Specter の send key（許可は 1、拒否は Esc。2026-11-12 に試験台で確かめた）を送る。
/// ノードが立てたセッション（claude -p）には ccn の POST /api/sessions/<id>/permissions/<requestId> で答える。
#[tauri::command]
fn answer_permission(
    session_id: String,
    choice: String,
    expect_id: Option<String>,
    terminal_id: Option<String>,
    pid: Option<u64>,
) -> Result<String, String> {
    if choice != "allow" && choice != "deny" {
        return Err("choice は allow か deny".into());
    }
    let base = ccn_base();
    let detail = get_json(&format!("{base}/api/sessions/{session_id}"))?;
    if detail["state"].as_str() != Some("waiting_permission") {
        return Err("もう承認待ちではない（ほかで答えたか、終わった）".into());
    }
    if detail["kind"].as_str() == Some("node") {
        let req = detail["pending"][0]["requestId"].as_str().ok_or("ccn に承認の要求が見当たらない")?;
        let body = if choice == "allow" { json!({ "behavior": "allow" }) } else { json!({ "behavior": "deny", "message": "family-computing から拒否した" }) };
        agent()
            .post(&format!("{base}/api/sessions/{session_id}/permissions/{req}"))
            .send_json(body)
            .map_err(|e| format!("ccn に答えを届けられなかった: {e}"))?;
    } else {
        let state = read_json(&home().join(format!(".family-computing/state/{session_id}.json")));
        let now_id = state.as_ref().and_then(|s| s["pending"]["id"].as_str().map(String::from));
        // 許可は、画面で見せた中身と今の中身が一致したときだけ送る。拒否は安全側なので、中身が分からなくても送ってよい
        if choice == "allow" && (expect_id.is_none() || now_id != expect_id) {
            return Err(if now_id.is_none() {
                "承認を求めている中身がまだ分からない。少し待つか、ペインで確かめて".into()
            } else if expect_id.is_none() {
                "画面で中身を見てから答えて（見た中身の id が渡されていない）".into()
            } else {
                "承認を求めている中身が変わった。もう一度見てから答えて".into()
            });
        }
        if choice == "deny" && expect_id.is_some() && now_id.is_some() && now_id != expect_id {
            return Err("承認を求めている中身が変わった。もう一度見てから答えて".into());
        }
        let tid = terminal_id.or_else(|| pid.and_then(terminal_by_pid)).ok_or("このセッションのペインが見つからない")?;
        let key = if choice == "allow" { "digit1" } else { "escape" };
        osa(&format!(
            "tell application id \"{SPECTER_BUNDLE_ID}\" to send key \"{key}\" to (first terminal whose id is {})",
            as_str(&tid)
        ))
        .map_err(|e| format!("Specter にキーを送れなかった: {e}"))?;
    }
    // 送ったあと、承認待ちから抜けたかを最大4秒見る
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(500));
        if let Ok(d) = get_json(&format!("{base}/api/sessions/{session_id}")) {
            if d["state"].as_str() != Some("waiting_permission") {
                return Ok(format!("答えた（いまの状態: {}）", d["state"].as_str().unwrap_or("?")));
            }
            // 同じセッションが次の承認を求めている場合は、道具の id が変わる
            let st = read_json(&home().join(format!(".family-computing/state/{session_id}.json")));
            let id_now = st.as_ref().and_then(|s| s["pending"]["id"].as_str().map(String::from));
            if expect_id.is_some() && id_now != expect_id {
                return Ok("答えた（次の承認を待っている）".into());
            }
        }
    }
    Err("キーは送ったが、4秒たっても承認待ちのまま。ペインで確かめて".into())
}

// ---------- Specter ----------

fn osa(script: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn as_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// tty から Specter のターミナルの id を引く（Specter のツリーに無い、人が開いたセッション用）
fn terminal_by_pid(pid: u64) -> Option<String> {
    let out = Command::new("/bin/ps").args(["-o", "tty=", "-p", &pid.to_string()]).output().ok()?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tty.is_empty() || tty.starts_with('?') {
        return None;
    }
    let tty = if tty.starts_with("/dev/") { tty } else { format!("/dev/{tty}") };
    let list = osa(&format!(
        "set TB to character id 9\nset LF to character id 10\ntell application id \"{SPECTER_BUNDLE_ID}\"\nset acc to \"\"\nrepeat with t in every terminal\nset acc to acc & (id of t) & TB & (tty of t) & LF\nend repeat\nreturn acc\nend tell"
    ))
    .ok()?;
    list.lines().find_map(|l| {
        let mut it = l.split('\t');
        let id = it.next()?;
        (it.next()? == tty).then(|| id.to_string())
    })
}

#[tauri::command]
fn focus_pane(terminal_id: Option<String>, pid: Option<u64>) -> Result<String, String> {
    if osa(&format!("application id \"{SPECTER_BUNDLE_ID}\" is running"))? != "true" {
        return Err("Specter が起動していない".into());
    }
    let tid = terminal_id.or_else(|| pid.and_then(terminal_by_pid)).ok_or("このセッションのペインが見つからない")?;
    // 通知のクリックと同じく、窓を前に出してからペインにフォーカスする
    osa(&format!(
        "tell application id \"{SPECTER_BUNDLE_ID}\"\nactivate\nfocus (first terminal whose id is {})\nend tell",
        as_str(&tid)
    ))
    .map_err(|e| format!("Specter の操作に失敗した: {e}"))?;
    Ok(tid)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 開発用: 画面に渡すのと同じ JSON を出して終わる（ブラウザでの見た目の確認に使う）
    //   family-computing --snapshot             一覧
    //   family-computing --conversation <id>    会話
    //   family-computing --focus <terminalId>   ペインへ移る
    //   family-computing --answer <sessionId> <allow|deny> [expectId]
    let args: Vec<String> = std::env::args().collect();
    let arg_after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "--snapshot") {
        println!("{}", serde_json::to_string_pretty(&snapshot(arg_after("--peer"))).unwrap_or_default());
        return;
    }
    if let Some(id) = arg_after("--conversation") {
        println!("{}", serde_json::to_string_pretty(&conversation(id, None)).unwrap_or_default());
        return;
    }
    // family-computing --answer <sessionId> <allow|deny> [expectId]   承認待ちに答える（画面のボタンと同じ処理）
    if let Some(i) = args.iter().position(|a| a == "--answer") {
        let sid = args.get(i + 1).cloned().unwrap_or_default();
        let choice = args.get(i + 2).cloned().unwrap_or_default();
        let expect = args.get(i + 3).cloned();
        let tid = read_json(&home().join(".specter/agents.json")).and_then(|v| v["agents"][&sid]["terminalId"].as_str().map(String::from));
        println!("{:?}", answer_permission(sid, choice, expect, tid, None));
        return;
    }
    if let Some(t) = arg_after("--focus") {
        println!("{:?}", focus_pane(Some(t), None));
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![snapshot, peers, conversation, send_message, focus_pane, set_house_name, answer_permission])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
