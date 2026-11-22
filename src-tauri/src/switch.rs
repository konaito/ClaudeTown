// チャット欄からモデルと権限モードを替える（アプリが PTY で立てた claude だけ）。画面の決まりは src/session/control.ts。
// CLI に人が打つのと同じ入力を端末に書く。2026-11-21 に v2.1.330 の本物の claude で確かめたこと（PR の本文に記録を付けた）:
// - `/model` は作業中に打っても待たされず、すぐ効く。同じターンの次の要求から新しいモデルになる（transcript の assistant の model で確認）。
//   `/model <別名>` と Enter は新しいセッションの既定も替える（settings.json の model の行を消しても戻らない）。だから /model のピッカーを開き、
//   目当ての行で s を押す（「for this session only」と出て、settings.json も既定も変わらなかった）。
//   会話があると「Switch model?」の確認が出る（既定は Yes）。出たときだけ Enter を送る。会話が無いと確認は出ない。
// - 権限モードを直接決めるコマンドは /plan だけ。ほかは Shift+Tab で順に回す。順は default → acceptEdits → plan →（bypassPermissions）→（auto）。
//   括弧の2つは使えるときだけ出る。dontAsk は出ない。作業中に回してもすぐ効くが、途中のモード（bypassPermissions など）を通るので、作業中は待つ。
//   今のモードは、端末の下の行（「⏸ manual mode on」など）でしか分からない。待機中に回しても hook も transcript も書かれない（次の文から書かれる）
// - 承認の画面が出ている間に書くと、入力が承認の画面に入る（Enter は許可になる）。だから承認待ちの間は待つ
//
// 予約: 今は替えられないときは、選んだ値をここで持ち、替えられるようになったら替える。見張りは予約がある間だけ動く。
// 状態は ~/.claude/sessions/<pid>.json の status を直接読む（町の一覧の見張りは、窓が隠れると止まるので頼らない）。
// 予約はアプリの再起動の後に持ち越さない。アプリが立てた claude はアプリと一緒に止まる（pty.rs の kill_all）ので、持ち越しても宛先が無い。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 端末の下の行の文言と、権限モードの値。v2.1.330 の画面で見た4つと、出なかった auto（文言は推測、見えなければ届かない扱いになる）
const MODE_LABELS: [(&str, &str); 5] = [
    ("manual mode on", "default"),
    ("accept edits on", "acceptEdits"),
    ("plan mode on", "plan"),
    ("bypass permissions on", "bypassPermissions"),
    ("auto mode on", "auto"),
];
const SHIFT_TAB: &str = "\x1b[Z";

/// 画面の中で最後に出た権限モード（下の行）
pub fn last_mode(text: &str) -> Option<&'static str> {
    MODE_LABELS.iter().filter_map(|(l, v)| text.rfind(l).map(|i| (i, *v))).max_by_key(|(i, _)| *i).map(|(_, v)| v)
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Pending {
    pub model: Option<String>,
    pub mode: Option<String>,
}

/// 予約と、最後に替えた結果（画面に出す）
#[derive(Default)]
struct Book {
    pending: HashMap<String, Pending>,
    /// セッションごとの最後の結果（替えた値、失敗の理由、時刻）
    last: HashMap<String, Value>,
    /// 替えたモデルとモード。transcript に次の行が書かれるまで、今の値として出す（書かれた位置 = 替えたときの jsonl の長さ）
    applied: HashMap<String, (Option<String>, Option<String>, u64)>,
    running: bool,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Book) -> T) -> T {
    let mut g = BOOK.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Book::default))
}

/// 今の claude の status（busy、waiting、idle）と、入力を受け付けるところまで起動したか。sessions/<pid>.json を読む
fn live(id: &str) -> Option<(String, bool)> {
    let pid = super::pty::pid_of_id(id)?;
    let started = super::pty::started_at(id)?;
    // send_direct と同じく、覚えた一覧ではなく今の sessions/<pid>.json を読む
    let row = super::native::sessions::fresh_row(&super::native::claude_home(), pid);
    let state = row.as_ref().and_then(|r| r["state"].as_str()).unwrap_or("").to_string();
    let status = match state.as_str() { "running" => "busy", "waiting_permission" => "waiting", "idle" => "idle", _ => "" }.to_string();
    let hooked = super::fc_path(super::Scope::Shared, &format!("state/{id}.json")).exists();
    let ready = super::composer::check_direct(row.as_ref(), hooked, started, super::now_ms() as u64).is_ok() || status == "waiting";
    Some((status, ready))
}

/// 当てる直前に承認待ちになっていたときの印。予約に戻して、次の回に当て直す
const RETRY: &str = "承認待ちになったので待つ";

fn waiting(id: &str) -> bool {
    live(id).map(|(st, _)| st == "waiting").unwrap_or(false)
}

/// いま当ててよいか。モデルは承認待ちのほかはいつでも、モードは待機中だけ
pub fn can_apply(what: &str, status: &str, ready: bool) -> bool {
    ready && status != "waiting" && (what == "model" || status == "idle")
}

/// 予約する（すぐ当てられるなら、見張りの最初の回で当てる）。同じ値の予約は上書き、None は触らない
pub fn request(id: &str, model: Option<String>, mode: Option<String>) -> Result<Value, String> {
    if !super::pty::owns(id) {
        return Err(super::native::READ_ONLY.into());
    }
    if let Some(m) = &model
        && picker_name(m).is_none()
    {
        return Err(format!("{m} は /model のピッカーの上の段に無いので、ここからは替えられない。ターミナルで /model を開いて選ぶ"));
    }
    if let Some(m) = &mode
        && !MODE_LABELS.iter().any(|(_, v)| v == m)
    {
        return Err(format!("{m} は Shift+Tab の順に無いので、ここからは替えられない"));
    }
    let start = with(|b| {
        let p = b.pending.entry(id.to_string()).or_default();
        if model.is_some() {
            p.model = model;
        }
        if mode.is_some() {
            p.mode = mode;
        }
        b.last.remove(id);
        !std::mem::replace(&mut b.running, true)
    });
    if start {
        std::thread::spawn(watch);
    }
    Ok(status(id))
}

/// 予約を取り消す。what は model か mode
pub fn cancel(id: &str, what: &str) -> Value {
    with(|b| {
        if let Some(p) = b.pending.get_mut(id) {
            if what == "model" { p.model = None } else { p.mode = None }
            if p.model.is_none() && p.mode.is_none() {
                b.pending.remove(id);
            }
        }
    });
    status(id)
}

/// 予約がある間だけ回る見張り。0.5秒ごとに状態を読み、当てられるものを当てる
fn watch() {
    loop {
        let jobs: Vec<(String, Pending)> = with(|b| {
            b.pending.retain(|id, _| super::pty::owns(id));
            if b.pending.is_empty() {
                b.running = false;
            }
            b.pending.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        });
        if jobs.is_empty() {
            return;
        }
        for (id, p) in jobs {
            let Some((status, ready)) = live(&id) else { continue };
            for (what, val) in [("model", p.model.clone()), ("mode", p.mode.clone())] {
                let Some(val) = val else { continue };
                if !can_apply(what, &status, ready) {
                    continue;
                }
                let r = if what == "model" { set_model(&id, &val) } else { set_mode(&id, &val) };
                eprintln!("[switch] {id} {what}={val}: {r:?}");
                if r.as_ref().err().map(String::as_str) == Some(RETRY) {
                    break;
                }
                with(|b| {
                    if let Some(q) = b.pending.get_mut(&id) {
                        // 当てている間に別の値で予約し直されていたら、そちらを残す
                        let slot = if what == "model" { &mut q.model } else { &mut q.mode };
                        if slot.as_deref() == Some(val.as_str()) {
                            *slot = None;
                        }
                        if q.model.is_none() && q.mode.is_none() {
                            b.pending.remove(&id);
                        }
                    }
                    let at = super::now_ms() as u64;
                    match &r {
                        Ok(_) => {
                            let len = jsonl_len(&id);
                            let e = b.applied.entry(id.clone()).or_insert((None, None, len));
                            if what == "model" { e.0 = Some(val.clone()) } else { e.1 = Some(val.clone()) }
                            e.2 = len;
                            b.last.insert(id.clone(), json!({ "what": what, "value": val, "ok": true, "at": at }));
                        }
                        Err(e) => {
                            b.last.insert(id.clone(), json!({ "what": what, "value": val, "ok": false, "error": e, "at": at }));
                        }
                    }
                });
                // 1つ当てたら状態を読み直す（モデルの確認の画面を閉じた直後に、続けてモードを回さない）
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// 画面（vt100 で解いたもの）が want を満たすまで待つ。満たしたらその時の画面を返す
fn wait_screen(id: &str, sec: f32, want: impl Fn(&str) -> bool) -> Option<String> {
    let t0 = Instant::now();
    loop {
        let s = super::pty::screen_text(id)?;
        if want(&s) {
            return Some(s);
        }
        if t0.elapsed() >= Duration::from_secs_f32(sec) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// モデルの別名と、/model のピッカーの行の名前。ピッカーの上の段に無いもの（More models の中、[1m] など）は扱わない
pub fn picker_name(model: &str) -> Option<&'static str> {
    let m = model.strip_prefix("claude-").unwrap_or(model);
    [("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku"), ("fable", "Fable")].iter().find(|(k, _)| m == *k || m.starts_with(&format!("{k}-"))).map(|(_, v)| *v)
}

/// ピッカーで今カーソル（❯）がある行の名前（「❯ 4.  Sonnet 5.5」の Sonnet）。入力欄の「❯ /model」は数えない
pub fn picker_cursor(screen: &str) -> Option<String> {
    screen.lines().rev().find_map(|line| {
        let r = line.split_once('❯')?.1.trim_start();
        let digits = r.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || !r[digits..].starts_with('.') {
            return None;
        }
        let name: String = r[digits + 1..].trim_start().chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        (!name.is_empty()).then_some(name)
    })
}

const UP: &str = "\x1b[A";
const DOWN: &str = "\x1b[B";
pub(crate) const PICKER: &str = "Select model";
const CONFIRM: &str = "Switch model?";

/// /model でピッカーを開き、目当ての行へ矢印で動かして s を押す（このセッションだけ替える）。
/// `/model <別名>` と Enter は新しいセッションの既定まで替えるので使わない（2026-11-21、v2.1.330 で確かめた）。
/// 会話があると「Switch model?」の確認が出る。出たときだけ Enter を送る。ピッカーと確認が閉じ、「Set model to <名前>」が見えたら成功。
/// ピッカーを閉じるまで端末の錠（pty::serial）を持ち、チャット欄の送信と承認への答えのキーを間に入れない（#168）
pub(crate) fn set_model(id: &str, model: &str) -> Result<(), String> {
    super::pty::serial(id, || set_model_locked(id, model))
}

/// 錠を待つ間に状態が変わる（見張りが live を読んだ後に、承認待ちになるなど）ので、錠の中で読み直す。当てられなければ予約に戻す
fn still_applicable(id: &str, what: &str) -> bool {
    live(id).is_some_and(|(st, ready)| can_apply(what, &st, ready)) && super::composer::blocked_now(id).is_none()
}

fn set_model_locked(id: &str, model: &str) -> Result<(), String> {
    let name = picker_name(model).ok_or(format!("{model} は /model のピッカーの上の段に無いので、ここからは替えられない"))?;
    // 承認の画面に入力が入らないよう、貼る前と Enter の前に今の状態を読み直す（send_direct と同じ穴）
    if !still_applicable(id, "model") {
        return Err(RETRY.into());
    }
    super::pty::write(id, "\x1b[200~/model\x1b[201~")?;
    std::thread::sleep(Duration::from_millis(150));
    if waiting(id) || super::composer::blocked_now(id).is_some() {
        return Err("貼った直後に承認の画面が出たので Enter を送らなかった。ターミナルの入力欄に /model が残っているかもしれない".into());
    }
    super::pty::write(id, "\r")?;
    let s = wait_screen(id, 4.0, |s| s.contains(PICKER) && picker_cursor(s).is_some()).ok_or("/model のピッカーが4秒で出なかった。ターミナルで様子を見る")?;
    let mut cur = picker_cursor(&s);
    // 上へ、届かなければ下へ。矢印は1つずつ送る（まとめて書くと動かなかった）。カーソルが動かなくなったら端
    'find: for key in [UP, DOWN] {
        for _ in 0..12 {
            if cur.as_deref() == Some(name) {
                break 'find;
            }
            let before = cur.clone();
            super::pty::write(id, key)?;
            match wait_screen(id, 0.8, |s| picker_cursor(s) != before) {
                Some(s) => cur = picker_cursor(&s),
                None => continue 'find,
            }
        }
    }
    if cur.as_deref() != Some(name) {
        super::pty::write(id, "\x1b")?;
        // 閉じたのを見てから錠を放す。見ずに戻ると、待っていた送信が閉じかけのピッカーを読んで断る
        wait_screen(id, 1.5, |s| !s.contains(PICKER)).ok_or("ピッカーに Esc を送ったが、閉じなかった。ターミナルで様子を見る")?;
        return Err(format!("/model のピッカーに {name} の行が見つからなかったので、閉じた"));
    }
    super::pty::write(id, "s")?;
    let s = wait_screen(id, 4.0, |s| s.contains(CONFIRM) || !s.contains(PICKER)).ok_or("ピッカーで s を押したが、4秒たってもピッカーが閉じなかった。ターミナルで様子を見る")?;
    if s.contains(CONFIRM) {
        super::pty::write(id, "\r")?;
        wait_screen(id, 4.0, |s| !s.contains(CONFIRM)).ok_or("モデルの切り替えの確認に Enter を送ったが、確認の画面が閉じなかった。ターミナルで様子を見る")?;
    }
    let want = format!("Set model to {name}");
    wait_screen(id, 2.0, |s| s.contains(&want)).ok_or(format!("ピッカーは閉じたが「{want}」が出なかった。ターミナルで様子を見る"))?;
    Ok(())
}

/// Shift+Tab を、下の行が目当てのモードになるまで送る。1周して元に戻ったら、目当ては順に無い（元のモードのまま）。
/// 回し終えるまで端末の錠（pty::serial）を持つ（#168）。承認の画面で Shift+Tab を押すと承認の操作になるので、錠の中で状態を読み直す
fn set_mode(id: &str, mode: &str) -> Result<(), String> {
    super::pty::serial(id, || set_mode_locked(id, mode))
}

fn set_mode_locked(id: &str, mode: &str) -> Result<(), String> {
    if !still_applicable(id, "mode") {
        return Err(RETRY.into());
    }
    let screen = super::pty::screen_text(id).ok_or("このセッションの端末はこのアプリに無い")?;
    let start = last_mode(&screen).ok_or("今の権限モードが端末の表示から読めなかった")?;
    if start == mode {
        return Ok(());
    }
    let mut cur = start;
    for _ in 0..MODE_LABELS.len() + 1 {
        super::pty::write(id, SHIFT_TAB)?;
        let s = wait_screen(id, 1.5, |s| last_mode(s).is_some_and(|m| m != cur)).ok_or("Shift+Tab を送ったが、権限モードの表示が変わらなかった")?;
        cur = last_mode(&s).unwrap_or("");
        if cur == mode {
            return Ok(());
        }
        if cur == start {
            return Err(format!("Shift+Tab で1周しても {mode} が出なかったので、{start} のままにした（このセッションでは {mode} が使えない）"));
        }
    }
    Err(format!("{mode} に届かなかった。ターミナルで様子を見る"))
}

fn jsonl_of(id: &str) -> Option<std::path::PathBuf> {
    super::native::path_of(id)
}

fn jsonl_len(id: &str) -> u64 {
    jsonl_of(id).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0)
}

/// transcript の末尾から、最後の権限モード（permission-mode の行）と、最後に使ったモデル（assistant の message.model）を読む。
/// from より後の行だけを読む（替えた後に書かれた行があるか）
pub fn from_transcript(p: &Path, from: u64) -> (Option<String>, Option<String>) {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 1 << 20;
    let Ok(mut f) = std::fs::File::open(p) else { return (None, None) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = from.max(len.saturating_sub(TAIL));
    if f.seek(SeekFrom::Start(start)).is_err() {
        return (None, None);
    }
    let mut buf = String::new();
    let mut bytes = vec![];
    if f.read_to_end(&mut bytes).is_err() {
        return (None, None);
    }
    buf.push_str(&String::from_utf8_lossy(&bytes));
    let (mut model, mut mode) = (None, None);
    // 途中から読んだときの最初の行は欠けているかもしれないが、JSON として読めなければ飛ばすだけ
    for line in buf.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v["type"].as_str() {
            Some("permission-mode") => {
                if let Some(m) = v["permissionMode"].as_str() {
                    mode = Some(m.to_string());
                }
            }
            Some("assistant") => {
                if let Some(m) = v["message"]["model"].as_str().filter(|m| m.starts_with("claude-")) {
                    model = Some(m.to_string());
                }
            }
            _ => {}
        }
    }
    (model, mode)
}

/// 今の値、予約、最後の結果。画面の SessionControls が読む
pub fn status(id: &str) -> Value {
    let (pending, last, applied) = with(|b| (b.pending.get(id).cloned().unwrap_or_default(), b.last.get(id).cloned(), b.applied.get(id).cloned()));
    let jsonl = jsonl_of(id);
    let (mut model, mut mode) = jsonl.as_deref().map(|p| from_transcript(p, 0)).unwrap_or((None, None));
    // 替えた値は、替えた後に transcript に同じ種類の行が書かれるまで、そちらを今の値とする
    if let Some((am, amode, len)) = applied {
        let (nm, nmode) = jsonl.as_deref().map(|p| from_transcript(p, len)).unwrap_or((None, None));
        if am.is_some() && nm.is_none() {
            model = am;
        }
        if amode.is_some() && nmode.is_none() {
            mode = amode;
        }
    }
    // アプリの端末なら、権限モードは画面の下の行がいちばん新しい（人がターミナルで Shift+Tab を押した分も入る）
    if let Some(m) = super::pty::screen_text(id).as_deref().and_then(last_mode) {
        mode = Some(m.to_string());
    }
    let (state, ready) = live(id).unwrap_or_default();
    json!({
        "model": model,
        "permissionMode": mode,
        "pending": { "model": pending.model, "permissionMode": pending.mode },
        "last": last,
        "status": state,
        "ready": ready,
    })
}

pub(crate) mod cmd {
    use serde_json::Value;
    /// モデルと権限モード（always-switch）。今の値、予約、最後の結果。アプリの外のセッションは transcript から読んだ今の値だけ
    #[tauri::command]
    pub async fn session_settings(session_id: String) -> Result<Value, String> {
        crate::blocking(move || Ok(super::status(&session_id))).await
    }
    /// モデルか権限モードを替える。今は替えられなければ予約し、替えられるようになったら替える
    #[tauri::command]
    pub async fn switch_session(session_id: String, model: Option<String>, permission_mode: Option<String>) -> Result<Value, String> {
        crate::app_guard(&session_id)?;
        crate::refuse_if_disabled()?;
        crate::blocking(move || super::request(&session_id, model, permission_mode)).await
    }
    /// 予約を取り消す。what は model か mode
    #[tauri::command]
    pub async fn cancel_switch(session_id: String, what: String) -> Result<Value, String> {
        crate::blocking(move || Ok(super::cancel(&session_id, &what))).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_mode_reads_the_latest_footer() {
        // 2026-11-21 の raw の出力の形（色の印に挟まれる）
        let s = "\x1b[38;2;153;153;153m⏸ manual mode on\x1b[39m\x1b[K ... \x1b[38;2;175;135;255m⏵⏵ accept edits on\x1b[38;2;153;153;153m (shift+tab to cycle)";
        assert_eq!(last_mode(s), Some("acceptEdits"));
        assert_eq!(last_mode("⏵⏵ bypass permissions on (shift+tab to cycle) ⏸ plan mode on"), Some("plan"));
        assert_eq!(last_mode("nothing"), None);
    }

    #[test]
    fn picker_rows_are_read_from_the_screen() {
        // 2026-11-21 に pyte で解いた画面の形
        let screen = "❯ /model\n  Select model\n    1.  Default (recommended)  Opus 5.5 · Best for everyday\n  ❯ 4.  Sonnet 5.5             Most efficient\n    5.  Haiku 5.5 ✔";
        assert_eq!(picker_cursor(screen).as_deref(), Some("Sonnet"));
        assert_eq!(picker_cursor("❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only"), None);
        assert_eq!(picker_name("sonnet"), Some("Sonnet"));
        assert_eq!(picker_name("claude-opus-5-5"), Some("Opus"));
        assert_eq!(picker_name("opus[1m]"), None);
    }

    #[test]
    fn screen_from_the_raw_picker_output() {
        // 作業中に開いたピッカーは、行を描き直さず ❯ の1文字だけを書き直す。生の文字列では読めないが、vt100 で解けば読める
        let mut p = vt100::Parser::new(std::num::NonZeroU16::new(6).unwrap(), std::num::NonZeroU16::new(40).unwrap(), 0);
        p.process(b"  Select model\r\n\xe2\x9d\xaf 1.  Default\r\n  2.  Opus 5.5\r\n  3.  Sonnet 5.5");
        p.process(b"\x1b[2;1H \x1b[3;1H\xe2\x9d\xaf");
        let sc = p.screen();
        let text = sc.rows(0, sc.size().1.get()).collect::<Vec<_>>().join("\n");
        assert_eq!(picker_cursor(&text).as_deref(), Some("Opus"));
    }

    #[test]
    fn model_waits_only_for_approval_and_mode_waits_for_idle() {
        assert!(can_apply("model", "busy", true));
        assert!(can_apply("model", "idle", true));
        assert!(!can_apply("model", "waiting", true));
        assert!(!can_apply("model", "idle", false));
        assert!(can_apply("mode", "idle", true));
        assert!(!can_apply("mode", "busy", true));
        assert!(!can_apply("mode", "waiting", true));
    }

    #[test]
    fn transcript_gives_last_mode_and_model() {
        let dir = std::env::temp_dir().join(format!("fc-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        // 2026-11-21 の実物の行の形（必要なキーだけ）
        let lines = [
            r#"{"type":"permission-mode","permissionMode":"default","sessionId":"x"}"#,
            r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[]}}"#,
            r#"{"type":"permission-mode","permissionMode":"acceptEdits","sessionId":"x"}"#,
            r#"{"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[]}}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>","content":[]}}"#,
        ];
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        assert_eq!(from_transcript(&p, 0), (Some("claude-sonnet-5-5".into()), Some("acceptEdits".into())));
        let len = std::fs::metadata(&p).unwrap().len();
        assert_eq!(from_transcript(&p, len), (None, None));
        assert_eq!(from_transcript(&dir.join("none.jsonl"), 0), (None, None));
    }
}
