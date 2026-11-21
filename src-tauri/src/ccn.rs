//! ccn ノードへの HTTP を、このファイルにだけ置く（#105）。
//! ノードの場所、共有の Agent、口ごとの関数、URL の組み立てがここにある。呼び出し側は URL の文字列を持たない。
//! 挙動は変えていない。時間切れの値とエラー文は、移す前のものと同じ。
//! 例外として、SSE の読み取り（`read_sessions_stream`、`read_terminal`）は長い接続用の別の Agent を持つので lib.rs に残してある。
//! その URL は `sessions_stream_url`、`terminal_url`、`local_terminal_url` で作る。

use serde_json::{json, Value};
use std::time::Duration;

/// 手元の ccn ノードの入口。ccn.json の port を読む（README は 4322、実機は 4323 なので固定しない）。
pub fn base() -> String {
    if let Ok(u) = std::env::var("FC_CCN_URL") {
        return u.trim_end_matches('/').to_string();
    }
    for rel in [".config/ccn/ccn.json", ".config/cc/cc.json"] {
        if let Some(port) = super::read_json_cached(&super::home().join(rel)).and_then(|v| v.get("port").and_then(|p| p.as_u64())) {
            return format!("http://127.0.0.1:{port}");
        }
    }
    "http://127.0.0.1:4322".into()
}

fn api_at(base: &str, peer: &Option<String>) -> String {
    match peer.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => format!("{base}/n/{p}/api"),
        None => format!("{base}/api"),
    }
}

fn api(peer: &Option<String>) -> String {
    api_at(&base(), peer)
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

/// 付け直し（resume）の作成を待つ上限。ccn は `cam usage`（上限5秒）と `cam sync`（上限5秒）の後に claude を起動する。
/// 引き継ぎでは、さらに後継の起動の印（上限10秒）と前任の停止を待ってから応答する
const RESUME_TIMEOUT: Duration = Duration::from_secs(45);

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

/// ccn に1回要求を出し、HTTP の応答なら状態コードと本文（JSON でなければ文字列）を返す。Err はノードに届かなかったときだけ
fn request(method: &str, url: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    let res = agent().request(method, url).timeout(timeout).send_json(body);
    let (status, r) = match res {
        Ok(r) => (r.status(), r),
        Err(ureq::Error::Status(code, r)) => (code, r),
        Err(e) => return Err(format!("ccn に届かない: {e}")),
    };
    let text = r.into_string().unwrap_or_default();
    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    Ok(json!({ "status": status, "body": body }))
}

// ---------- URL（口ごとに1つ） ----------

fn peers_url() -> String { format!("{}/api/peers", base()) }
fn sessions_url(api: &str) -> String { format!("{api}/sessions") }
fn session_url(api: &str, id: &str) -> String { format!("{api}/sessions/{id}") }
fn messages_url(api: &str, id: &str, after: u64) -> String { format!("{api}/sessions/{id}/messages?after={after}") }
fn post_message_url(api: &str, id: &str) -> String { format!("{api}/sessions/{id}/messages") }
fn permission_url(api: &str, id: &str, req: &str) -> String { format!("{api}/sessions/{id}/permissions/{req}") }
fn teleport_url(api: &str, id: &str) -> String { format!("{api}/sessions/{id}/teleport") }
fn terminal_base(api: &str, id: &str) -> String { format!("{api}/sessions/{id}/terminal") }
fn interrupt_url(api: &str, id: &str) -> String { format!("{api}/sessions/{id}/interrupt") }
fn command_url(api: &str, id: &str) -> String { format!("{api}/sessions/{id}/command") }
fn stream_url(api: &str) -> String { format!("{api}/sessions/stream?state=live") }

/// SSE の一覧の URL（GET /sessions/stream?state=live）
pub fn sessions_stream_url(peer: &Option<String>) -> String { stream_url(&api(peer)) }
/// 端末の SSE の URL（GET /sessions/<id>/terminal）
pub fn terminal_url(peer: &Option<String>, id: &str) -> String { terminal_base(&api(peer), id) }
/// 手元のノードの端末の SSE の URL。開発用の `--term` が使う
pub fn local_terminal_url(id: &str) -> String { format!("{}/api/sessions/{id}/terminal", base()) }

// ---------- 口 ----------

/// GET /api/peers
pub fn peers() -> Result<Value, String> {
    get_json_t(&peers_url(), LIST_TIMEOUT)
}

/// GET /sessions（一覧）
pub fn sessions(peer: &Option<String>) -> Result<Value, String> {
    get_json_t(&sessions_url(&api(peer)), LIST_TIMEOUT)
}

/// GET /host（手元のノード）
pub fn host() -> Result<Value, String> {
    get_json_t(&format!("{}/host", api(&None)), LIST_TIMEOUT)
}

/// GET /places?limit=300（手元のノード）。古い ccn は 404 を返す
pub fn places() -> Result<Value, String> {
    get_json_t(&format!("{}/places?limit=300", api(&None)), Duration::from_secs(6))
}

/// GET /sessions/<id>（詳細。承認の pending を含む）
pub fn session(peer: &Option<String>, id: &str) -> Result<Value, String> {
    get_json(&session_url(&api(peer), id))
}

/// GET /sessions/<id>/messages?after=
pub fn messages(peer: &Option<String>, id: &str, after: u64) -> Result<Value, String> {
    get_json(&messages_url(&api(peer), id, after))
}

/// POST /sessions/<id>/messages。応答の本文をそのまま返す
pub fn post_message(peer: &Option<String>, id: &str, text: &str) -> Result<String, String> {
    match agent().post(&post_message_url(&api(peer), id)).send_json(json!({ "text": text })) {
        Ok(r) => Ok(r.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, r)) => Err(format!("ccn が {code} を返した: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn に届かない: {e}")),
    }
}

/// POST /sessions/<id>/permissions/<req>
pub fn post_permission(peer: &Option<String>, id: &str, req: &str, body: Value) -> Result<(), String> {
    agent()
        .post(&permission_url(&api(peer), id, req))
        .send_json(body)
        .map(|_| ())
        .map_err(|e| format!("ccn に答えを届けられなかった: {e}"))
}

/// POST /sessions（作成）
pub fn create_session(peer: &Option<String>, body: Value, from: Option<String>) -> Result<Value, String> {
    post_create(&sessions_url(&api(peer)), body, from)
}

/// 作成の要求を送る。from は親を名乗るヘッダ（x-ccn-from）の値
pub(crate) fn post_create(url: &str, body: Value, from: Option<String>) -> Result<Value, String> {
    let mut req = agent().post(url);
    if body.get("resume").is_some() {
        // 付け直しは、ccn がアカウントを選んでから claude を起動するまで待つ。既定の8秒で切ると、ccn の側では後継が立っているのに
        // 画面は失敗と見て前任を残し、同じ作業が二重に進む。長めに待つ。引き継ぎ（succeed）では、ccn が後継の起動の印（上限10秒）と
        // 前任の停止まで済ませてから応答する（実測 3.5〜5.4 秒、2026-11-17）。
        // 要求ごとの timeout は、共有の Agent の8秒より優先される（ureq 2 の Request::timeout。lib.rs の resume_create_waits_longer_than_default で確かめた）
        req = req.timeout(RESUME_TIMEOUT);
    }
    if let Some(f) = from {
        req = req.set("x-ccn-from", &f);
    }
    match req.send_json(body) {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => Err(format!("ccn が {code} を返した: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn に届かない: {e}")),
    }
}

/// DELETE /sessions/<id>
pub fn delete_session(peer: &Option<String>, id: &str) -> Result<(), String> {
    agent().delete(&session_url(&api(peer), id)).call().map(|_| ()).map_err(|e| format!("止められなかった: {e}"))
}

/// GET /sessions/<id>/teleport（下見）
pub fn teleport_info(peer: &Option<String>, id: &str) -> Result<Value, String> {
    get_json(&teleport_url(&api(peer), id))
}

/// POST /sessions/<id>/teleport。移動元のノードが取り込みまで1回で進めるので、待ちは120秒（専用の Agent）。
/// 移った先でも親とつながるよう、元の詳細の parent（agent:...）があれば x-ccn-from に付ける
pub fn teleport(peer: &Option<String>, id: &str, body: Value) -> Result<Value, String> {
    let a = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
    let mut req = a.post(&teleport_url(&api(peer), id));
    if let Ok(d) = session(peer, id)
        && let Some(p) = d["parent"].as_str().filter(|p| p.starts_with("agent:")) {
            req = req.set("x-ccn-from", p);
        }
    match req.send_json(body) {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => Err(format!("転出できなかった（{code}）: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("ccn に届かない: {e}")),
    }
}

/// POST /sessions/<id>/terminal/<path>（path は input か resize）。5秒で切る
pub fn post_terminal(peer: &Option<String>, id: &str, path: &str, body: Value) -> Result<(), Box<ureq::Error>> {
    post_terminal_at(&terminal_base(&api(peer), id), path, body)
}

/// 端末へ続けて書く側のために、URL を1回だけ組み立てて持つ書き手を返す
pub fn terminal_writer(peer: &Option<String>, id: &str) -> impl Fn(&str, Value) -> Result<(), Box<ureq::Error>> {
    let base = terminal_base(&api(peer), id);
    move |path, body| post_terminal_at(&base, path, body)
}

fn post_terminal_at(base: &str, path: &str, body: Value) -> Result<(), Box<ureq::Error>> {
    agent().post(&format!("{base}/{path}")).timeout(Duration::from_secs(5)).send_json(body).map(|_| ()).map_err(Box::new)
}

/// POST /sessions/<id>/interrupt
pub fn interrupt(peer: &Option<String>, id: &str) -> Result<(), String> {
    agent()
        .post(&interrupt_url(&api(peer), id))
        .send_json(json!({}))
        .map(|_| ())
        .map_err(|e| format!("止められなかった: {e}"))
}

/// POST /sessions/<id>/command。応答は { status, body }
pub fn command(peer: &Option<String>, id: &str, text: &str, timeout: Duration) -> Result<Value, String> {
    request("POST", &command_url(&api(peer), id), json!({ "text": text }), timeout)
}

/// PATCH /sessions/<id>。応答は { status, body }
pub fn patch_session(peer: &Option<String>, id: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    request("PATCH", &session_url(&api(peer), id), body, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_has_node_prefix_only_for_a_peer() {
        let b = "http://h:1";
        assert_eq!(api_at(b, &None), "http://h:1/api");
        assert_eq!(api_at(b, &Some(String::new())), "http://h:1/api");
        assert_eq!(api_at(b, &Some("vm".into())), "http://h:1/n/vm/api");
    }

    #[test]
    fn urls_per_endpoint() {
        let a = "http://h:1/api";
        let n = "http://h:1/n/vm/api";
        assert_eq!(sessions_url(a), "http://h:1/api/sessions");
        assert_eq!(sessions_url(n), "http://h:1/n/vm/api/sessions");
        assert_eq!(session_url(a, "s"), "http://h:1/api/sessions/s");
        assert_eq!(messages_url(n, "s", 7), "http://h:1/n/vm/api/sessions/s/messages?after=7");
        assert_eq!(post_message_url(a, "s"), "http://h:1/api/sessions/s/messages");
        assert_eq!(permission_url(a, "s", "r"), "http://h:1/api/sessions/s/permissions/r");
        assert_eq!(teleport_url(n, "s"), "http://h:1/n/vm/api/sessions/s/teleport");
        assert_eq!(terminal_base(a, "s"), "http://h:1/api/sessions/s/terminal");
        assert_eq!(interrupt_url(a, "s"), "http://h:1/api/sessions/s/interrupt");
        assert_eq!(command_url(n, "s"), "http://h:1/n/vm/api/sessions/s/command");
        assert_eq!(stream_url(n), "http://h:1/n/vm/api/sessions/stream?state=live");
    }
}
