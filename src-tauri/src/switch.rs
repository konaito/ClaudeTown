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
// - effort は `/effort` のピッカーで替える（2026-11-23、v2.1.330 で確かめた）。ピッカーは ←/→ で low〜max を動かし、s で「this session only」になる。
//   s では settings.json は変わらなかった。`/effort <値>` と Enter は、会話があると「saved as your default for new sessions」になり、
//   settings.json の modelSettings.<モデル>.effortLevel を書き換えた（会話が無いうちは this session only だった）。だから引数では打たない。
//   ピッカーは作業中（シェルが動いている間）にも開いて効いた。結果は transcript に `<local-command-stdout>Set effort level to <値> (this session only)` で残る。
//   セッションだけのモデルの切り替え（/model のピッカーで s）をした後は、ピッカーの案内が「Enter to use this session only · Esc to cancel」に変わり、
//   s が無くなる（Enter がこのセッションだけになる）。だから押すキーは案内の文で決める。モデルを替えても effort はそのまま残った
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

/// 下の行の権限モード。入力欄より下だけを見る（#250）。下の行が承認の画面などで隠れていれば None。
/// 画面全体から探すと、会話の本文や承認の画面にある「plan mode on」のような文をモードと読む
pub fn last_mode(text: &str) -> Option<&'static str> {
    let below = below_input(text)?;
    MODE_LABELS.iter().filter_map(|(l, v)| below.rfind(l).map(|i| (i, *v))).max_by_key(|(i, _)| *i).map(|(_, v)| v)
}

/// 入力欄の枠線（「────」）。─ で始まり、大半が ─ の行。名前の入った枠線（「──── create-hi-txt-file ─」）も入れる。╌ の線は承認の画面の中の線なので入れない
fn is_box_rule(line: &str) -> bool {
    let t = line.trim();
    let n = t.chars().count();
    n >= 20 && t.starts_with('─') && t.chars().filter(|c| *c == '─').count() * 2 > n
}

/// 入力欄より下の行（ステータス行と下の行）。2026-11-23 に v2.1.330 を tmux で撮った画面（switch_fixtures）では、
/// 枠線、❯ で始まる入力欄（複数行もある）、枠線、ステータス行、モードの行の順に出る。
/// 下から、続く2本の枠線の間の最初の行が ❯ で始まる箱を探す。承認の画面のカーソルの行（「❯ 1. Yes」）は入力欄としない。
/// 箱が無ければ None（下の行が隠れている）。枠線が1本も無い文字列（画面でない1行）は、空でない最後の行だけを見る
fn below_input(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let rules: Vec<usize> = (0..lines.len()).filter(|&i| is_box_rule(lines[i])).collect();
    if rules.is_empty() {
        return lines.iter().rev().find(|l| !l.trim().is_empty()).map(|l| l.to_string());
    }
    let input = |l: &str| {
        l.trim_start().strip_prefix('❯').is_some_and(|r| {
            let r = r.trim_start();
            let d = r.chars().take_while(|c| c.is_ascii_digit()).count();
            !(d > 0 && r[d..].starts_with('.'))
        })
    };
    let (_, bottom) = rules.windows(2).rev().map(|w| (w[0], w[1])).find(|&(top, bottom)| top + 1 < bottom && input(lines[top + 1]))?;
    Some(lines[bottom + 1..].join("\n"))
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Pending {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

impl Pending {
    fn slot(&mut self, what: &str) -> &mut Option<String> {
        match what {
            "model" => &mut self.model,
            "effort" => &mut self.effort,
            _ => &mut self.mode,
        }
    }
    fn is_empty(&self) -> bool {
        self.model.is_none() && self.mode.is_none() && self.effort.is_none()
    }
}

/// 替えたモデル、モード、effort。値ごとに、替えたときの jsonl の長さを持つ（ほかの種類を替えても、前に替えた値の位置は動かさない）。
/// started は替えたときの claude の起動の時刻。再起動や resume の後（時刻が違う）は使わない
#[derive(Clone, Default)]
struct Applied {
    model: Option<(String, u64)>,
    mode: Option<(String, u64)>,
    effort: Option<(String, u64)>,
    started: Option<u64>,
}

/// 予約と、最後に替えた結果（画面に出す）
#[derive(Default)]
struct Book {
    pending: HashMap<String, Pending>,
    /// セッションごとの最後の結果（替えた値、失敗の理由、時刻）
    last: HashMap<String, Value>,
    /// 替えたモデル、モード、effort。transcript に次の行が書かれるまで、今の値として出す（書かれた位置 = 替えたときの jsonl の長さ）
    applied: HashMap<String, Applied>,
    /// 起動に渡した effort（--effort）と、その起動の時刻。transcript に残らないので覚える。起動し直したら（時刻が違えば）使わない
    launched: HashMap<String, (String, u64)>,
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
    let state_file = super::fc_path(super::Scope::Shared, &format!("state/{id}.json"));
    let ready = ready_of(row.as_ref(), &state_file, started, super::now_ms() as u64, &status);
    Some((status, ready))
}

/// 入力を受け付けるところまで起動したか（live の中身。試験のために端末から切り離してある）。
/// 状態ファイルは、この起動の後に書かれたものだけを印にする（composer の gate と同じ hooked_since）。
/// claude --resume で立て直すと前の起動のファイルが残っているので、あるかどうかだけで決めると、読み込み中の claude に書く（#181）
fn ready_of(row: Option<&Value>, state_file: &Path, started: u64, now: u64, status: &str) -> bool {
    let hooked = super::composer::hooked_since(state_file, started);
    super::composer::check_direct(row, hooked, started, now).is_ok() || status == "waiting"
}

/// 当てる直前に承認待ちになっていたときの印。予約に戻して、次の回に当て直す
const RETRY: &str = "承認待ちになったので待つ";

fn waiting(id: &str) -> bool {
    live(id).map(|(st, _)| st == "waiting").unwrap_or(false)
}

/// いま当ててよいか。モデルと effort は承認待ちのほかはいつでも、モードは待機中だけ
pub fn can_apply(what: &str, status: &str, ready: bool) -> bool {
    ready && status != "waiting" && (what != "mode" || status == "idle")
}

/// 新しい世帯を --effort で立てたときに、その値を覚える（session_ops::create_session）
pub fn launched_with(id: &str, effort: &str) {
    let Some(at) = super::pty::started_at(id) else { return };
    with(|b| b.launched.insert(id.to_string(), (effort.to_string(), at)));
}

/// 予約する（すぐ当てられるなら、見張りの最初の回で当てる）。同じ値の予約は上書き、None は触らない
pub fn request(id: &str, model: Option<String>, mode: Option<String>, effort: Option<String>) -> Result<Value, String> {
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
    if let Some(e) = &effort
        && !super::pty::EFFORTS.contains(&e.as_str())
    {
        return Err(format!("{e} は /effort のピッカーに無いので、ここからは替えられない"));
    }
    let start = with(|b| {
        let p = b.pending.entry(id.to_string()).or_default();
        if model.is_some() {
            p.model = model;
        }
        if mode.is_some() {
            p.mode = mode;
        }
        if effort.is_some() {
            p.effort = effort;
        }
        b.last.remove(id);
        !std::mem::replace(&mut b.running, true)
    });
    if start {
        std::thread::spawn(watch);
    }
    Ok(status(id))
}

/// 予約を取り消す。what は model、mode、effort のどれか
pub fn cancel(id: &str, what: &str) -> Value {
    with(|b| {
        if let Some(p) = b.pending.get_mut(id) {
            *p.slot(what) = None;
            if p.is_empty() {
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
            for (what, val) in [("model", p.model.clone()), ("effort", p.effort.clone()), ("mode", p.mode.clone())] {
                let Some(val) = val else { continue };
                if !can_apply(what, &status, ready) {
                    continue;
                }
                let r = match what {
                    "model" => set_model(&id, &val),
                    "effort" => set_effort(&id, &val),
                    _ => set_mode(&id, &val),
                };
                eprintln!("[switch] {id} {what}={val}: {r:?}");
                if r.as_ref().err().map(String::as_str) == Some(RETRY) {
                    break;
                }
                with(|b| {
                    if let Some(q) = b.pending.get_mut(&id) {
                        // 当てている間に別の値で予約し直されていたら、そちらを残す
                        let slot = q.slot(what);
                        if slot.as_deref() == Some(val.as_str()) {
                            *slot = None;
                        }
                        if q.is_empty() {
                            b.pending.remove(&id);
                        }
                    }
                    let at = super::now_ms() as u64;
                    match &r {
                        Ok(_) => {
                            let len = jsonl_len(&id);
                            let started = super::pty::started_at(&id);
                            let e = b.applied.entry(id.clone()).or_default();
                            if e.started != started {
                                *e = Applied { started, ..Applied::default() };
                            }
                            let v = Some((val.clone(), len));
                            match what {
                                "model" => e.model = v,
                                "effort" => e.effort = v,
                                _ => e.mode = v,
                            }
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

const LEFT: &str = "\x1b[D";
const RIGHT: &str = "\x1b[C";
/// /effort のピッカーの下の案内。開いているかの印にする（案内の2つの形のどちらにもある）
pub(crate) const EFFORT_PICKER: &str = "←/→ to adjust";

/// ピッカーで「このセッションだけ」にするキー。案内に「s to use this session only」があれば s（このとき Enter は既定に保存）、
/// 「Enter to use this session only」があれば Enter（セッションだけのモデルの切り替えの後の形）。どちらも無ければ None
pub fn session_only_key(screen: &str) -> Option<&'static str> {
    if screen.contains("s to use this session only") {
        Some("s")
    } else if screen.contains("Enter to use this session only") {
        Some("\r")
    } else {
        None
    }
}

/// /effort のピッカーで、今の印（▲）がある段（low〜max）。▲ の行のすぐ下の、段の名前が並ぶ行で、▲ にいちばん近い名前を選ぶ。
/// 2026-11-23 に v2.1.330 を tmux で撮った画面の形（switch_fixtures/effort_picker_high.txt）
pub fn effort_cursor(screen: &str) -> Option<&'static str> {
    let lines: Vec<&str> = screen.lines().collect();
    let names = super::pty::EFFORTS;
    let (i, row) = lines.iter().enumerate().rev().find(|(_, l)| {
        let w: Vec<&str> = l.split_whitespace().collect();
        names.iter().all(|n| w.contains(n))
    })?;
    let mark = lines.get(i.checked_sub(1)?)?.chars().position(|c| c == '▲')?;
    let chars: Vec<char> = row.chars().collect();
    let words = row.split_whitespace();
    let mut best: Option<(&'static str, f32)> = None;
    let mut from = 0;
    for w in words {
        // 段の名前の文字の位置（▲ と同じく文字で数える）
        let wc: Vec<char> = w.chars().collect();
        let at = (from..chars.len()).find(|&k| chars[k..].starts_with(&wc))?;
        from = at + wc.len();
        let Some(n) = names.iter().find(|n| **n == w) else { continue };
        let d = (at as f32 + (wc.len() as f32 - 1.0) / 2.0 - mark as f32).abs();
        if best.is_none_or(|(_, bd)| d < bd) {
            best = Some((n, d));
        }
    }
    best.map(|(n, _)| n)
}

/// /effort のピッカーを開き、←/→ で目当ての段へ動かして s を押す（このセッションだけ替える）。
/// `/effort <値>` と Enter は、会話があると新しいセッションの既定まで替えるので使わない（2026-11-23、v2.1.330 で確かめた）。
/// ピッカーを閉じるまで端末の錠（pty::serial）を持つ（#168）
fn set_effort(id: &str, effort: &str) -> Result<(), String> {
    super::pty::serial(id, || set_effort_locked(id, effort))
}

fn set_effort_locked(id: &str, effort: &str) -> Result<(), String> {
    let names = super::pty::EFFORTS;
    let want_at = names.iter().position(|n| *n == effort).ok_or(format!("{effort} は /effort のピッカーに無い"))?;
    if !still_applicable(id, "effort") {
        return Err(RETRY.into());
    }
    super::pty::write(id, "\x1b[200~/effort\x1b[201~")?;
    std::thread::sleep(Duration::from_millis(150));
    if waiting(id) || super::composer::blocked_now(id).is_some() {
        return Err("貼った直後に承認の画面が出たので Enter を送らなかった。ターミナルの入力欄に /effort が残っているかもしれない".into());
    }
    super::pty::write(id, "\r")?;
    let s = wait_screen(id, 4.0, |s| s.contains(EFFORT_PICKER) && effort_cursor(s).is_some()).ok_or("/effort のピッカーが4秒で出なかった。ターミナルで様子を見る")?;
    let mut cur = effort_cursor(&s);
    // 矢印は1つずつ送り、印が動いたのを見てから次を送る。端（low、max）では動かない
    for _ in 0..names.len() + 1 {
        let Some(c) = cur else { break };
        let at = names.iter().position(|n| *n == c).unwrap_or(0);
        if at == want_at {
            break;
        }
        super::pty::write(id, if at > want_at { LEFT } else { RIGHT })?;
        match wait_screen(id, 0.8, |s| effort_cursor(s) != cur) {
            Some(s) => cur = effort_cursor(&s),
            None => break,
        }
    }
    if cur != Some(effort) {
        // ピッカーがまだ出ているときだけ Esc を送る。承認の画面に替わっていたら、Esc は承認を断る操作になる
        if !super::pty::screen_text(id).is_some_and(|s| s.contains(EFFORT_PICKER)) {
            return Err(format!("/effort のピッカーで {effort} に動かす途中で、ピッカーが消えた。ターミナルで様子を見る"));
        }
        super::pty::write(id, "\x1b")?;
        wait_screen(id, 1.5, |s| !s.contains(EFFORT_PICKER)).ok_or("effort のピッカーに Esc を送ったが、閉じなかった。ターミナルで様子を見る")?;
        return Err(format!("/effort のピッカーで {effort} に動かせなかったので、閉じた"));
    }
    let Some(key) = super::pty::screen_text(id).as_deref().and_then(session_only_key) else {
        super::pty::write(id, "\x1b")?;
        wait_screen(id, 1.5, |s| !s.contains(EFFORT_PICKER)).ok_or("effort のピッカーに Esc を送ったが、閉じなかった。ターミナルで様子を見る")?;
        return Err("/effort のピッカーに「このセッションだけ」の案内が無かったので、既定を書き換えないよう閉じた".into());
    };
    super::pty::write(id, key)?;
    let want = format!("Set effort level to {effort}");
    let s = wait_screen(id, 4.0, |s| !s.contains(EFFORT_PICKER) && s.contains(&want)).ok_or(format!("ピッカーで s を押したが、4秒たっても「{want}」が出なかった。ターミナルで様子を見る"))?;
    if s.contains("saved as your default") {
        return Err(format!("effort を {effort} にしたが、このセッションだけでなく新しいセッションの既定にも保存された。settings.json の effortLevel を確かめる"));
    }
    Ok(())
}

/// 画面に出ている今の effort。入力欄の右上の「● high · /effort」の行か、起動の見出し（ロゴの █ がある行）の「Opus 5.5 with xhigh effort」。下にあるほうを使う。
/// 会話の本文に同じ言葉があっても読まないよう、印だけの行（4語で /effort で終わる）とロゴの行に限る
pub fn effort_on_screen(screen: &str) -> Option<&'static str> {
    let names = super::pty::EFFORTS;
    screen.lines().rev().find_map(|line| {
        let w: Vec<&str> = line.split_whitespace().collect();
        let hit = if w.len() == 4 && w[2] == "·" && w[3] == "/effort" {
            w[1]
        } else if line.contains('█') {
            w.windows(3).find(|t| t[0] == "with" && t[2] == "effort").map(|t| t[1])?
        } else {
            return None;
        };
        names.iter().find(|n| **n == hit).copied()
    })
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

/// transcript から読んだ今の値
#[derive(Debug, Default, PartialEq)]
pub struct Seen {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

/// transcript の末尾から、最後の権限モード（permission-mode の行）、最後に使ったモデル（assistant の message.model）、
/// 最後に替えた effort（/effort の出力「Set effort level to <値>」）を読む。from より後の行だけを読む（替えた後に書かれた行があるか）。
/// effort は since（この claude を起動した時刻、ms）より後の行だけを使う。--resume で立て直すと、前の起動で替えた effort は消えるため
pub fn from_transcript(p: &Path, from: u64, since: Option<u64>) -> Seen {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 1 << 20;
    let Ok(mut f) = std::fs::File::open(p) else { return Seen::default() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = from.max(len.saturating_sub(TAIL));
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Seen::default();
    }
    let mut buf = String::new();
    let mut bytes = vec![];
    if f.read_to_end(&mut bytes).is_err() {
        return Seen::default();
    }
    buf.push_str(&String::from_utf8_lossy(&bytes));
    let (mut model, mut mode, mut effort) = (None, None, None);
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
            Some("user") => {
                let after = since.is_none_or(|t| v["timestamp"].as_str().and_then(super::native::received::iso_ms).is_some_and(|at| at >= t));
                if let Some(e) = v["message"]["content"].as_str().and_then(effort_of_output).filter(|_| after) {
                    effort = Some(e.to_string());
                }
            }
            _ => {}
        }
    }
    Seen { model, mode, effort }
}

/// /effort の出力の行（`<local-command-stdout>Set effort level to xhigh (this session only): …`）から値を読む
fn effort_of_output(text: &str) -> Option<&'static str> {
    let rest = text.strip_prefix("<local-command-stdout>")?.strip_prefix("Set effort level to ")?;
    let w: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    super::pty::EFFORTS.iter().find(|n| **n == w).copied()
}

/// 今の値、予約、最後の結果。画面の SessionControls が読む
pub fn status(id: &str) -> Value {
    let (pending, last, applied, launched) = with(|b| (b.pending.get(id).cloned().unwrap_or_default(), b.last.get(id).cloned(), b.applied.get(id).cloned(), b.launched.get(id).cloned()));
    let jsonl = jsonl_of(id);
    let started = super::pty::started_at(id);
    let Seen { mut model, mut mode, mut effort } = jsonl.as_deref().map(|p| from_transcript(p, 0, started)).unwrap_or_default();
    // 替えた値は、替えた後に transcript に同じ種類の行が書かれるまで、そちらを今の値とする
    if let Some(a) = applied.filter(|a| a.started == started) {
        let newer = |len: u64| jsonl.as_deref().map(|p| from_transcript(p, len, started)).unwrap_or_default();
        if let Some((v, len)) = a.model
            && newer(len).model.is_none()
        {
            model = Some(v);
        }
        if let Some((v, len)) = a.mode
            && newer(len).mode.is_none()
        {
            mode = Some(v);
        }
        if let Some((v, len)) = a.effort
            && newer(len).effort.is_none()
        {
            effort = Some(v);
        }
    }
    let screen = super::pty::screen_text(id);
    // アプリの端末なら、権限モードは画面の下の行がいちばん新しい（人がターミナルで Shift+Tab を押した分も入る）
    if let Some(m) = screen.as_deref().and_then(last_mode) {
        mode = Some(m.to_string());
    }
    // effort は、この起動で替えていなければ、起動に渡した値、無ければ画面に出ている値（入力欄の右上か起動の見出し）
    if effort.is_none() {
        effort = launched.filter(|(_, at)| Some(*at) == started).map(|(e, _)| e).or_else(|| screen.as_deref().and_then(effort_on_screen).map(str::to_string));
    }
    let (state, ready) = live(id).unwrap_or_default();
    json!({
        "model": model,
        "permissionMode": mode,
        "effort": effort,
        "pending": { "model": pending.model, "permissionMode": pending.mode, "effort": pending.effort },
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
    /// モデル、権限モード、effort を替える。今は替えられなければ予約し、替えられるようになったら替える
    #[tauri::command]
    pub async fn switch_session(session_id: String, model: Option<String>, permission_mode: Option<String>, effort: Option<String>) -> Result<Value, String> {
        crate::app_guard(&session_id)?;
        crate::refuse_if_disabled()?;
        crate::blocking(move || super::request(&session_id, model, permission_mode, effort)).await
    }
    /// 予約を取り消す。what は model、mode、effort のどれか
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

    /// 会話の本文に「plan mode on」があり、下の行は manual。dialog.rs の IDLE（2026-11-22、vt100 で解いた画面）の上に本文を足した
    const IDLE_WITH_PLAN_TEXT: &str = "❯ plan mode on にするにはどうする？\n\n⏺ Shift+Tab を2回押すと、下の行が ⏸ plan mode on になる。\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ⏸ manual mode on · ? for shortcuts\n\n";
    /// 同じ本文の下に道具の承認の画面が出て、入力欄と下の行が隠れた画面。承認の画面は dialog.rs の BASH（2026-11-22、tmux で撮った画面）
    const DIALOG_WITH_PLAN_TEXT: &str = "❯ plan mode on にするにはどうする？\n\n⏺ Shift+Tab を2回押すと、下の行が ⏸ plan mode on になる。\n\n⏺ Bash(echo probe-ok > probe2.txt)\n  ⎿  Waiting…\n────────────────────────────────────────\n Bash command\n Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below\n Write probe-ok into probe2.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n echo probe-ok > probe2.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access to /private/tmp/fc-ask-probe from this project\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n Esc to cancel · Tab to amend\n\n\n";

    // 2026-11-23 に v2.1.330 の claude（haiku）を tmux（100x40）で動かし、capture-pane で撮った実物の画面。
    // 入力欄の上下に枠線、その下にステータス行（このプロファイルの statusLine）、いちばん下にモードの行が出る
    const REAL_IDLE: &str = include_str!("switch_fixtures/idle_bypass.txt");
    /// 入力欄に「plan mode on と打ちかけ」を打った（送っていない）
    const REAL_TYPED: &str = include_str!("switch_fixtures/typed_plan_text.txt");
    /// 幅を 44 に縮めた。入力欄の上に「ctrl+y to paste deleted text」が出る
    const REAL_NARROW: &str = include_str!("switch_fixtures/narrow_plan.txt");
    /// 会話の本文に「plan mode on」があり、下の行は manual
    const REAL_BODY: &str = include_str!("switch_fixtures/body_plan_text_manual.txt");
    /// 本文と質問の画面に「plan mode on」があり、質問の画面で入力欄と下の行が隠れている
    const REAL_ASK: &str = include_str!("switch_fixtures/ask_plan_text.txt");

    #[test]
    fn last_mode_reads_only_the_line_under_the_input_box() {
        assert_eq!(last_mode(REAL_IDLE), Some("bypassPermissions"));
        assert_eq!(last_mode(REAL_TYPED), Some("bypassPermissions"));
        assert_eq!(last_mode(REAL_NARROW), Some("plan"));
        assert_eq!(last_mode(REAL_BODY), Some("default"));
        assert_eq!(last_mode(IDLE_WITH_PLAN_TEXT), Some("default"));
        // docs/research/pty-measure.md の 40 行の画面の下の5行（枠線、入力欄、枠線、ステータス行、モードの行）
        let measured = "⏺ 1\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  work:✗ main\n  ⏵⏵ auto mode on (shift+tab to cycle)";
        assert_eq!(last_mode(measured), Some("auto"));
        // 下の行が隠れていると、本文の「plan mode on」をモードとして読まない（#250）
        assert_eq!(last_mode(REAL_ASK), None);
        assert_eq!(last_mode(DIALOG_WITH_PLAN_TEXT), None);
        // 承認の画面のコマンド（╌ の間）に文言があっても読まない
        assert_eq!(last_mode(&DIALOG_WITH_PLAN_TEXT.replace("echo probe-ok > probe2.txt\n╌", "echo 'accept edits on' > probe2.txt\n╌")), None);
        // dialog_fixtures の実物の質問の画面（下の行が隠れている）
        for s in [include_str!("dialog_fixtures/ask_quote_q1.txt"), include_str!("dialog_fixtures/ask_quote_q2.txt"), include_str!("dialog_fixtures/ask_quote_review.txt")] {
            assert_eq!(last_mode(s), None);
        }
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
        assert!(can_apply("effort", "busy", true));
        assert!(!can_apply("effort", "waiting", true));
    }

    // 2026-11-23 に v2.1.330 の claude を tmux（140x45）で動かし、capture-pane で撮った /effort のピッカー
    const EFFORT_HIGH: &str = include_str!("switch_fixtures/effort_picker_high.txt");
    const EFFORT_XHIGH: &str = include_str!("switch_fixtures/effort_picker_xhigh.txt");
    const EFFORT_LOW: &str = include_str!("switch_fixtures/effort_picker_low.txt");
    /// 同じ日、/model のピッカーで s（セッションだけ）を押した後に開いた /effort のピッカー。案内に s が無く、Enter がこのセッションだけになる
    const EFFORT_AFTER_MODEL: &str = include_str!("switch_fixtures/effort_picker_after_model.txt");

    #[test]
    fn effort_cursor_reads_the_mark_above_the_names() {
        assert_eq!(effort_cursor(EFFORT_HIGH), Some("high"));
        assert_eq!(effort_cursor(EFFORT_XHIGH), Some("xhigh"));
        assert_eq!(effort_cursor(EFFORT_LOW), Some("low"));
        assert_eq!(effort_cursor(EFFORT_AFTER_MODEL), Some("max"));
        assert!(EFFORT_HIGH.contains(EFFORT_PICKER) && EFFORT_AFTER_MODEL.contains(EFFORT_PICKER));
        // 押すキー。ふつうの形の Enter は既定に保存なので、s を押す
        assert_eq!(session_only_key(EFFORT_HIGH), Some("s"));
        assert_eq!(session_only_key(EFFORT_AFTER_MODEL), Some("\r"));
        assert_eq!(session_only_key(REAL_IDLE), None);
        // ピッカーが閉じた画面では読まない
        assert_eq!(effort_cursor(REAL_IDLE), None);
        assert_eq!(effort_cursor("❯ /effort\n  ⎿  Set effort level to xhigh (this session only)"), None);
    }

    #[test]
    fn effort_on_screen_reads_the_badge_or_the_banner() {
        assert_eq!(effort_on_screen("     ◈ max · /effort\n────\n❯ \n────"), Some("max"));
        assert_eq!(effort_on_screen(" ▝▜██████▀  Opus 5.5 with xhigh effort · Claude Team\n❯ "), Some("xhigh"));
        // 下にあるほう（新しいほう）を使う
        assert_eq!(effort_on_screen("▝▜██████▀  Opus 5.5 with xhigh effort\n● high · /effort"), Some("high"));
        assert_eq!(effort_on_screen(EFFORT_AFTER_MODEL), Some("max"));
        assert_eq!(effort_on_screen("/effort を打つ"), None);
        // 会話の本文の文は読まない
        assert_eq!(effort_on_screen("⏺ Opus 5.5 with high effort で動いている\n  あとで low · /effort を試す"), None);
        assert_eq!(effort_on_screen("⏺ 下の行は ● high · /effort になる"), None);
        assert_eq!(effort_on_screen(REAL_IDLE), None);
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
        let seen = |model: Option<&str>, mode: Option<&str>, effort: Option<&str>| Seen { model: model.map(Into::into), mode: mode.map(Into::into), effort: effort.map(Into::into) };
        assert_eq!(from_transcript(&p, 0, None), seen(Some("claude-sonnet-5-5"), Some("acceptEdits"), None));
        let len = std::fs::metadata(&p).unwrap().len();
        assert_eq!(from_transcript(&p, len, None), Seen::default());
        assert_eq!(from_transcript(&dir.join("none.jsonl"), 0, None), Seen::default());
        // /effort の出力（2026-11-23 の実物の行の形）。起動より前の行は使わない（--resume で立て直すと消えるため）
        let effort = [
            r#"{"type":"user","timestamp":"2026-11-23T07:44:50.000Z","message":{"role":"user","content":"<local-command-stdout>Set effort level to xhigh (this session only): Deeper reasoning than high, just below maximum (on supported models)</local-command-stdout>"}}"#,
            r#"{"type":"user","timestamp":"2026-11-23T07:45:06.662Z","message":{"role":"user","content":"<local-command-stdout>Cancelled</local-command-stdout>"}}"#,
            r#"{"type":"user","timestamp":"2026-11-23T07:46:00.000Z","message":{"role":"user","content":"<local-command-stdout>Set effort level to max (this session only): Maximum capability</local-command-stdout>"}}"#,
        ];
        std::fs::write(&p, effort.join("\n") + "\n").unwrap();
        let ms = |s: &str| super::super::native::received::iso_ms(s).unwrap();
        assert_eq!(from_transcript(&p, 0, None).effort.as_deref(), Some("max"));
        assert_eq!(from_transcript(&p, 0, Some(ms("2026-11-23T07:45:00Z"))).effort.as_deref(), Some("max"));
        assert_eq!(from_transcript(&p, 0, Some(ms("2026-11-23T07:47:00Z"))).effort, None);
        std::fs::write(&p, effort[..2].join("\n") + "\n").unwrap();
        assert_eq!(from_transcript(&p, 0, None).effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn applied_values_are_dropped_after_a_restart() {
        // 替えた値は、替えたときの起動の時刻と今の起動の時刻が同じときだけ使う。このアプリに端末の無い id は、今の起動の時刻が None
        let id = format!("fc-test-applied-{}", fastrand::u64(..));
        with(|b| b.applied.insert(id.clone(), Applied { effort: Some(("low".into(), 0)), started: Some(1), ..Applied::default() }));
        assert_eq!(status(&id)["effort"], Value::Null, "前の起動で替えた effort を使った");
        with(|b| b.applied.insert(id.clone(), Applied { effort: Some(("low".into(), 0)), started: None, ..Applied::default() }));
        assert_eq!(status(&id)["effort"], "low");
        with(|b| b.applied.remove(&id));
    }

    #[test]
    fn stale_state_file_does_not_make_it_ready() {
        // claude --resume で立て直すと、前の起動の state/<id>.json が残っている（#181）。起動の印を出さないまま 3.5 秒たっても、ready にしない
        let dir = std::env::temp_dir().join(format!("fc-switch-ready-{}-{}", std::process::id(), fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("state.json");
        std::fs::write(&f, "{}").unwrap();
        let now = super::super::now_ms() as u64;
        let started = now - 3_500;
        let old = std::time::UNIX_EPOCH + Duration::from_millis(started - 60_000);
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(old).unwrap();
        assert!(!ready_of(None, &f, started, now, "idle"), "前の起動の状態ファイルで起動したとみなした");
        // この起動の後に書かれたら、起動から3秒で ready
        std::fs::File::options().write(true).open(&f).unwrap().set_modified(std::time::UNIX_EPOCH + Duration::from_millis(started + 500)).unwrap();
        assert!(ready_of(None, &f, started, now, "idle"));
        assert!(!ready_of(None, &f, started, started + 2_000, "idle"), "起動から3秒は待つ");
        // 状態ファイルが無くても、承認待ちなら ready（承認待ちは起動の後にしか出ない）
        assert!(ready_of(None, &dir.join("none.json"), started, now, "waiting"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
