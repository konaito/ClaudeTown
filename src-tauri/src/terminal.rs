use super::*;

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
pub(crate) const TERM_FLUSH: Duration = Duration::from_millis(16);

/// 画面へ送るもの。Text は出力（data）の文字列で、まとめて送る。Event は size、replay、exit、error などで、たまった出力を先に送ってから送る
pub(crate) enum TermOut {
    Text(String),
    Event(String, Value),
}

pub(crate) struct TermConn {
    stop: Arc<AtomicBool>,
    generation: u64,
    out: std::sync::mpsc::Sender<TermOut>,
}
pub(crate) static TERMS: Mutex<Option<HashMap<String, TermConn>>> = Mutex::new(None);
pub(crate) static TERM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 開いたターミナルの画面に知らせる（書き手の送りそびれなど）。開いていなければ捨てる
pub(crate) fn term_notice(session_id: &str, ev: &str, data: Value) {
    if let Ok(g) = TERMS.lock()
        && let Some(c) = g.as_ref().and_then(|m| m.get(session_id)) {
            let _ = c.out.send(TermOut::Event(ev.into(), data));
        }
}

/// 続きのあるバイト列を UTF-8 の文字列に直す。末尾で途中まで来た文字は carry に残し、次の分の頭に付ける。壊れたバイトは U+FFFD にする
pub(crate) fn utf8_stream(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
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
pub(crate) fn spawn_term_sender(ch: tauri::ipc::Channel<Value>) -> std::sync::mpsc::Sender<TermOut> {
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
pub(crate) fn term_open(session_id: String, peer: Option<String>, on_event: tauri::ipc::Channel<Value>) -> Result<u64, String> {
    native_guard(&session_id, &peer)?;
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
    let url = ccn::terminal_url(&peer, &session_id);
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
pub(crate) fn read_terminal(url: &str, stop: &AtomicBool, mut emit: impl FnMut(&str, Value)) {
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
                    if ev == "size"
                        && let Some(e) = v.get("epoch").filter(|e| !e.is_null()) {
                            epoch = Some(e.as_str().map(String::from).unwrap_or_else(|| e.to_string()));
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
pub(crate) fn term_close(session_id: String, generation: Option<u64>) -> Result<(), String> {
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
    if let Ok(mut w) = WRITERS.lock()
        && let Some(m) = w.as_mut() { m.retain(|k, _| !k.ends_with(&format!("|{session_id}"))); }
    Ok(())
}

/// 打ったキーと大きさの変更。送るのはセッションごとの書き手のスレッド（term_send）で、命令はすぐ返る
#[tauri::command]
pub(crate) fn term_input(session_id: String, text: String, peer: Option<String>) -> Result<(), String> {
    native_guard(&session_id, &peer)?;
    if send_disabled() {
        return Err("送信を止めている（~/.family-computing/send-disabled がある）".into());
    }
    term_send(&session_id, peer.filter(|p| !p.is_empty()), TermCmd::Input(text))
}

#[tauri::command]
pub(crate) fn term_resize(session_id: String, cols: u16, rows: u16, peer: Option<String>) -> Result<(), String> {
    native_guard(&session_id, &peer)?;
    term_send(&session_id, peer.filter(|p| !p.is_empty()), TermCmd::Resize(cols, rows))
}

pub(crate) enum TermCmd {
    Input(String),
    Resize(u16, u16),
}
pub(crate) static WRITERS: Mutex<Option<HashMap<String, std::sync::mpsc::Sender<TermCmd>>>> = Mutex::new(None);

pub(crate) fn writer_key(session_id: &str, peer: &Option<String>) -> String {
    format!("{}|{session_id}", peer.clone().unwrap_or_default())
}

/// キーと大きさの変更を、セッションごとに1本のスレッドで、受けた順に ccn へ送る。
/// 要求ごとに別のスレッドで送ると、打った順と届く順が入れ替わりうるため（#3）。
/// 書き手は term_close で片付ける（送り口を落とすと、残りを送り切ってからスレッドが終わる）。
pub(crate) fn term_send(session_id: &str, peer: Option<String>, cmd: TermCmd) -> Result<(), String> {
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
                if let Ok(mut g) = WRITERS.lock()
                    && let Some(m) = g.as_mut() { m.remove(&key); }
            }
        }
    }
    Err("ターミナルに書けなかった（書き手を作れなかった）".into())
}

pub(crate) fn spawn_writer(session_id: String, peer: Option<String>) -> std::sync::mpsc::Sender<TermCmd> {
    let (tx, rx) = std::sync::mpsc::channel::<TermCmd>();
    std::thread::spawn(move || {
        let post_term = ccn::terminal_writer(&peer, &session_id);
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
                if let Err(e) = post_term(path, body) {
                    term_notice(&session_id, "input_error", json!({ "message": format!("{what}: {e}") }));
                }
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
