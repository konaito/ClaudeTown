use super::*;

// ---------- 町の一覧の見張り（#5） ----------
//
// 画面が決まった間隔で snapshot を呼ぶのをやめ、Rust のスレッドが一覧を作り、前回と変わったときだけ Channel で画面へ送る。
// 変化が無ければ画面（JS）は一度も起きない。
// 間隔は、変化が無い回が続くと 2秒→4秒→8秒と延ばし、8秒で止める。変わったら2秒に戻す。
// 上限を8秒にしたのは、静かな町で承認待ちや返事待ちが出たとき、画面に出るまでの遅れを8秒までに抑えるため（「あなたの番」を早く見せる）
// 画面が見えていない間は、画面が town_unwatch で止める（#6）。端末を立てた、止めた、終わったときは town_kick ですぐ作り直す。

/// 変化が無い回が続いたときの間隔の下限と上限
pub(crate) const WATCH_MIN: Duration = Duration::from_secs(2);
pub(crate) const WATCH_MAX: Duration = Duration::from_secs(8);

pub(crate) enum WatchCmd {
    Kick,
    Stop,
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

/// 見張りの本体。一覧を作り、前回と変わったときだけ send に渡す。send が false を返すか Stop で終わる
pub(crate) fn watch_loop(rx: std::sync::mpsc::Receiver<WatchCmd>, mut send: impl FnMut(Value) -> bool) {
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
pub(crate) fn town_watch(on_event: tauri::ipc::Channel<Value>) -> u64 {
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
pub(crate) fn town_unwatch(generation: u64) {
    let mut w = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    if w.as_ref().map(|(g, _)| *g) == Some(generation)
        && let Some((_, tx)) = w.take() {
            let _ = tx.send(WatchCmd::Stop);
        }
}

/// 見張りに、すぐ取り直させる
#[tauri::command]
pub(crate) fn town_kick() {
    if let Some((_, tx)) = WATCH.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = tx.send(WatchCmd::Kick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

}
