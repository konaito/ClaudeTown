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

/// ccn の POST /api/sessions に送る中身（create_session の分）。空の prompt と name は送らない。fork は resume があるときだけ、
/// succeed は resume と fork があるときだけ送る（ccn は succeed に resume と fork: true を求める）
pub(crate) fn create_body(cwd: String, prompt: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, resume: Option<String>, fork: Option<bool>, succeed: Option<bool>) -> Value {
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
pub(crate) fn create_session(cwd: Option<String>, prompt: Option<String>, parent: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>, resume: Option<String>, fork: Option<bool>, succeed: Option<bool>, peer: Option<String>) -> Result<Value, String> {
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    let peer = peer.filter(|p| !p.is_empty());
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| home().join("Documents/meta").to_string_lossy().to_string());
    let body = create_body(cwd, prompt, name, cols, rows, resume, fork, succeed);
    // 親を名乗る。一覧の parent に agent:<ノード>/<親の sid 先頭8>/town が入り、木がつながる
    let from = parent.filter(|p| !p.is_empty()).map(|pid| format!("agent:{}/{}/town", node_name(), &pid[..8.min(pid.len())]));
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
