use super::*;

// ---------- 作る・止める・転出 ----------

/// この機械のノード名（~/.config/ccn/ccn.json の name）。親を名乗るヘッダに使う
pub(crate) fn node_name() -> String {
    for rel in [".config/ccn/ccn.json", ".config/cc/cc.json"] {
        if let Some(n) = read_json(&home().join(rel)).and_then(|v| v["name"].as_str().map(String::from)) {
            return n;
        }
    }
    "local".into()
}

/// create_session の入力。画面の invoke は平らなキー（cwd、prompt、parent、name、cols、rows、resume、fork、succeed、peer）で渡すので、
/// その形は命令の包み（cmd::create_session）が受け、この構造体に詰めて中身の関数へ渡す
#[derive(Clone, Default)]
pub(crate) struct CreateReq {
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub parent: Option<String>,
    pub name: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub resume: Option<String>,
    pub fork: Option<bool>,
    pub succeed: Option<bool>,
    pub peer: Option<String>,
}

/// ccn の POST /api/sessions に送る中身（create_session の分）。空の prompt と name は送らない。fork は resume があるときだけ、
/// succeed は resume と fork があるときだけ送る（ccn は succeed に resume と fork: true を求める）
pub(crate) fn create_body(req: &CreateReq) -> Value {
    let CreateReq { cwd, prompt, name, cols, rows, resume, fork, succeed, .. } = req.clone();
    let cwd = cwd.unwrap_or_default();
    // ccn は 10〜1000 だけを受ける
    let ok = |v: Option<u16>| v.filter(|n| (10..=1000).contains(n));
    let mut body = json!({ "terminal": true, "cwd": cwd, "cols": ok(cols).unwrap_or(120), "rows": ok(rows).unwrap_or(40) });
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) { body["prompt"] = json!(p); }
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) { body["name"] = json!(n); }
    if let Some(r) = resume.filter(|r| !r.trim().is_empty()) {
        body["resume"] = json!(r);
        if fork.unwrap_or(false) {
            body["fork"] = json!(true);
            if succeed.unwrap_or(false) { body["succeed"] = json!(true); }
        }
    }
    body
}

/// 端末（PTY）のセッションを立てる。parent を渡すと、その親の子として立てる（x-ccn-from で親を名乗る）。
/// 渡さなければ新しい世帯（親なし）になる。cwd を省くと ~/Documents/meta（本人の指定）
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
/// resume を渡すと、そのセッションの会話を付け直す。fork も渡すと、会話を複製した新しい id で立てる（引き継ぎ。src/succeed.ts）。
/// このとき claude のアカウントは、ほかの作成と同じく ccn が選ぶ
/// succeed も渡すと、ccn に引き継ぎを頼む（ccn の PR #56 から）。ccn が後継の起動を確かめ、前任の子を後継へ付け替え、前任を止め、応答に succeeded を入れる。
/// 古い ccn は succeed を読まず、ただの複製を返す（応答に succeeded が無い）。どちらだったかは画面が応答で見分ける（src/succeed.ts）。
/// ccn が断ったときの失敗は「ccn が <状態> を返した: <応答の JSON>」の形で返す。画面はこの JSON から code（no_account など）を読む
pub(crate) fn create_session(req: CreateReq) -> Result<Value, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = req.peer.clone().filter(|p| !p.is_empty());
    let cwd = req.cwd.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| home().join("Documents/meta").to_string_lossy().to_string());
    let body = create_body(&CreateReq { cwd: Some(cwd), ..req.clone() });
    // 親を名乗る。一覧の parent に agent:<ノード>/<親の sid 先頭8>/town が入り、木がつながる
    let from = req.parent.filter(|p| !p.is_empty()).map(|pid| format!("agent:{}/{}/town", node_name(), &pid[..8.min(pid.len())]));
    ccn::create_session(&peer, body, from)
}

/// 新しい世帯のペイン（#89）の「最近使った場所」の材料。手元のノードの /api/host、/api/sessions、/api/places をそのまま返し、
/// 合わせ方は画面（src/newHouse/places.ts）で決める。places は走査に最大3秒かかり、古い ccn は 404 を返すので、失敗したら null にする
pub(crate) fn house_places() -> Result<Value, String> {
    let host = ccn::host()?;
    let sessions = ccn::sessions(&None)?;
    let places = ccn::places().ok().and_then(|v| v.get("places").cloned());
    Ok(json!({ "roots": host.get("roots").cloned().unwrap_or(json!([])), "lobby": host.get("lobby").cloned().unwrap_or(Value::Null), "sessions": sessions, "places": places }))
}

/// セッションの詳細（承認の pending を含む）
pub(crate) fn session_detail(session_id: String, peer: Option<String>) -> Result<Value, String> {
    native_guard(&session_id, &peer)?;
    let peer = peer.filter(|p| !p.is_empty());
    ccn::session(&peer, &session_id)
}

/// 転出の下見の1段目（移動元の説明）。副作用は無い。2段目の行き先の下見は clone することがあるので、画面からは呼ばない
pub(crate) fn teleport_info(session_id: String, peer: Option<String>) -> Result<Value, String> {
    native_guard(&session_id, &peer)?;
    let peer = peer.filter(|p| !p.is_empty());
    ccn::teleport_info(&peer, &session_id)
}

pub(crate) fn stop_session(session_id: String, peer: Option<String>) -> Result<(), String> {
    native_guard(&session_id, &peer)?;
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    ccn::delete_session(&peer, &session_id)?;
    // 止めたセッションの会話の保存は要らない
    offline::remove_conv(&cache_dir(), &peer, &session_id);
    Ok(())
}

/// 転出（ccn の teleport。PR #18）。移動元のノードが下見から取り込みまで1回の要求で進め、結果を返す（最大95秒）
#[tauri::command]
pub(crate) async fn teleport(session_id: String, to: String, fork: bool, subtree: Option<bool>, dry_run: Option<bool>, peer: Option<String>) -> Result<Value, String> {
    native_guard(&session_id, &peer)?;
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        // subtree は子孫ごと移す口（ccn-pty が作る別 PR）。dry_run は計画だけを返す
        let mut body = json!({ "to": to, "fork": fork });
        if subtree.unwrap_or(false) { body["subtree"] = json!(true); }
        if dry_run.unwrap_or(false) { body["dryRun"] = json!(true); }
        // 移った先でも親とつながるよう、元の parent（agent:<ノード>/<親の sid8>/<役割>）を from 行として付けて頼む（ccn::teleport）。
        // 付けないと、移った先の parent は local になる（2026-11-12、fc-teleport-test の試験ノードで確かめた）
        ccn::teleport(&peer, &session_id, body)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    use super::*;

    // 画面の invoke が平らなキーで渡すので、引数は10個のまま受ける（Tauri の引数名がそのまま JSON のキーになる）。ここで構造体に詰める
    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    pub async fn create_session(cwd: Option<String>, prompt: Option<String>, parent: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, resume: Option<String>, fork: Option<bool>, succeed: Option<bool>, peer: Option<String>) -> Result<Value, String> {
        blocking(move || super::create_session(CreateReq { cwd, prompt, parent, name, cols, rows, resume, fork, succeed, peer })).await
    }
    #[tauri::command]
    pub async fn house_places() -> Result<Value, String> { blocking(super::house_places).await }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// cwd を "/w" に固定した create_body の呼び出し。引数の並びは (prompt, name, cols, rows, resume, fork, succeed)
    fn body_of(prompt: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, resume: Option<String>, fork: Option<bool>, succeed: Option<bool>) -> Value {
        create_body(&CreateReq { cwd: Some("/w".into()), prompt, name, cols, rows, resume, fork, succeed, ..Default::default() })
    }

    #[test]
    fn create_body_sends_fork_only_with_resume() {
        let s = |v: &str| Some(v.to_string());
        // 新しい世帯: resume も fork も succeed も送らない。空の prompt と name も送らない
        let b = body_of(s(" "), None, Some(100), Some(30), None, Some(true), Some(true));
        assert_eq!(b, json!({ "terminal": true, "cwd": "/w", "cols": 100, "rows": 30 }));
        // 複製: 前任の ID を resume に、fork を true にして送る
        let b = body_of(s("続き"), s("meta"), None, Some(5), s("1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa"), Some(true), None);
        assert_eq!(b, json!({ "terminal": true, "cwd": "/w", "cols": 120, "rows": 40, "prompt": "続き", "name": "meta", "resume": "1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa", "fork": true }));
        // 引き継ぎ: resume と fork に succeed を足す
        let b = body_of(s("続き"), None, None, None, s("1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa"), Some(true), Some(true));
        assert_eq!(b, json!({ "terminal": true, "cwd": "/w", "cols": 120, "rows": 40, "prompt": "続き", "resume": "1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa", "fork": true, "succeed": true }));
        // fork 無しの付け直しは resume だけ。succeed を渡されても送らない（ccn は fork の無い succeed を 400 で断る）
        let b = body_of(None, None, None, None, s("1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa"), None, Some(true));
        assert_eq!(b["resume"], "1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa");
        assert!(b.get("fork").is_none());
        assert!(b.get("succeed").is_none());
    }

    /// 付け直し（resume）の作成は、共有の Agent の8秒より長く待つ（RESUME_TIMEOUT）。10秒かけて返す偽の ccn で確かめる。
    /// 時間がかかる（約18秒）ので、ふだんは回さない: cargo test resume_create_waits -- --ignored
    #[test]
    #[ignore]
    fn resume_create_waits_longer_than_default() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let _ = s.read(&mut buf);
                    std::thread::sleep(Duration::from_secs(10));
                    let body = r#"{"id":"f7a05063-6d62-40d7-b13c-3604a655dfda","depth":0}"#;
                    let _ = write!(s, "HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body);
                });
            }
        });
        let url = format!("http://127.0.0.1:{port}/api/sessions");
        let s = |v: &str| Some(v.to_string());
        // resume 無し: 既定の8秒で切れる
        let t = std::time::Instant::now();
        let plain = ccn::post_create(&url, body_of(None, None, None, None, None, None, None), None);
        assert!(plain.is_err(), "{plain:?}");
        assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
        // resume あり: 10秒かかる応答を受け取る
        let t = std::time::Instant::now();
        let got = ccn::post_create(&url, body_of(s("続き"), None, None, None, s("1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa"), Some(true), Some(true)), None);
        assert_eq!(got.unwrap()["id"], "f7a05063-6d62-40d7-b13c-3604a655dfda");
        assert!(t.elapsed() >= Duration::from_secs(10), "{:?}", t.elapsed());
    }
}
