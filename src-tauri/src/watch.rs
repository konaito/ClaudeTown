use super::*;

// ---------- 町の一覧の見張り（#5） ----------
//
// 画面が決まった間隔で snapshot を呼ぶのをやめ、Rust のスレッドが一覧を取り、前回と変わったときだけ Channel で画面へ送る。
// 変化が無ければ画面（JS）は一度も起きない。ccn に変化を流す口（SSE）が町の全部を覆うまでのつなぎ。
// ccn の GET /api/events は、コードを読んだ範囲では hook の状態ファイル（state/、close-check）とお手紙の変化を含まないので、まだ使わない。
// 間隔は、変化が無い回が続くと 2秒→4秒→8秒と延ばし、8秒で止める。変わったら2秒に戻す。つながらない回は毎回送り、2秒で取り直す。
// 上限を8秒にしたのは、静かな町で承認待ちや返事待ちが出たとき、画面に出るまでの遅れを8秒までに抑えるため（「あなたの番」を早く見せる）
// 画面が見えていない間は、画面が town_unwatch で止める（#6）。

/// 変化が無い回が続いたときの間隔の下限と上限
pub(crate) const WATCH_MIN: Duration = Duration::from_secs(2);
pub(crate) const WATCH_MAX: Duration = Duration::from_secs(8);

pub(crate) enum WatchCmd {
    Kick,
    Stop,
    /// 一覧の SSE が送ってきた一覧（ccn #35 の GET /api/sessions/stream?state=live の event: sessions の data）
    List(Vec<Value>),
    /// 一覧の SSE が終わった、または使えなかった。理由と、404 だったか（古い版のノード）
    StreamEnded(String, bool),
}

/// 一覧の SSE を、この長さ何も来なければ切ってポーリングに戻す。ccn は15秒ごとに keep-alive を送る。
/// Cloudflare の中継などで本文が溜められたときも、これで戻る
pub(crate) const STREAM_SILENT: Duration = Duration::from_secs(20);
/// 一覧の SSE が切れたときに、次に試すまでの長さ。404（古い版のノード）なら長くあける。
/// 404 でも試し直すのは、開いたままの窓が、ノードを新しくした後に乗り替われるようにするため
pub(crate) const STREAM_RETRY: Duration = Duration::from_secs(60);
pub(crate) const STREAM_RETRY_NOT_FOUND: Duration = Duration::from_secs(300);

/// 一覧の SSE の本文を読み、event: sessions の data（一覧の配列）ごとに on を呼ぶ。on が false を返すか stop が立てば終わる。
/// 枠は ccn の src/api/sse.ts の形（`id: <ETag>` `event: sessions` `data: <1行の JSON>` と空行、keep-alive は `: keep-alive` と空行）。
/// id（引用符つきの ETag）は使わない。つなぎ直すたびに一覧の全体を受ける。返り値は終わった理由
pub(crate) fn pump_sessions_sse(reader: impl BufRead, stop: &AtomicBool, mut on: impl FnMut(Vec<Value>) -> bool) -> String {
    let (mut ev, mut data) = (String::new(), String::new());
    for line in reader.lines() {
        if stop.load(Ordering::SeqCst) {
            return "止めた".into();
        }
        let line = match line {
            Ok(l) => l,
            Err(e) => return format!("読めなくなった（{}秒何も来ないときも含む）: {e}", STREAM_SILENT.as_secs()),
        };
        if line.is_empty() {
            if ev == "sessions" {
                match serde_json::from_str::<Value>(&data) {
                    Ok(Value::Array(v)) => {
                        if !on(v) {
                            return "止めた".into();
                        }
                    }
                    _ => return "一覧の形が想定と違う".into(),
                }
            }
            ev.clear();
            data.clear();
        } else if let Some(x) = line.strip_prefix("event:") {
            ev = x.trim().to_string();
        } else if let Some(x) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(x.trim_start());
        }
        // id: と、: で始まる keep-alive は読み捨てる
    }
    "ccn が閉じた".into()
}

/// 一覧の SSE につないで読む。200 で text/event-stream のときだけ読み、それ以外（404、502、HTML のページなど）はすぐ理由を返す。
/// 共有の agent() は全体の時間切れ（8秒）が付いていて長い接続が切れるので、読みの時間切れ（STREAM_SILENT）だけの agent を使う
pub(crate) fn read_sessions_stream(url: &str, stop: &AtomicBool, on: impl FnMut(Vec<Value>) -> bool) -> (String, bool) {
    let a = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(STREAM_SILENT).build();
    match a.get(url).call() {
        Ok(r) if r.status() == 200 && r.content_type() == "text/event-stream" => (pump_sessions_sse(BufReader::new(r.into_reader()), stop, on), false),
        Ok(r) => (format!("SSE ではない応答（{} {}）", r.status(), r.content_type()), false),
        Err(ureq::Error::Status(code, _)) => (format!("ccn が {code} を返した"), code == 404),
        Err(e) => (format!("つながらない: {e}"), false),
    }
}
/// いま動いている見張り（窓は1つなので1本だけ）。世代と、止めるための口
pub(crate) static WATCH: Mutex<Option<(u64, std::sync::mpsc::Sender<WatchCmd>)>> = Mutex::new(None);
pub(crate) static WATCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 前回と同じかを比べる鍵。取得した時刻（fetched_at）は毎回変わるので除く
pub(crate) fn snapshot_key(s: &Snapshot) -> String {
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("fetched_at");
    }
    v.to_string()
}

/// 次に取るまでの間隔。変わったら下限に戻し、変わらなければ倍にする（上限で止める）
pub(crate) fn next_wait(cur: Duration, changed: bool) -> Duration {
    if changed { WATCH_MIN } else { (cur * 2).min(WATCH_MAX) }
}

/// 見張りの本体。一覧を受け取り、前回と変わったとき（つながらない回は毎回）だけ send に渡す。send が false を返すか Stop で終わる。
/// 一覧は、ccn の一覧の SSE が使えればそこから受け、使えなければ GET /sessions で取る（#5）。
/// どちらのときも 2秒→4秒→8秒 の周期で町を作り直す。SSE が運ぶのは ccn の一覧だけで、hook の状態ファイル、close-check、
/// 世帯の名前、お手紙の変化は来ないため。SSE の間の作り直しは、最後に受けた一覧を使い、HTTP の要求は出さない
pub(crate) fn watch_loop(peer: Option<String>, tx: std::sync::mpsc::Sender<WatchCmd>, rx: std::sync::mpsc::Receiver<WatchCmd>, mut send: impl FnMut(Value) -> bool) {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Instant;
    let mut last: Option<String> = None;
    let mut wait = WATCH_MIN;
    // SSE から受けた最後の一覧。Some の間は GET /sessions を出さない
    let mut list: Option<Vec<Value>> = None;
    // 次に SSE を試す時刻。None はつないでいる最中
    let mut stream_at = Some(Instant::now());
    let stop = Arc::new(AtomicBool::new(false));
    let url = ccn::sessions_stream_url(&peer);
    loop {
        // 設定で ccn を切ったら SSE を読まない（つないでいたら、受けた一覧を捨てる。agents_from も使わない）
        let ccn_off = peer.is_none() && !ccn_use();
        if ccn_off {
            list = None;
        }
        if !ccn_off && stream_at.is_some_and(|at| Instant::now() >= at) {
            stream_at = None;
            let (u, st, t) = (url.clone(), stop.clone(), tx.clone());
            std::thread::spawn(move || {
                let (why, not_found) = read_sessions_stream(&u, &st, |v| t.send(WatchCmd::List(v)).is_ok());
                let _ = t.send(WatchCmd::StreamEnded(why, not_found));
            });
        }
        let s = match &list {
            Some(v) => snapshot_from(peer.clone(), Ok(v.clone())),
            None => snapshot(peer.clone()),
        };
        let key = snapshot_key(&s);
        let changed = last.as_deref() != Some(key.as_str());
        // つながらない回は、同じ中身でも毎回送る（画面が続けて失敗した回数を数え、「つながりにくい」を出す）
        if (changed || !s.ccn_ok) && !send(serde_json::to_value(&s).unwrap_or(Value::Null)) {
            break;
        }
        wait = if s.ccn_ok { next_wait(wait, changed) } else { WATCH_MIN };
        last = Some(key);
        // SSE を試し直す時刻が先に来るなら、そこで起きる
        let nap = stream_at.map(|at| wait.min(at.saturating_duration_since(Instant::now()))).unwrap_or(wait);
        match rx.recv_timeout(nap) {
            // すぐ取り直す（新しい世帯を作った直後など）。間隔も下限に戻す
            Ok(WatchCmd::Kick) => wait = WATCH_MIN,
            // 一覧が変わった。すぐ作り直す
            Ok(WatchCmd::List(v)) => {
                if list.is_none() {
                    eprintln!("[town] 一覧の SSE につないだ（{url}）");
                }
                list = Some(v);
                wait = WATCH_MIN;
            }
            // SSE が使えない、切れた。ポーリングに戻り、しばらくしてから試し直す
            Ok(WatchCmd::StreamEnded(why, not_found)) => {
                eprintln!("[town] 一覧の SSE をやめてポーリングに戻す: {why}");
                list = None;
                stream_at = Some(Instant::now() + if not_found { STREAM_RETRY_NOT_FOUND } else { STREAM_RETRY });
            }
            Ok(WatchCmd::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    // SSE を読んでいるスレッドは、次の行（keep-alive は15秒ごと）か時間切れで、この旗を見て終わる
    stop.store(true, Ordering::SeqCst);
}

/// 町の一覧の見張りを始める。前の見張りがあれば止める。戻り値の世代を town_unwatch に渡す
#[tauri::command]
pub(crate) fn town_watch(peer: Option<String>, on_event: tauri::ipc::Channel<Value>) -> u64 {
    let (tx, rx) = std::sync::mpsc::channel::<WatchCmd>();
    let generation = WATCH_GEN.fetch_add(1, Ordering::SeqCst);
    // 見張りは、SSE を読むスレッドに渡すために送り口の写しを持つ
    let tx2 = tx.clone();
    if let Some((_, old)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).replace((generation, tx)) {
        let _ = old.send(WatchCmd::Stop);
    }
    std::thread::spawn(move || watch_loop(peer, tx2, rx, |v| on_event.send(v).is_ok()));
    generation
}

/// 見張りを止める。世代が今の見張りと違えば何もしない（後から始めた見張りを止めない）
#[tauri::command]
pub(crate) fn town_unwatch(generation: u64) {
    let mut w = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    if w.as_ref().map(|(g, _)| *g) == Some(generation) {
        if let Some((_, tx)) = w.take() {
            let _ = tx.send(WatchCmd::Stop);
        }
    }
}

/// 見張りに、すぐ取り直させる
#[tauri::command]
pub(crate) fn town_kick() {
    if let Some((_, tx)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = tx.send(WatchCmd::Kick);
    }
}
