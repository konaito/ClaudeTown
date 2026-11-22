use super::*;

// ---------- 作る・止める ----------

/// 新しい世帯を立てる。claude をこのアプリの中の端末で起動する（pty.rs）。cwd を省くと ~/Documents/meta（本人の指定）。
/// cols と rows は、画面のターミナルの今の大きさ。渡せば claude を最初からその大きさで起動し、開いた直後の描き直しを省く（#18）
pub(crate) fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
    refuse_if_disabled()?;
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(default_place);
    let ok = |v: Option<u16>, d: u16| v.filter(|n| (10..=1000).contains(n)).unwrap_or(d);
    let r = pty::spawn(&cwd, name.as_deref(), ok(cols, 120), ok(rows, 40), town_kick)?;
    town_kick();
    Ok(r)
}

/// 場所を設定していないときに新しい世帯を立てる場所（本人の指定）
pub(crate) fn default_place() -> String {
    home().join("Documents/meta").to_string_lossy().to_string()
}

/// 新しい世帯のペイン（#89）の「最近使った場所」の材料。形は画面の src/newHouse/places.ts の PlacesInput。
/// defaultPlace は、画面が設定の場所を持っていないときに、一覧から除く場所（決定 4、2026-11-21）
pub(crate) fn house_places() -> Result<Value, String> {
    let live: Vec<Value> = town_rows().into_iter().filter(|r| r["kind"] == "terminal").map(|r| json!({ "cwd": r["cwd"], "lastActivityAt": r["lastActivityAt"] })).collect();
    Ok(json!({ "roots": [], "lobby": null, "sessions": live, "places": places::recent(&native::claude_home()), "defaultPlace": default_place() }))
}

/// このアプリが立てたセッションを止める
pub(crate) fn stop_session(session_id: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::kill(&session_id)?;
    town_kick();
    Ok(())
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    use serde_json::Value;

    #[tauri::command]
    pub async fn create_session(cwd: Option<String>, name: Option<String>, cols: Option<u16>, rows: Option<u16>) -> Result<Value, String> {
        crate::blocking(move || super::create_session(cwd, name, cols, rows)).await
    }
    #[tauri::command]
    pub async fn house_places() -> Result<Value, String> { crate::blocking(super::house_places).await }
    #[tauri::command]
    pub async fn stop_session(session_id: String) -> Result<(), String> {
        crate::blocking(move || super::stop_session(session_id)).await
    }
}
