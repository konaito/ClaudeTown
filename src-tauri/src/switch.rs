// チャット欄からモデルと権限モードを替える（アプリが PTY で立てた claude だけ）。画面の決まりは src/session/control.ts。
// CLI に人が打つのと同じ入力を端末に書く。2026-11-21 に v2.1.330 の本物の claude で確かめたこと（PR の本文に記録を付けた）:
// - `/model <別名>` は作業中に打っても待たされず、すぐ効く。同じターンの次の要求から新しいモデルになる（transcript の assistant の model で確認）。
//   会話があると「Switch model?」の確認が出る（既定は Yes）。出たときだけ Enter を送る。会話が無いと確認は出ない。
//   /model は「saved as your default for new sessions」と出し、~/.claude/settings.json に model を書く（Claude Code の動き。ここでは戻さない）
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

/// 出力の中で最後に出た権限モード
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

/// いま当ててよいか。モデルは承認待ちのほかはいつでも、モードは待機中だけ
pub fn can_apply(what: &str, status: &str, ready: bool) -> bool {
    ready && status != "waiting" && (what == "model" || status == "idle")
}

/// 予約する（すぐ当てられるなら、見張りの最初の回で当てる）。同じ値の予約は上書き、None は触らない
pub fn request(id: &str, model: Option<String>, mode: Option<String>) -> Result<Value, String> {
    if !super::pty::owns(id) {
        return Err(super::native::READ_ONLY.into());
    }
    if let Some(m) = &model {
        if m.is_empty() || !m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '[' | ']' | '_')) {
            return Err(format!("モデルの名前が変: {m}"));
        }
    }
    if let Some(m) = &mode {
        if !MODE_LABELS.iter().any(|(_, v)| v == m) {
            return Err(format!("{m} は Shift+Tab の順に無いので、ここからは替えられない"));
        }
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

/// 出力に want が出るまで待つ。出たらその時点の出力を返す
fn wait_out(id: &str, mark: u64, sec: f32, want: impl Fn(&str) -> bool) -> Option<String> {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs_f32(sec) {
        let s = super::pty::out_since(id, mark)?;
        if want(&s) {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// `/model <別名>` を貼って Enter。確認が出たら Enter で Yes を選ぶ。「Set model to」が出たら成功
fn set_model(id: &str, model: &str) -> Result<(), String> {
    let mark = super::pty::out_mark(id).ok_or("このセッションの端末はこのアプリに無い")?;
    super::pty::write(id, &format!("\x1b[200~/model {model}\x1b[201~"))?;
    std::thread::sleep(Duration::from_millis(150));
    super::pty::write(id, "\r")?;
    let s = wait_out(id, mark, 4.0, |s| s.contains("Switch model?") || s.contains("Set model to")).ok_or("/model の結果が4秒で出なかった。ターミナルで様子を見る")?;
    if !s.contains("Set model to") {
        let m2 = super::pty::out_mark(id).unwrap_or(mark);
        super::pty::write(id, "\r")?;
        wait_out(id, m2, 4.0, |s| s.contains("Set model to")).ok_or("モデルの切り替えの確認に Enter を送ったが、切り替わった印が出なかった。ターミナルで様子を見る")?;
    }
    Ok(())
}

/// Shift+Tab を、下の行が目当てのモードになるまで送る。1周して元に戻ったら、目当ては順に無い（元のモードのまま）
fn set_mode(id: &str, mode: &str) -> Result<(), String> {
    let all = super::pty::out_since(id, 0).ok_or("このセッションの端末はこのアプリに無い")?;
    let start = last_mode(&all).ok_or("今の権限モードが端末の表示から読めなかった")?;
    if start == mode {
        return Ok(());
    }
    for _ in 0..MODE_LABELS.len() + 1 {
        let mark = super::pty::out_mark(id).ok_or("端末が無くなった")?;
        super::pty::write(id, SHIFT_TAB)?;
        let s = wait_out(id, mark, 1.5, |s| last_mode(s).is_some()).ok_or("Shift+Tab を送ったが、権限モードの表示が変わらなかった")?;
        let now = last_mode(&s).unwrap_or("");
        if now == mode {
            return Ok(());
        }
        if now == start {
            return Err(format!("Shift+Tab で1周しても {mode} が出なかったので、{start} のままにした（このセッションでは {mode} が使えない）"));
        }
    }
    Err(format!("{mode} に届かなかった。ターミナルで様子を見る"))
}

/// 会話の jsonl。町の一覧が最後に覚えた場所（native::register）から引く
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
    // アプリの端末なら、権限モードは下の行がいちばん新しい（人がターミナルで Shift+Tab を押した分も入る）
    if let Some(m) = super::pty::out_since(id, 0).as_deref().and_then(last_mode) {
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
