use super::*;

// ---------- 端末（PTY） ----------
// このアプリが立てた claude の端末（pty.rs）を、開いた画面の Channel にだけ送る（#9）。
// 出力は UTF-8 の文字列に戻し、16ms に1回までにまとめて送る。バイト列のままは送らない。Channel は 1KB 以上の生のバイト列を
// fetch でもう1往復して渡し、1KB 未満は数の配列の JSON にする。JSON は 8KB 未満なら1回の eval で届く
// （tauri 2.12 の ipc/channel.rs、MAX_RAW_DIRECT_EXECUTE_THRESHOLD と MAX_JSON_DIRECT_EXECUTE_THRESHOLD）。
// 画面は開いている端末の分だけ term_open を呼び、閉じたら term_close を呼ぶ。
// term_open は世代の番号を返し、term_close はその番号の接続だけを閉じる（A→B→A と素早く切り替えても、新しい接続を閉じない）。

/// 出力をまとめる間隔。前に送ってからこれだけたっていれば、すぐ送る（打った文字の返りを遅らせない）
pub(crate) const TERM_FLUSH: Duration = Duration::from_millis(16);

pub(crate) static TERM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 画面へ送るスレッド。出力は TERM_FLUSH に1回までにまとめ、ほかのイベントの前には必ずたまった分を送る（順を変えない）
pub(crate) fn spawn_term_sender(ch: tauri::ipc::Channel<Value>) -> std::sync::mpsc::Sender<pty::TermOut> {
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
pub(crate) fn term_open(session_id: String, on_event: tauri::ipc::Channel<Value>) -> Result<u64, String> {
    app_guard(&session_id)?;
    let generation = TERM_GEN.fetch_add(1, Ordering::SeqCst);
    pty::subscribe(&session_id, generation, spawn_term_sender(on_event))?;
    Ok(generation)
}

/// ターミナルを閉じる。generation を渡したら、その世代の接続のときだけ閉じる。claude は止めない
#[tauri::command]
pub(crate) fn term_close(session_id: String, generation: Option<u64>) -> Result<(), String> {
    pty::unsubscribe(&session_id, generation);
    Ok(())
}

/// 打ったキー。PTY への書き込みはすぐ終わるので、届いた順にそのまま書く
#[tauri::command]
pub(crate) fn term_input(session_id: String, text: String) -> Result<(), String> {
    app_guard(&session_id)?;
    refuse_if_disabled()?;
    pty::write(&session_id, &text)
}

#[tauri::command]
pub(crate) fn term_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    app_guard(&session_id)?;
    pty::resize(&session_id, cols, rows)
}
