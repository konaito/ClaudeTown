// アプリの中の端末（PTY）。「＋ 新しい世帯」で claude をこのアプリの子プロセスとして起動し、出力を右パネルの xterm.js に流す。
// crate は portable-pty（wezterm の一部、MIT）。同期の API で、読み書きをスレッドで回す今の作りにそのまま合う。
//
// - 起動するとき `--session-id <uuid>` を渡す。Claude Code は ~/.claude/sessions/<pid>.json にこの id を書く（2026-11-21 に実測）。
//   /clear などで id が変わっても pid は同じなので、台帳は pid で引き、一覧で同じ pid に見えた id を足していく（ids）。
// - 出力の末尾 KEEP_BYTES を持ち、端末を開いた画面には size と replay（持っている分）を送ってから、続きを data で流す。
// - アプリを終えるとき、ここから立てた claude を全部止める（kill_all）。アプリが落ちたときは、PTY の親の側が閉じて
//   claude に SIGHUP が届く（下の試験と README に結果を書いた）。どちらでも、アプリから立てた世帯はアプリと一緒に止まる。
// - そのため、立てた端末の一覧（台帳）を terminals.json に残し、次に起動したときに `--resume <id>` で立て直す（#152）。
//   台帳から外すのは、画面から閉じたときと claude が自分で終わったときだけ。アプリを終えるとき（kill_all）と、
//   アプリが落ちたとき（SIGTERM など、終わりの処理を通らない）は台帳に触らないので、開いていた分が残る。
// - 書き口（writer）は claude が動いている間は落とさない。portable-pty は書き口を落とすときに改行と EOT を書くので、
//   動いている claude には Enter が届いてしまう。

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// replay のために持つ出力の末尾の長さ
const KEEP_BYTES: usize = 1 << 20;

/// 画面へ送るもの。Text は出力（data）の文字列で、まとめて送る。Event は size、replay、exit、error などで、たまった出力を先に送ってから送る
pub enum TermOut {
    Text(String),
    Event(String, Value),
}

struct Proc {
    pid: u32,
    /// 起動のときに渡した id と、一覧で同じ pid に見えた id。最初が起動のときの id
    ids: Vec<String>,
    /// 今の id（sessions/<pid>.json に今出ている id）。台帳にはこれを残す。/resume で前の id に戻ると ids は増えないので、別に持つ
    cur: String,
    /// 起動のときに --name で渡した名前
    name: Option<String>,
    cwd: String,
    started_at: u64,
    size: (u16, u16),
    master: Box<dyn MasterPty + Send>,
    /// 書き口は台帳の錠の外で書く（claude が読まずに PTY が詰まっても、出力の読み手と一覧を止めない）
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 何回かに分けて書く操作を1つずつ通す錠（serial、#168）
    serial: Arc<Mutex<()>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 出力の末尾
    out: Vec<u8>,
    /// 出力を端末として解いた今の画面（vt100、MIT）。モデルのピッカーと権限モードの表示を読むのに使う（switch.rs）。
    /// 出力の生の文字列は、語の間の空白がカーソルの移動の印になり、ピッカーの行も ❯ の1文字だけを描き直すので、そのままでは読めない
    screen: vt100::Parser,
    /// 開いている画面（世代、送り口）と、送りかけの文字の残り
    sub: Option<(u64, Sender<TermOut>)>,
    carry: Vec<u8>,
}

static PROCS: Mutex<Option<HashMap<u32, Proc>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<u32, Proc>) -> T) -> T {
    let mut g = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

fn pid_of(map: &HashMap<u32, Proc>, id: &str) -> Option<u32> {
    map.values().find(|p| p.ids.iter().any(|x| x == id)).map(|p| p.pid)
}

/// このアプリが立てたセッションか
pub fn owns(id: &str) -> bool {
    with(|m| pid_of(m, id).is_some())
}

/// 一覧で見えた行（id と pid）を台帳に足す。/clear などで id が変わっても、同じ pid なら同じ端末として扱う。
/// 端末が前に名乗った id が別の pid の行として見えたら（よその端末で `claude --resume <前の id>`、#174）、その端末の ids から外す。
/// 今の id（cur）は外さない。起動の直後や、claude を子として立てる launcher では、一覧の pid が台帳の pid と合わないことがあるため
pub fn note_ids(rows: &[(String, u32)]) {
    let changed = with(|m| {
        let mut changed = false;
        for (id, pid) in rows {
            if let Some(p) = m.get_mut(pid) {
                if !p.ids.contains(id) {
                    p.ids.push(id.clone());
                }
                if p.cur != *id {
                    p.cur = id.clone();
                    changed = true;
                }
            }
        }
        // cur を全部の行で決めてから外す（同じ回の一覧で /clear の後の id がまだ後ろにあっても、前の id を外せるように）
        for (id, pid) in rows {
            for p in m.values_mut() {
                if p.pid != *pid && p.cur != *id && p.ids.len() > 1 {
                    p.ids.retain(|x| x != id);
                }
            }
        }
        changed
    });
    if changed {
        persist();
    }
}

/// 台帳の1件の要約（一覧に足す行を作るため）
pub struct Info {
    pub id: String,
    pub ids: Vec<String>,
    /// 今の id（sessions/<pid>.json に今出ている id）
    pub cur: String,
    pub pid: u32,
    pub cwd: String,
    pub started_at: u64,
}

pub fn list() -> Vec<Info> {
    with(|m| {
        let mut v: Vec<Info> = m.values().map(|p| Info { id: p.ids[0].clone(), ids: p.ids.clone(), cur: p.cur.clone(), pid: p.pid, cwd: p.cwd.clone(), started_at: p.started_at }).collect();
        v.sort_by_key(|i| i.started_at);
        v
    })
}

/// 起動のときの時刻（ms）。台帳に無ければ None
pub fn started_at(id: &str) -> Option<u64> {
    with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.started_at))
}

/// UUID の v4（claude の --session-id に渡す）
pub fn new_uuid() -> String {
    let mut b = [0u8; 16];
    for x in b.iter_mut() {
        *x = fastrand::u8(..);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

// ---------- claude の場所と環境 ----------

/// ログインシェルの PATH。Finder から開いたアプリの PATH は /usr/bin:/bin:/usr/sbin:/sbin だけで、claude（~/.local/bin）も、
/// claude が呼ぶ git や bun も見つからない。ターミナルで開いたときと同じ PATH をログインシェルに聞き、取れた値だけを覚える（#175）。
/// 取れなかったときは None で、claude はアプリの PATH で動く。次に端末を立てるときにもう一度聞く
pub(crate) fn login_path() -> Option<String> {
    LOGIN.get(&login_shell(), LOGIN_WAIT, LOGIN_LIMIT)
}

/// 起動のときの立て直しの前に、ログインシェルの返事を LOGIN_LIMIT まで待つ。取れたら true。
/// 立て直しは端末を1つずつ立て、聞いている最中の2つ目からは待たないので、ここで待たないと、
/// .zshrc が5秒を超える Mac では立て直した端末が全部アプリの PATH になる（#175）。立て直しは別のスレッドなので、画面は止まらない
pub fn wait_login_path() -> bool {
    LOGIN.get(&login_shell(), LOGIN_LIMIT, LOGIN_LIMIT).is_some()
}

static LOGIN: LoginPath = LoginPath::new();

fn login_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into())
}

/// 端末を立てる側が、ログインシェルの返事を待つ上限。過ぎたらアプリの PATH で立てる
const LOGIN_WAIT: Duration = Duration::from_secs(5);
/// ログインシェルを待つ上限。LOGIN_WAIT を過ぎても裏で待ち続け、返ってきたら覚える（.zshrc が重い Mac でも、後の端末は正しい PATH になる）。
/// これを過ぎたら固まったとみて止め、次に端末を立てるときに聞き直す
const LOGIN_LIMIT: Duration = Duration::from_secs(30);

/// ログインシェルの PATH を聞く窓口。取れた値だけを覚え、失敗は覚えない。
/// 聞いている間はシェルを2つ起こさない。聞き始めから wait を過ぎた後に来た呼び出しは、待たずに None を返す
/// （起動のときの立て直しは端末を1つずつ立てるので、1つごとに wait を待つと、N 個で N 倍遅くなる）
struct LoginPath {
    st: Mutex<Ask>,
    cv: std::sync::Condvar,
}

enum Ask {
    Idle,
    Asking(Instant),
    Got(String),
}

impl LoginPath {
    const fn new() -> Self {
        LoginPath { st: Mutex::new(Ask::Idle), cv: std::sync::Condvar::new() }
    }

    fn get(&'static self, shell: &str, wait: Duration, limit: Duration) -> Option<String> {
        let mut g = self.st.lock().unwrap_or_else(|e| e.into_inner());
        if let Ask::Idle = *g {
            *g = Ask::Asking(Instant::now());
            let shell = shell.to_string();
            std::thread::spawn(move || {
                let r = ask_login_path(&shell, limit);
                let mut g = self.st.lock().unwrap_or_else(|e| e.into_inner());
                *g = match r {
                    Some(p) => Ask::Got(p),
                    None => Ask::Idle,
                };
                self.cv.notify_all();
            });
        }
        loop {
            match &*g {
                Ask::Got(p) => return Some(p.clone()),
                // この呼び出しの間に聞いたのが失敗に終わった。聞き直すのは次の呼び出し
                Ask::Idle => return None,
                Ask::Asking(t0) => {
                    let left = (*t0 + wait).saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return None;
                    }
                    g = self.cv.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner()).0;
                }
            }
        }
    }
}

/// ログインシェルに PATH を1回聞く。対話の設定（.zshrc）で PATH を足す人が多いので -i も付ける。
/// 出力の前後に設定が何か書いても拾えるよう、印で挟む。limit を過ぎたらシェルを止めて None
fn ask_login_path(shell: &str, limit: Duration) -> Option<String> {
    let mut child = std::process::Command::new(shell)
        .args(["-l", "-i", "-c", "printf '\\n__FC_PATH__%s__FC_PATH__\\n' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .inspect_err(|e| eprintln!("[pty] ログインシェル {shell} を起動できなかった: {e}"))
        .ok()?;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("[pty] ログインシェルが{}秒で PATH を返さなかった。次に端末を立てるときに聞き直す", limit.as_secs());
                return None;
            }
        }
    }
    let mut s = String::new();
    child.stdout.take()?.read_to_string(&mut s).ok()?;
    let p = s.split("__FC_PATH__").nth(1)?.to_string();
    if p.is_empty() {
        eprintln!("[pty] ログインシェルの出力に PATH が無かった。次に端末を立てるときに聞き直す");
        return None;
    }
    Some(p)
}

/// claude の実行ファイル。FC_CLAUDE_BIN があればそれ（試験用）、無ければログインシェルの PATH、~/.local/bin の順に探す
fn claude_bin(path: Option<&str>) -> Result<PathBuf, String> {
    if let Ok(b) = std::env::var("FC_CLAUDE_BIN")
        && !b.is_empty() {
            return Ok(PathBuf::from(b));
        }
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let dirs = path.unwrap_or("").split(':').filter(|d| !d.is_empty()).map(PathBuf::from).chain([home.join(".local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    for d in dirs {
        let c = d.join("claude");
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("claude が見つからない（ログインシェルの PATH と ~/.local/bin を探した）".into())
}

/// 子に渡さない環境変数か。アプリを Claude Code の中から起動したとき（開発版）に、親のセッションの id や
/// 連絡の口が子に入ると、子が親と同じセッションを名乗る（docs/research/agent-teams-observed.md の tmux の回で起きた）
fn drop_env(k: &str) -> bool {
    k == "CLAUDECODE" || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" || k.starts_with("CLAUDE_CODE_") || k.starts_with("CLAUDE_PLUGIN_")
}

// ---------- 台帳（アプリを立ち上げ直したときに戻す、#152） ----------

/// 台帳の1件。形は ~/.family-computing[/dev]/terminals.json の terminals の要素
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub cwd: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub started_at: u64,
}
fn default_cols() -> u16 { 120 }
fn default_rows() -> u16 { 40 }

/// 台帳の置き場所と、まだ立て直していない分（起動の後、立て直しが済むまで）。置き場所が無ければ書かない（試験）
struct Ledger {
    path: PathBuf,
    pending: Vec<Entry>,
}
static LEDGER: Mutex<Option<Ledger>> = Mutex::new(None);
/// アプリを終えている途中か。立っていれば台帳に書かない（終えるときに止めた分を、台帳から外さない）
static SHUTTING: AtomicBool = AtomicBool::new(false);
/// 台帳を書く順番の錠。中身を集めるところから書き終えるまで持つ（古い中身が後から書かれない）
static WRITE: Mutex<()> = Mutex::new(());

/// 台帳を読む。無ければ空。読めない（壊れている）ときは .bad に写して残し、空として扱う
pub fn read_ledger(path: &std::path::Path) -> Vec<Entry> {
    let Ok(t) = std::fs::read_to_string(path) else { return vec![] };
    match serde_json::from_str::<Value>(&t).ok().and_then(|v| serde_json::from_value::<Vec<Entry>>(v["terminals"].clone()).ok()) {
        Some(v) => v,
        None => {
            let bad = path.with_extension("json.bad");
            let _ = std::fs::copy(path, &bad);
            eprintln!("[pty] 台帳が読めなかったので {} に写して、空から始める", bad.display());
            vec![]
        }
    }
}

/// 台帳の置き場所を決め、前回の分を読んで「まだ立て直していない分」にする。返すのは前回の分。
/// 立て直すか飛ばすかを決めたら、1件ずつ settle で外す（外すまでは、台帳を書き直しても残る）
pub fn open_ledger(path: PathBuf) -> Vec<Entry> {
    let prev = read_ledger(&path);
    *LEDGER.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ledger { path, pending: prev.clone() });
    prev
}

/// まだ立て直していない分から id を外し、台帳を書き直す（立て直せた、または戻さないと決めた）
pub fn settle(id: &str) {
    if let Some(l) = LEDGER.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        l.pending.retain(|e| e.id != id);
    }
    persist();
}

/// 今の台帳（生きている端末と、まだ立て直していない分）を書く。アプリを終えている途中は書かない。
/// 中身は台帳の錠（PROCS）の中で写し、ファイルには錠の外で書く。tmp に書いて rename する
fn persist() {
    let _w = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if SHUTTING.load(Ordering::SeqCst) {
        return;
    }
    let Some((path, pending)) = LEDGER.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|l| (l.path.clone(), l.pending.clone())) else { return };
    let mut list: Vec<Entry> = with(|m| {
        m.values().map(|p| Entry { id: p.cur.clone(), cwd: p.cwd.clone(), name: p.name.clone(), cols: p.size.0, rows: p.size.1, started_at: p.started_at }).collect()
    });
    list.sort_by_key(|e| e.started_at);
    for e in pending {
        if !list.iter().any(|x| x.id == e.id) {
            list.push(e);
        }
    }
    let body = serde_json::to_string_pretty(&json!({ "version": 1, "terminals": list })).unwrap_or_default();
    let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)) {
        eprintln!("[pty] 台帳を書けなかった {}: {e}", path.display());
    }
}

/// アプリを終えるので、これより後は台帳に書かない
fn begin_shutdown() {
    let _w = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    SHUTTING.store(true, Ordering::SeqCst);
}

// ---------- 起動 ----------

/// claude を PTY で起動し、セッションの id を返す。cwd はディレクトリでなければ断る
/// start は、新しく立てるときだけ足す引数（設定の既定のモデルと権限モード、start_args）
pub fn spawn(cwd: &str, name: Option<&str>, start: &[String], cols: u16, rows: u16, notice: impl Fn() + Send + 'static) -> Result<Value, String> {
    launch(cwd, None, name, start, cols, rows, notice)
}

/// claude の --effort が受ける値（2.1.330 の --help と /effort のピッカーの並び。低い順）
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// 新しい世帯を立てるときのモデル、権限モード、effort（設定の既定、src/session/defaults.ts）を、claude の --model、--permission-mode、--effort にする。
/// 空の値は渡さない（この Mac の Claude Code の既定になる）。空白を含む値や、知らない権限モードと effort は断る（引数を1つずつ渡すので混ざりはしないが、打ち間違いを起動の前に止める）
pub fn start_args(model: Option<&str>, mode: Option<&str>, effort: Option<&str>) -> Result<Vec<String>, String> {
    const MODES: [&str; 6] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
    let mut a = vec![];
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        if m.chars().any(char::is_whitespace) || m.starts_with('-') {
            return Err(format!("モデルの名前が読めない: {m}"));
        }
        a.extend(["--model".to_string(), m.to_string()]);
    }
    if let Some(p) = mode.map(str::trim).filter(|p| !p.is_empty()) {
        if !MODES.contains(&p) {
            return Err(format!("知らない権限モード: {p}"));
        }
        a.extend(["--permission-mode".to_string(), p.to_string()]);
    }
    if let Some(e) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        if !EFFORTS.contains(&e) {
            return Err(format!("知らない effort: {e}"));
        }
        a.extend(["--effort".to_string(), e.to_string()]);
    }
    Ok(a)
}

/// 前の会話 id を `claude --resume <id>` で立て直す。id は変わらない（2.1.330 の --help: 新しい id にするのは --fork-session のとき）。
/// 会話の jsonl があるか、よそで同じ id が動いていないかは、呼ぶ側が先に確かめる（session_ops.rs）
pub fn resume(id: &str, cwd: &str, name: Option<&str>, cols: u16, rows: u16, notice: impl Fn() + Send + 'static) -> Result<Value, String> {
    if pid_of_id(id).is_some() {
        return Err(format!("このセッションはもう Claude Town で開いている: {id}"));
    }
    // resume では設定の既定を足さない。前の会話のモデルと権限モードのまま立て直す
    launch(cwd, Some(id), name, &[], cols, rows, notice)
}

/// claude の引数。resume なら `--resume <id>`、新しく立てるなら `--session-id <id>` と、名前があれば `--name`。
/// resume のときは名前を渡さない（後から /rename した名前を、起動のときの名前で上書きしない。名前は会話の記録から戻る）
fn launch_args(id: &str, resume: bool, name: Option<&str>) -> Vec<String> {
    let mut a = vec![if resume { "--resume" } else { "--session-id" }.to_string(), id.to_string()];
    if let Some(n) = name.filter(|n| !resume && !n.trim().is_empty()) {
        a.extend(["--name".to_string(), n.to_string()]);
    }
    a
}

fn launch(cwd: &str, resume: Option<&str>, name: Option<&str>, start: &[String], cols: u16, rows: u16, notice: impl Fn() + Send + 'static) -> Result<Value, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("場所が無いか、ディレクトリではない: {cwd}"));
    }
    let path = login_path();
    let bin = claude_bin(path.as_deref())?;
    // どのアカウントで起動するか（cam usage の best。account.rs）。resume も同じ選び方にする（会話の記録 projects と sessions は、cam が全プロファイルで ~/.claude のものを共有している）。
    // 全部のアカウントが上限のとき起動をやめるのは、新しく立てるときだけ（resume を断ると、アプリを開いたときの立て直しで端末が黙って戻らない）
    let prepared = crate::account::prepare(path.as_deref(), resume.is_none())?;
    let config_dir = prepared.dir;
    let id = resume.map(String::from).unwrap_or_else(new_uuid);
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| format!("端末を開けなかった: {e}"))?;
    let mut cmd = CommandBuilder::new(&bin);
    cmd.args(launch_args(&id, resume.is_some(), name));
    cmd.args(start);
    let name = name.filter(|n| !n.trim().is_empty()).map(String::from);
    cmd.cwd(cwd);
    for (k, _) in std::env::vars() {
        if drop_env(&k) {
            cmd.env_remove(&k);
        }
    }
    if let Some(p) = &path {
        cmd.env("PATH", p);
    }
    // 選べたときだけ差し替える。アプリの環境に別の値があっても（cam の launcher から開いた開発版）、選んだプロファイルにする。
    // cam が --default のコマンドを選んだら外して ~/.claude で起動する（#251）。選べないときは触らない
    match &config_dir {
        crate::account::ConfigDir::Set(d) => { cmd.env("CLAUDE_CONFIG_DIR", d); }
        crate::account::ConfigDir::Unset => { cmd.env_remove("CLAUDE_CONFIG_DIR"); }
        crate::account::ConfigDir::Keep => {}
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var("LANG").map(|l| l.is_empty()).unwrap_or(true) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("claude を起動できなかった: {e}"))?;
    drop(pair.slave);
    let pid = child.process_id().ok_or("claude の pid が取れなかった")?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = timed(pid, pair.master.take_writer().map_err(|e| e.to_string())?);
    let killer = child.clone_killer();
    let started_at = crate::now_ms() as u64;
    with(|m| {
        m.insert(pid, Proc { pid, ids: vec![id.clone()], cur: id.clone(), name, cwd: cwd.to_string(), started_at, size: (cols, rows), master: pair.master, writer: Arc::new(Mutex::new(writer)), serial: Arc::new(Mutex::new(())), killer, out: vec![], screen: new_screen(cols, rows), sub: None, carry: vec![] });
    });
    eprintln!("[pty] claude を{}した pid {pid} id {id} cwd {cwd}", if resume.is_some() { "resume で起動" } else { "起動" });
    persist();
    std::thread::spawn(move || read_loop(pid, reader));
    std::thread::spawn(move || {
        let st = child.wait();
        let code = st.as_ref().ok().map(|s| s.exit_code());
        eprintln!("[pty] claude が終わった pid {pid} {st:?}");
        // 読み手が最後の出力を送り終えるのを少し待ってから、台帳から外す
        std::thread::sleep(Duration::from_millis(200));
        let gone = with(|m| m.remove(&pid));
        if let Some(p) = &gone {
            end_input(pid, &p.writer);
        }
        if let Some(p) = gone
            && let Some((_, tx)) = &p.sub {
                let _ = tx.send(TermOut::Event("exit".into(), json!({ "reason": "終わった", "code": code })));
            }
        // 閉じた、または claude が自分で終わったので、次の起動で戻さない（アプリを終えている途中なら persist は書かない）
        persist();
        notice();
    });
    // pathFallback は、ログインシェルの PATH を取れず、アプリの PATH で立てた印。画面がトーストで知らせる（#175）
    // accountFallback は、cam usage が上限で返らず、アカウントを選ばずに既定のまま立てたときの一言。画面がトーストで知らせる（#249）
    Ok(json!({ "id": id, "pid": pid, "cwd": cwd, "pathFallback": path.is_none(), "accountFallback": prepared.fallback }))
}

fn read_loop(pid: u32, mut reader: Box<dyn Read + Send>) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let bytes = &buf[..n];
        let alive = with(|m| {
            let Some(p) = m.get_mut(&pid) else { return false };
            p.out.extend_from_slice(bytes);
            p.screen.process(bytes);
            if p.out.len() > KEEP_BYTES {
                let cut = p.out.len() - KEEP_BYTES;
                p.out.drain(..cut);
            }
            if let Some((_, tx)) = &p.sub {
                let s = utf8_stream(&mut p.carry, bytes);
                if tx.send(TermOut::Text(s)).is_err() {
                    p.sub = None;
                }
            }
            true
        });
        if !alive {
            return;
        }
    }
}

/// 続きのあるバイト列を UTF-8 の文字列に直す。末尾で途中まで来た文字は carry に残し、次の分の頭に付ける。壊れたバイトは U+FFFD にする
pub fn utf8_stream(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
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

/// replay に使う、持っている出力。先頭が文字の途中（切り詰めた後）なら、次の文字の頭まで飛ばす
fn replay_text(out: &[u8]) -> String {
    let start = out.iter().position(|b| (b & 0xC0) != 0x80).unwrap_or(out.len());
    String::from_utf8_lossy(&out[start..]).into_owned()
}

// ---------- 書き込みの詰まり（#240 の 2） ----------

/// 書き口の包み。今の write（または flush）が戻らないまま何ミリ秒たったかを、書き口の錠の外から読めるようにする。
/// 詰まった書き手は書き口の錠を持ったまま戻らないので、錠の中に置くと読めない。write_all は write を何度も呼ぶので、少しずつでも書けていれば時刻は毎回新しくなる
struct Timed {
    inner: Box<dyn Write + Send>,
    /// 今の write を始めた時刻（STALL_BASE からのミリ秒に1を足した値）。書いていなければ 0
    since: Arc<std::sync::atomic::AtomicU64>,
}

// OnceLock は完全な名前で書く。#202（#175）が login_path の OnceLock を外すと、use から OnceLock が消えるため
static STALL_BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn stall_clock() -> u64 {
    STALL_BASE.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

impl Timed {
    fn timing<T>(&mut self, f: impl FnOnce(&mut Box<dyn Write + Send>) -> std::io::Result<T>) -> std::io::Result<T> {
        self.since.store(stall_clock(), Ordering::SeqCst);
        let r = f(&mut self.inner);
        self.since.store(0, Ordering::SeqCst);
        r
    }
}

impl Write for Timed {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.timing(|w| w.write(buf))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.timing(|w| w.flush())
    }
}

/// 端末ごとの「今の write を始めた時刻」。キーは pid。Proc には持たせない（Proc の欄は #168 の serial が触る）。
/// 値は Weak で持つので、端末が台帳から外れて書き口が落ちれば読めなくなる。死んだ分は次に登録するときに捨てる
static STALLS: Mutex<Option<HashMap<u32, std::sync::Weak<std::sync::atomic::AtomicU64>>>> = Mutex::new(None);

fn timed(pid: u32, inner: Box<dyn Write + Send>) -> Box<dyn Write + Send> {
    let since = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut g = STALLS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    map.retain(|_, w| w.strong_count() > 0);
    map.insert(pid, Arc::downgrade(&since));
    Box::new(Timed { inner, since })
}

/// この端末への書き込みが、戻らないままどれだけたったか。書いていなければ None
pub fn stalled_for(id: &str) -> Option<Duration> {
    let pid = pid_of_id(id)?;
    let since = STALLS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(&pid)?.upgrade()?.load(Ordering::SeqCst);
    (since != 0).then(|| Duration::from_millis(stall_clock().saturating_sub(since)))
}

/// 詰まった書き込みの後ろで、並んだまま待つ上限。少しずつ書けている（詰まってはいない）長い書き込みの後ろでも、これより長くは待たない
const QUEUE_LIMIT: Duration = Duration::from_secs(10);

/// 書く。ただし、この端末の書き込みが stuck_after 以上戻っていなければ、後ろに並ばずに Ok(Some(戻っていない時間)) を返す。
/// 並んで待つ間に、前の書き込みが stuck_after を超えたときも同じにする。そのときは並んでいた分を書かない（claude が読み始めたときに、遅れて届かないようにする）。
/// 書けたら Ok(None)。止めるボタンの Esc（composer.rs の interrupt_session）が使う
pub fn write_unless_stuck(id: &str, text: &str, stuck_after: Duration) -> Result<Option<Duration>, String> {
    let w = with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.writer.clone())).ok_or("このセッションの端末はこのアプリに無い")?;
    if let Some(d) = stalled_for(id).filter(|d| *d >= stuck_after) {
        return Ok(Some(d));
    }
    let give_up = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let (give_up, text) = (give_up.clone(), text.to_string());
        std::thread::spawn(move || {
            let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
            if give_up.load(Ordering::SeqCst) {
                return;
            }
            let _ = tx.send(w.write_all(text.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("ターミナルに書けなかった: {e}")));
        });
    }
    let t0 = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(r) => return r.map(|_| None),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("ターミナルの書き手が止まった".into()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        let stuck = stalled_for(id).filter(|d| *d >= stuck_after);
        if stuck.is_some() || !owns(id) || t0.elapsed() >= QUEUE_LIMIT {
            give_up.store(true, Ordering::SeqCst);
            return match stuck {
                Some(d) => Ok(Some(d)),
                None if !owns(id) => Err("このセッションの端末は終わった".into()),
                None => Err(format!("前の書き込みが続いていて、{}秒待っても書けなかった", QUEUE_LIMIT.as_secs())),
            };
        }
    }
}

// ---------- 画面からの操作 ----------

/// 端末を開いた画面を登録し、size と replay を送る。前に開いていた画面は外す
pub fn subscribe(id: &str, generation: u64, tx: Sender<TermOut>) -> Result<(), String> {
    with(|m| {
        let pid = pid_of(m, id).ok_or("このセッションの端末はこのアプリに無い（アプリの外で起動したセッション）")?;
        let p = m.get_mut(&pid).expect("上で見つけた");
        let _ = tx.send(TermOut::Event("size".into(), json!({ "cols": p.size.0, "rows": p.size.1 })));
        let _ = tx.send(TermOut::Event("replay".into(), json!({ "s": replay_text(&p.out) })));
        p.carry.clear();
        p.sub = Some((generation, tx));
        Ok(())
    })
}

/// 開いた画面を外す。generation を渡したら、その世代のときだけ外す
pub fn unsubscribe(id: &str, generation: Option<u64>) {
    with(|m| {
        if let Some(p) = pid_of(m, id).and_then(|pid| m.get_mut(&pid))
            && (generation.is_none() || p.sub.as_ref().map(|s| s.0) == generation) {
                p.sub = None;
            }
    });
}

fn new_screen(cols: u16, rows: u16) -> vt100::Parser {
    let nz = |v: u16, d: u16| std::num::NonZeroU16::new(v).unwrap_or(std::num::NonZeroU16::new(d).expect("0 ではない"));
    vt100::Parser::new(nz(rows, 24), nz(cols, 80), 0)
}

/// 今の画面の文字（行ごとに改行で区切る）。台帳に無ければ None
pub fn screen_text(id: &str) -> Option<String> {
    with(|m| {
        let p = m.get(&pid_of(m, id)?)?;
        let sc = p.screen.screen();
        let cols = sc.size().1.get();
        Some(sc.rows(0, cols).collect::<Vec<_>>().join("\n"))
    })
}

pub fn write(id: &str, text: &str) -> Result<(), String> {
    let w = with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.writer.clone())).ok_or("このセッションの端末はこのアプリに無い")?;
    let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
    w.write_all(text.as_bytes()).and_then(|_| w.flush()).map_err(|e| format!("ターミナルに書けなかった: {e}"))
}

/// 端末へ何回かに分けて書く操作（貼り付けと Enter、モデルと権限モードの切り替え、承認への答え）を、端末ごとに1つずつ通す（#168）。
/// 錠を持たないと、貼り付けと Enter の間にモデルのピッカーのキーが入り、ピッカーの中で Enter が押される。
/// 錠は台帳の1件（pid）に持たせるので、/clear などで session id が変わっても同じ錠になる。台帳の錠（PROCS）は、錠を取り出す間だけ持つ。
/// f の中で serial をもう一度呼ばない（同じ錠を待って止まる）
pub fn serial<T>(id: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.serial.clone())).ok_or("このセッションの端末はこのアプリに無い")?;
    let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// このアプリが立てたセッションの pid
pub fn pid_of_id(id: &str) -> Option<u32> {
    with(|m| pid_of(m, id))
}

/// このアプリが立てたセッションの端末の大きさ（cols, rows）。立て直すときに同じ大きさで起動する
pub fn size_of(id: &str) -> Option<(u16, u16)> {
    with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.size))
}

/// 同じ端末が名乗ったことのある session id の全部（/clear や計画の承認で id が変わっても、pid は同じ）。台帳に無ければ id だけ
pub fn ids_of(id: &str) -> Vec<String> {
    with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| p.ids.clone())).unwrap_or_else(|| vec![id.to_string()])
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=1000).contains(&cols) || !(2..=1000).contains(&rows) {
        return Err(format!("大きさが範囲の外: {cols}x{rows}"));
    }
    with(|m| {
        let pid = pid_of(m, id).ok_or("このセッションの端末はこのアプリに無い")?;
        let p = m.get_mut(&pid).expect("上で見つけた");
        if p.size == (cols, rows) {
            return Ok(());
        }
        p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("ターミナルの大きさを変えられなかった: {e}"))?;
        p.size = (cols, rows);
        if let (Some(r), Some(c)) = (std::num::NonZeroU16::new(rows), std::num::NonZeroU16::new(cols)) {
            p.screen.set_size(r, c);
        }
        Ok(())
    })
}

// ---------- 打鍵の列（#231） ----------

/// 端末ごとの打鍵の列（送り口）と、その端末の書き口。キーは pid。書き口は Weak で持ち、端末が台帳から外れたら今までどおり Proc と一緒に落ちる
struct Input {
    writer: std::sync::Weak<Mutex<Box<dyn Write + Send>>>,
    tx: Sender<String>,
}
static INPUTS: Mutex<Option<HashMap<u32, Input>>> = Mutex::new(None);

/// 打ったキー（ターミナルの欄の打鍵と貼り付け）を端末の列に積み、書くのを待たずに返す（#231）。
/// 呼び手は Tauri のメインスレッドなので、claude が入力を読まずに PTY が詰まっても、チャット欄の送信が書き口の錠を持っていても、待つと窓全体が固まる。
/// 書くのは端末ごとに1本の書き手のスレッドで、積んだ順に1件ずつ書くので、打った順は変わらない。
/// 書き手が取るのは書き口の錠（writer）だけ。分けて書く操作の錠（#168 の serial）は取らない。書けなかったときは、開いている画面に input_error を送る
pub fn input(id: &str, text: &str) -> Result<(), String> {
    let (pid, writer) = with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| (p.pid, Arc::downgrade(&p.writer)))).ok_or("このセッションの端末はこのアプリに無い")?;
    let mut g = INPUTS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    // 同じ pid でも書き口が違えば別の端末（pid が使い回された）なので、列を作り直す
    if !map.get(&pid).is_some_and(|q| q.writer.ptr_eq(&writer)) {
        let (tx, rx) = std::sync::mpsc::channel();
        let w = writer.clone();
        std::thread::spawn(move || input_loop(pid, w, rx));
        map.insert(pid, Input { writer, tx });
    }
    map[&pid].tx.send(text.to_string()).map_err(|_| "ターミナルの書き手が止まっている".to_string())
}

/// 書き手のスレッド。列が閉じる（end_input）か、端末が台帳から外れたら終わる
fn input_loop(pid: u32, writer: std::sync::Weak<Mutex<Box<dyn Write + Send>>>, rx: std::sync::mpsc::Receiver<String>) {
    while let Ok(text) = rx.recv() {
        let Some(w) = writer.upgrade() else { return };
        let r = {
            let mut g = w.lock().unwrap_or_else(|e| e.into_inner());
            g.write_all(text.as_bytes()).and_then(|_| g.flush())
        };
        let Err(e) = r else { continue };
        // 続けて積まれていた分は捨てる。前の打鍵が届かないまま、後の打鍵だけを書かない
        let dropped = rx.try_iter().count();
        let message = if dropped > 0 { format!("ターミナルに書けなかった: {e}（続けて打った {dropped} 件も送らなかった）") } else { format!("ターミナルに書けなかった: {e}") };
        eprintln!("[pty] {message} pid {pid}");
        with(|m| {
            if let Some(p) = m.get(&pid)
                && Arc::ptr_eq(&p.writer, &w)
                && let Some((_, tx)) = &p.sub {
                    let _ = tx.send(TermOut::Event("input_error".into(), json!({ "message": message })));
                }
        });
    }
}

/// 端末が台帳から外れたので、その端末の列を閉じる。書き手のスレッドは書き口を取り出せずに終わる
fn end_input(pid: u32, writer: &Arc<Mutex<Box<dyn Write + Send>>>) {
    let mut g = INPUTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut()
        && map.get(&pid).is_some_and(|q| q.writer.ptr_eq(&Arc::downgrade(writer))) {
            map.remove(&pid);
        }
}

/// 1つ止める。SIGHUP を送る（portable-pty の clone_killer の kill は SIGHUP だけを送る。0.9.0 のソースで確かめた）。
/// 2秒たっても終わっていなければ、別のスレッドから SIGKILL を送る。待つ間は錠を持たない
pub fn kill(id: &str) -> Result<(), String> {
    let (pid, mut k) = with(|m| pid_of(m, id).and_then(|pid| m.get(&pid)).map(|p| (p.pid, p.killer.clone_killer()))).ok_or("このセッションはこのアプリが立てたものではないので止められない")?;
    k.kill().map_err(|e| format!("止められなかった: {e}"))?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        // まだ台帳にある（終わりを待つスレッドが外していない）ときだけ送る。外した後の pid は別のプロセスに使い回されうる
        if with(|m| m.contains_key(&pid)) {
            eprintln!("[pty] SIGHUP で終わらなかったので SIGKILL を送る pid {pid}");
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    });
    Ok(())
}

/// アプリを終えるとき、SIGHUP の後に claude が自分で終わるのを待つ長さ。これを過ぎて残っているものに SIGKILL を送る。
/// claude は SIGHUP から終わるまで 1.27 秒かかった（2026-11-22 の実測、README）。前の1秒では足りず、SIGKILL で
/// SessionEnd の hook と sessions/<pid>.json の片付けが飛んだ（#232）。全部が終われば、この長さを待たずに戻る
const SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

/// アプリを終えるときに、ここから立てた claude を全部止める。SIGHUP を全部に送り、SHUTDOWN_WAIT まで待って残りに SIGKILL
pub fn kill_all() {
    // 台帳はアプリを終える前のまま残す（次の起動で戻す）
    begin_shutdown();
    let pids: Vec<u32> = with(|m| m.keys().copied().collect());
    if pids.is_empty() {
        return;
    }
    hangup_all(&pids);
    eprintln!("[pty] アプリを終えるので {} 体の claude を止めた", pids.len());
}

/// kill_all の止め方。pids に SIGHUP を送り、全部が終わるか SHUTDOWN_WAIT が過ぎるまで待ち、残りに SIGKILL を送る。
/// 試験が代役の pid だけを渡して同じ処理を流せるように、台帳と SHUTTING には触らない
fn hangup_all(pids: &[u32]) {
    for &pid in pids {
        unsafe { libc::kill(pid as i32, libc::SIGHUP) };
    }
    let t0 = Instant::now();
    while t0.elapsed() < SHUTDOWN_WAIT && pids.iter().any(|&p| alive(p)) {
        std::thread::sleep(Duration::from_millis(50));
    }
    for &pid in pids.iter().filter(|&&p| alive(p)) {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
}

fn alive(pid: u32) -> bool {
    let r = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
    if r == pid as i32 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// FC_CLAUDE_BIN を書き換えて代役を立てる試験の錠（環境変数はプロセスで1つなので、立てる間だけ持つ）
#[cfg(test)]
pub(crate) static BIN_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_is_v4() {
        let u = new_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(u, new_uuid());
    }

    /// 親がアプリの端末で、/clear や計画の承認で id が変わっても、前の id を指す from 行の子は親から外れない（#248）。
    /// from 行の sid8 は ccn の形（agent:<ノード>/<16進8文字>/<役割>）のときだけ読む。sid8 が無い形は親を引かない
    #[test]
    fn a_child_keeps_its_parent_after_the_parent_id_changes() {
        use crate::native::testtree::*;
        use std::os::unix::fs::PermissionsExt;
        let _serial = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-pty-parent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\nexec cat\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {}).unwrap();
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        // 親 A: 起動のときの id は a_old。/clear の後、sessions/<pid>.json には a_new が出ている
        let a_old = r["id"].as_str().unwrap().to_string();
        let pa = r["pid"].as_u64().unwrap();
        let a_new = "a2a2a2a2-0000-4000-8000-0000000000a2";
        // 子 B は A の前の id を from 行に持つ。C と D は sid8 の無い from 行（ccn の agent:<ノード>/<役割> と、空の sid8）
        let b = "b2b2b2b2-0000-4000-8000-0000000000b2";
        let c = "c2c2c2c2-0000-4000-8000-0000000000c2";
        let d = "d2d2d2d2-0000-4000-8000-0000000000d2";
        let root = tmp("parent-id-change");
        let sess = |pid: u64, sid: &str, cwd: &str| {
            write(&root.join(format!("sessions/{pid}.json")), &json!({ "pid": pid, "sessionId": sid, "cwd": cwd, "startedAt": 5,
                "kind": "interactive", "status": "idle" }).to_string());
        };
        let from = |sid: &str, cwd: &str, caller: &str| {
            write(&root.join(format!("projects/{}/{sid}.jsonl", enc(cwd))), &format!("{{\"type\":\"user\",\"message\":{{\"content\":\"from {caller} via n\\n\\nやって\"}}}}\n"));
        };
        sess(pa, a_new, "/tmp/合成/a");
        // A の /clear の後の最初の文が B からの文だと、A の親は B になる。B の親を A の今の id に引き直すと輪になるので、早く始まった A を根にする
        from(a_new, "/tmp/合成/a", &format!("agent:n/{}/r", &b[..8]));
        // 生きている pid を3つ使う（launchd、この試験のプロセス、cargo）
        sess(1, b, "/tmp/合成/b");
        from(b, "/tmp/合成/b", &format!("agent:n/{}/r", &a_old[..8]));
        sess(std::process::id() as u64, c, "/tmp/合成/c");
        from(c, "/tmp/合成/c", "agent:n/a2a2/r");
        sess(std::os::unix::process::parent_id() as u64, d, "/tmp/合成/d");
        from(d, "/tmp/合成/d", "agent:n//r");
        crate::native::TEST_HOME.with(|h| *h.borrow_mut() = Some(root.clone()));
        let agents = crate::agents_from(crate::town_rows());
        crate::native::TEST_HOME.with(|h| *h.borrow_mut() = None);
        let by = |id: &str| agents.iter().find(|x| x["id"] == id).cloned().unwrap_or(Value::Null);
        kill(&a_old).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) && owns(&a_old) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!owns(&a_old), "代役の端末が台帳に残っている");
        assert_eq!(by(a_new)["source"], "app", "A は台帳で a_old と同じ端末");
        assert_eq!(by(b)["parent"], a_new, "前の id を指す from 行から、親の今の id を引けていない");
        assert_eq!(by(a_new)["parent"], Value::Null, "親子が輪になっている");
        assert_eq!(by(c)["parent"], Value::Null, "役割を sid8 として読んでいる");
        assert_eq!(by(d)["parent"], Value::Null, "空の sid8 がどの id にも当たっている");
    }

    #[test]
    fn utf8_stream_keeps_split_characters() {
        let mut carry = vec![];
        let s = "あい".as_bytes();
        assert_eq!(utf8_stream(&mut carry, &s[..4]), "あ");
        assert_eq!(utf8_stream(&mut carry, &s[4..]), "い");
        assert!(carry.is_empty());
        assert_eq!(utf8_stream(&mut carry, &[0xff, b'a']), "\u{FFFD}a");
    }

    #[test]
    fn replay_skips_a_cut_character() {
        let s = "あい".as_bytes();
        assert_eq!(replay_text(&s[1..]), "い");
        assert_eq!(replay_text(b""), "");
    }

    /// 1回目だけ first_sleep 秒黙ってから、PATH を返すシェルの台本。何回起こされたかを count に書く。
    /// 試験ごとに別の窓口（LoginPath）と台本を使い、SHELL の環境変数は変えない（ほかの試験の spawn が本物のシェルに聞くのと競合しない）
    fn slow_then_fast_shell(tag: &str, first_sleep: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fc-pty-shell-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("sh");
        let body = format!(
            "#!/bin/sh\nn=$(cat '{d}/count' 2>/dev/null || echo 0)\necho $((n+1)) > '{d}/count'\nif [ \"$n\" = 0 ]; then sleep {first_sleep}; fi\nprintf '\\n__FC_PATH__/fake/bin:/usr/bin__FC_PATH__\\n'\n",
            d = dir.display()
        );
        std::fs::write(&sh, body).unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
        (sh, dir.join("count"))
    }

    fn asked(count: &std::path::Path) -> u32 {
        std::fs::read_to_string(count).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }

    /// Some を返すまで5秒まで呼び続ける（ほかの試験と並んで、台本の起動が遅れても落ちないように）
    fn poll(f: impl Fn() -> Option<String>) -> Option<String> {
        let t0 = Instant::now();
        loop {
            let r = f();
            if r.is_some() || t0.elapsed() > Duration::from_secs(5) {
                return r;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn fresh_login() -> &'static LoginPath {
        Box::leak(Box::new(LoginPath::new()))
    }

    /// #175 の再現。ログインシェルが1回目に5秒（LOGIN_WAIT）を超えても、後の呼び出しでは PATH を取れる（失敗を覚え続けない）
    #[test]
    fn login_path_recovers_after_a_slow_shell() {
        let (sh, count) = slow_then_fast_shell("repro", "6");
        let login = fresh_login();
        let t0 = Instant::now();
        let mut got = None;
        while t0.elapsed() < Duration::from_secs(12) && got.is_none() {
            got = login.get(sh.to_str().unwrap(), LOGIN_WAIT, LOGIN_LIMIT);
            if got.is_none() { std::thread::sleep(Duration::from_millis(500)); }
        }
        assert_eq!(got.as_deref(), Some("/fake/bin:/usr/bin"));
        // 取れた値は覚え、もう聞かない
        let n = asked(&count);
        assert_eq!(login.get(sh.to_str().unwrap(), LOGIN_WAIT, LOGIN_LIMIT).as_deref(), Some("/fake/bin:/usr/bin"));
        assert_eq!(asked(&count), n);
    }

    /// 1回目が上限（limit）を超えて止められたら、次の呼び出しでもう一度聞き、2回目の速い返事を覚える
    #[test]
    fn login_path_asks_again_after_a_failure() {
        let (sh, count) = slow_then_fast_shell("retry", "5");
        let sh = sh.to_str().unwrap();
        let login = fresh_login();
        let (wait, limit) = (Duration::from_millis(200), Duration::from_millis(600));
        let t0 = Instant::now();
        assert_eq!(login.get(sh, wait, limit), None);
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
        // 聞いている最中で、聞き始めから wait を過ぎている。待たずに None を返し、2つ目のシェルを起こさない
        let t1 = Instant::now();
        assert_eq!(login.get(sh, wait, limit), None);
        assert!(t1.elapsed() < Duration::from_millis(100), "{:?}", t1.elapsed());
        // 1回目が limit で止められた後の呼び出しは、もう一度聞いて速い返事を取る。
        // 止められる前の呼び出しは None を返すだけでシェルを起こさないので、取れるまで回しても起こしたシェルは2つになる
        assert_eq!(poll(|| login.get(sh, wait, limit)).as_deref(), Some("/fake/bin:/usr/bin"));
        assert_eq!(asked(&count), 2);
        assert_eq!(login.get(sh, wait, limit).as_deref(), Some("/fake/bin:/usr/bin"));
        assert_eq!(asked(&count), 2);
    }

    /// wait を過ぎても limit の内に返ってきた PATH は、聞き直さずに覚える（.zshrc が重い Mac）
    #[test]
    fn login_path_keeps_a_late_answer() {
        let (sh, count) = slow_then_fast_shell("late", "0.6");
        let sh = sh.to_str().unwrap();
        let login = fresh_login();
        let (wait, limit) = (Duration::from_millis(100), Duration::from_secs(5));
        assert_eq!(login.get(sh, wait, limit), None);
        assert_eq!(poll(|| login.get(sh, wait, limit)).as_deref(), Some("/fake/bin:/usr/bin"));
        assert_eq!(asked(&count), 1);
    }

    #[test]
    fn child_env_drops_the_parent_session() {
        assert!(drop_env("CLAUDE_CODE_SESSION_ID"));
        assert!(drop_env("CLAUDECODE"));
        assert!(drop_env("CLAUDE_PLUGIN_DATA"));
        assert!(!drop_env("CLAUDE_CONFIG_DIR"));
        assert!(!drop_env("HOME"));
    }

    /// 書き込みが詰まっても台帳の錠を持たない（読まない子に大きく書いている間も、owns と list が返る）。
    /// 代役は claude と同じく raw にしてから寝る。行の編集のモードのままだと、macOS は行の上限を超えた分を捨て、書き込みは詰まらない（#240）
    #[test]
    fn a_stuck_write_does_not_hold_the_table() {
        use std::os::unix::fs::PermissionsExt;
        // 町の一覧を数える試験（lib.rs）にこの端末が混ざらないよう、台帳から消えるまで持つ。取る順は launched_config_dir_as と同じ
        let _serial = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-pty-stuck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        // 入力を読まない子。raw にしたら ready を書く
        std::fs::write(&bin, format!("#!/bin/sh\nstty raw -echo\n: > '{}'\nexec sleep 30\n", dir.join("ready").display())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {});
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r.unwrap()["id"].as_str().unwrap().to_string();
        let t0 = Instant::now();
        while !dir.join("ready").exists() && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = dir.join("ready").exists();
        let id2 = id.clone();
        // PTY の入力の欄（数KB）を超えて書く。子が読まないので、この書き込みは戻らない
        let (tx, rx) = std::sync::mpsc::channel();
        if ready {
            std::thread::spawn(move || { let _ = tx.send(write(&id2, &"x".repeat(1 << 20))); });
        }
        let stuck = rx.recv_timeout(Duration::from_millis(300));
        let t0 = Instant::now();
        let owned = owns(&id);
        let listed = !list().is_empty();
        let took = t0.elapsed();
        // 確かめる前に止める（落ちても代役を残さない）
        kill(&id).unwrap();
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_secs(5) && owns(&id) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready, "代役が raw にならない");
        assert!(stuck.is_err(), "書き込みが戻った（PTY が詰まっていない）: {stuck:?}");
        assert!(owned && listed);
        assert!(took < Duration::from_millis(200), "台帳の錠が書き込みに取られている: {took:?}");
    }

    /// 偽の cam と偽の claude を置いた試験用のディレクトリ。cam usage --json は usage を返し、sync は呼ばれた名前を sync.log に足す。
    /// claude は自分の環境を env.txt に書いてから寝る
    fn fake_cam_dir(tag: &str, usage: &str) -> PathBuf {
        fake_cam_dir_after(tag, usage, "0")
    }

    /// fake_cam_dir の cam usage が、delay 秒（sleep の引数）待ってから usage を返すもの
    fn fake_cam_dir_after(tag: &str, usage: &str, delay: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fc-pty-cam-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profiles/acct")).unwrap();
        std::fs::write(dir.join("usage.json"), usage).unwrap();
        let cam = format!(
            "#!/bin/sh\ncase \"$1\" in\n  usage) sleep {delay}; cat '{d}/usage.json' ;;\n  sync) echo \"$2\" >> '{d}/sync.log' ;;\nesac\n",
            d = dir.display()
        );
        let claude = format!("#!/bin/sh\nenv > '{d}/env.txt.tmp' && mv '{d}/env.txt.tmp' '{d}/env.txt'\nexec sleep 30\n", d = dir.display());
        for (n, body) in [("cam", cam), ("claude", claude)] {
            std::fs::write(dir.join(n), body).unwrap();
            std::fs::set_permissions(dir.join(n), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    /// 偽の cam と claude で起動し、claude の環境の CLAUDE_CONFIG_DIR を返す（無ければ None）。
    /// アプリの環境に別の CLAUDE_CONFIG_DIR があっても（cam の launcher から開いた開発版）、選んだ値で上書きされることも見る
    fn launched_config_dir(dir: &std::path::Path) -> Result<Option<String>, String> {
        launched_config_dir_as(dir, None)
    }

    /// resume が Some なら、その id で resume として起動する
    fn launched_config_dir_as(dir: &std::path::Path, resume_id: Option<&str>) -> Result<Option<String>, String> {
        launched(dir, resume_id).map(|(c, _)| c)
    }

    /// launched_config_dir_as の中身。起動の応答も返す
    fn launched(dir: &std::path::Path, resume_id: Option<&str>) -> Result<(Option<String>, Value), String> {
        // 町の一覧を数える試験（lib.rs）に、この端末が混ざらないようにする。錠は端末が台帳から消えるまで持つ。
        // 取る順は lib.rs と composer.rs と同じ NATIVE_TEST_LOCK、BIN_LOCK（逆に取ると互いに待って止まる）
        let _serial = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("CLAUDE_CONFIG_DIR").ok();
        unsafe {
            std::env::set_var("FC_CLAUDE_BIN", dir.join("claude"));
            std::env::set_var("FC_CAM_BIN", dir.join("cam"));
            std::env::set_var("FC_CAM_PROFILES", dir.join("profiles"));
            std::env::set_var("CLAUDE_CONFIG_DIR", "/nowhere/inherited");
        }
        let r = match resume_id {
            Some(rid) => resume(rid, dir.to_str().unwrap(), None, 80, 24, || {}),
            None => spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {}),
        };
        unsafe {
            std::env::remove_var("FC_CLAUDE_BIN");
            std::env::remove_var("FC_CAM_BIN");
            std::env::remove_var("FC_CAM_PROFILES");
            match &prev { Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v), None => std::env::remove_var("CLAUDE_CONFIG_DIR") }
        }
        let r = r?;
        let id = r["id"].as_str().unwrap().to_string();
        let t0 = Instant::now();
        let env = loop {
            if let Ok(s) = std::fs::read_to_string(dir.join("env.txt")) { break s; }
            assert!(t0.elapsed() < Duration::from_secs(5), "偽の claude が env.txt を書かなかった");
            std::thread::sleep(Duration::from_millis(20));
        };
        kill(&id).unwrap();
        while owns(&id) {
            assert!(t0.elapsed() < Duration::from_secs(10), "止めた端末が台帳から消えない");
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok((env.lines().find_map(|l| l.strip_prefix("CLAUDE_CONFIG_DIR=")).map(String::from), r))
    }

    /// cam usage の best のプロファイルで起動する。パスは launcher（~/.cam/bin/<名前>）と同じ <profiles>/<名前> の文字列のまま。
    /// 直す前は CLAUDE_CONFIG_DIR を付けず、アプリの環境の値のまま起動していた（5時間枠を使い切った ~/.claude のアカウントで立った）
    #[test]
    fn launch_uses_the_cam_best_profile() {
        let dir = fake_cam_dir("best", r#"{"best":"acct","choice":"normal","next_available":null,"accounts":[]}"#);
        let want = format!("{}/acct", dir.join("profiles").display());
        assert_eq!(launched_config_dir(&dir).unwrap().as_deref(), Some(want.as_str()));
        assert_eq!(std::fs::read_to_string(dir.join("sync.log")).unwrap_or_default(), "acct\n", "起動の前に cam sync <名前> を掛ける");
    }

    /// #249。本物の cam は各アカウントの使用量を curl -m 5 で取り、取れなければ控え（usage-cache）の値で選ぶ。
    /// curl の上限を過ぎてから best を返す cam（5.3秒）でも、待って best のプロファイルで起動する
    #[test]
    fn launch_waits_for_a_cam_that_answers_after_its_curl_limit() {
        let dir = fake_cam_dir_after("late", r#"{"best":"acct","choice":"normal","next_available":null,"accounts":[]}"#, "5.3");
        let want = format!("{}/acct", dir.join("profiles").display());
        let (got, r) = launched(&dir, None).unwrap();
        assert_eq!(got.as_deref(), Some(want.as_str()));
        assert_eq!(r["accountFallback"], Value::Null, "選べたときは知らせない");
    }

    /// #249。cam usage が上限（8秒）を過ぎても返らなければ、env を触らずに起動し、応答に知らせる一言を付ける（画面がトーストで出す）
    #[test]
    fn launch_tells_the_screen_when_cam_usage_times_out() {
        let dir = fake_cam_dir_after("hang", r#"{"best":"acct","choice":"normal","next_available":null,"accounts":[]}"#, "30");
        let (got, r) = launched(&dir, None).unwrap();
        assert_eq!(got.as_deref(), Some("/nowhere/inherited"));
        let note = r["accountFallback"].as_str().unwrap_or_default();
        assert!(note.contains("既定のアカウント"), "{r}");
        assert!(!dir.join("sync.log").exists());
    }

    /// 選べないとき（choice: unknown）は env を触らない。アプリの環境の値のまま起動する
    #[test]
    fn launch_keeps_the_env_when_cam_cannot_choose() {
        let dir = fake_cam_dir("unknown", r#"{"best":null,"choice":"unknown","next_available":null,"accounts":[]}"#);
        let (got, r) = launched(&dir, None).unwrap();
        assert_eq!(got.as_deref(), Some("/nowhere/inherited"));
        // cam が答えて選ばなかったときは知らせない（cam の無い機械や --default のコマンドで毎回トーストを出さない）
        assert_eq!(r["accountFallback"], Value::Null);
        assert!(!dir.join("sync.log").exists());
    }

    /// cam の best が --default のコマンド（プロファイルのディレクトリが無い）なら、~/.claude で起動する。
    /// アプリの環境の CLAUDE_CONFIG_DIR を外す（#251）。開いたのが cam のプロファイルで動くセッションだと、この値が入る。
    /// 開発版だけでなく、そうしたセッションから release-stable.sh の `open` で開いた安定版も受け継ぐ。直す前は親の値のまま起動していた
    #[test]
    fn launch_drops_the_inherited_config_dir_for_a_default_command() {
        let dir = fake_cam_dir("default", r#"{"best":"main","choice":"normal","next_available":null,"accounts":[]}"#);
        assert_eq!(launched_config_dir(&dir).unwrap(), None);
        assert!(!dir.join("sync.log").exists(), "--default のコマンドに cam sync は掛けない（launcher も掛けない）");
    }

    /// 全部のアカウントが上限で、戻る時刻が先にあるときは起動しない。理由に戻るアカウントを書く
    #[test]
    fn launch_refuses_when_every_account_is_at_the_limit() {
        let at = crate::now_ms() as i64 / 1000 + 3600;
        let dir = fake_cam_dir("none", &format!(r#"{{"best":null,"choice":"none","next_available":{{"name":"cto","at":{at}}},"accounts":[]}}"#));
        let err = launched_config_dir(&dir).unwrap_err();
        assert!(err.contains("cto"), "{err}");
        assert!(!dir.join("env.txt").exists(), "claude を起動していない");
    }

    /// resume は全部のアカウントが上限でも断らず、今まで通り（env を触らずに）起動する
    #[test]
    fn resume_is_not_refused_when_every_account_is_at_the_limit() {
        let at = crate::now_ms() as i64 / 1000 + 3600;
        let dir = fake_cam_dir("none-resume", &format!(r#"{{"best":null,"choice":"none","next_available":{{"name":"cto","at":{at}}},"accounts":[]}}"#));
        let id = new_uuid();
        assert_eq!(launched_config_dir_as(&dir, Some(&id)).unwrap().as_deref(), Some("/nowhere/inherited"));
    }

    /// resume も best のプロファイルで起動する
    #[test]
    fn resume_uses_the_cam_best_profile() {
        let dir = fake_cam_dir("best-resume", r#"{"best":"acct","choice":"normal","next_available":null,"accounts":[]}"#);
        let want = format!("{}/acct", dir.join("profiles").display());
        let id = new_uuid();
        assert_eq!(launched_config_dir_as(&dir, Some(&id)).unwrap().as_deref(), Some(want.as_str()));
    }

    #[test]
    fn start_args_from_the_settings() {
        assert_eq!(start_args(Some("sonnet"), Some("plan"), None).unwrap(), vec!["--model", "sonnet", "--permission-mode", "plan"]);
        assert_eq!(start_args(None, None, Some("xhigh")).unwrap(), vec!["--effort", "xhigh"]);
        // 設定していない項目と空の値は渡さない
        assert!(start_args(None, Some(" "), Some("")).unwrap().is_empty());
        assert!(start_args(Some("opus 1"), None, None).is_err());
        assert!(start_args(Some("--x"), None, None).is_err());
        assert!(start_args(None, Some("yolo"), None).is_err());
        assert!(start_args(None, None, Some("ultra")).is_err());
    }

    #[test]
    fn resume_args_keep_the_id_and_drop_the_name() {
        assert_eq!(launch_args("a", false, Some("n")), vec!["--session-id", "a", "--name", "n"]);
        assert_eq!(launch_args("a", false, Some(" ")), vec!["--session-id", "a"]);
        assert_eq!(launch_args("a", true, Some("n")), vec!["--resume", "a"]);
    }

    #[test]
    fn a_broken_ledger_is_kept_aside() {
        let dir = std::env::temp_dir().join(format!("fc-ledger-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("terminals.json");
        assert!(read_ledger(&p).is_empty());
        std::fs::write(&p, "{ not json").unwrap();
        assert!(read_ledger(&p).is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("terminals.json.bad")).unwrap(), "{ not json");
        std::fs::write(&p, r#"{"version":1,"terminals":[{"id":"x","cwd":"/tmp"}]}"#).unwrap();
        assert_eq!(read_ledger(&p), vec![Entry { id: "x".into(), cwd: "/tmp".into(), name: None, cols: 120, rows: 40, started_at: 0 }]);
    }

    /// アプリを終えるときの止め方（kill_all の hangup_all）で、SIGHUP を受けてから 1.5 秒かけて後始末をして終わる代役が、
    /// SIGKILL されずに後始末を終える（#232）。本物の claude は SIGHUP から終わるまで 1.27 秒かかった（README）。
    /// kill_all はほかの試験の端末も止めて SHUTTING も立てるので、代役の pid だけを hangup_all に渡す
    #[test]
    fn shutdown_waits_for_a_slow_hangup() {
        use std::os::unix::fs::PermissionsExt;
        // 町の一覧を数える試験（lib.rs）に、この端末が混ざらないようにする。錠は端末が台帳から消えるまで持つ
        let _serial = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-pty-hup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (ready, hup, done) = (dir.join("ready"), dir.join("hup"), dir.join("done"));
        // SIGHUP を受けたら hup を書き、1.5 秒寝てから done を書いて終わる。trap を張ってから ready を書く。
        // 待つのは短い sleep の輪（sh は前面の子が終わるまで trap を動かさない）。試験が落ちても 30 秒で自分で終わる
        let bin = dir.join("claude");
        std::fs::write(&bin, format!(
            "#!/bin/sh\ntrap ': > \"{hup}\"; sleep 1.5; : > \"{done}\"; exit 0' HUP\n: > \"{ready}\"\ni=0\nwhile [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\n",
            hup = hup.display(), done = done.display(), ready = ready.display()
        )).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {});
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r.unwrap()["id"].as_str().unwrap().to_string();
        let pid = pid_of_id(&id).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) && !ready.exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready.exists(), "代役が ready を書かなかった");

        let t0 = Instant::now();
        hangup_all(&[pid]);
        let took = t0.elapsed();
        // SIGKILL で止まった後に done が遅れて書かれることは無いが、念のため少し待ってから見る
        std::thread::sleep(Duration::from_millis(500));
        let (got_hup, got_done) = (hup.exists(), done.exists());
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_secs(5) && owns(&id) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(got_hup, "代役に SIGHUP が届かなかった");
        assert!(got_done, "SIGHUP の後始末の途中で SIGKILL された（{took:?} で戻った）");
        // 全部が終わったら、待ちの上限まで待たずに戻る
        assert!(took < SHUTDOWN_WAIT, "代役が終わった後も待ち続けた（{took:?}）");
        assert!(!owns(&id));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 台帳の出入り（#152）。閉じたものと自分で終わったものは外れ、アプリを終えるときに止めたものは残り、
    /// id が変わったら新しい id になり、resume は `--resume <id>` を元の cwd で渡す。
    /// 台帳と SHUTTING はプロセスで1つなので、場合を1つの試験に並べ、BIN_LOCK の中で回す（ほかの試験の端末は id で除いて見る）
    #[test]
    fn ledger_keeps_only_what_was_open_when_the_app_ended() {
        use std::os::unix::fs::PermissionsExt;
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let args_out = dir.join("args");
        // 引数と cwd を書き、1行読んだら終わる claude の代わり
        let bin = dir.join("claude");
        std::fs::write(&bin, format!("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > '{}'\nread x\nexit 0\n", args_out.display())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cwd = dir.join("place");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap().to_string_lossy().to_string();
        let ledger = dir.join("terminals.json");
        // 前回の分が1件（まだ立て直していない）
        std::fs::write(&ledger, r#"{"version":1,"terminals":[{"id":"prev-1","cwd":"/nowhere"}]}"#).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let prev = open_ledger(ledger.clone());
        assert_eq!(prev.len(), 1);
        let ids = || -> Vec<String> { read_ledger(&ledger).into_iter().map(|e| e.id).collect() };
        let wait_gone = |id: &str| {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(5) && owns(id) {
                std::thread::sleep(Duration::from_millis(50));
            }
            // 終わりを待つスレッドが台帳を書き直すまで
            std::thread::sleep(Duration::from_millis(100));
            assert!(!owns(id), "{id} が終わらない");
        };

        // 立てると載る。まだ立て直していない分も残る
        let a = spawn(&cwd, Some("名前"), &[], 80, 24, || {}).unwrap()["id"].as_str().unwrap().to_string();
        let l = read_ledger(&ledger);
        let ea = l.iter().find(|e| e.id == a).expect("立てた端末が台帳に無い");
        assert_eq!((ea.cwd.as_str(), ea.name.as_deref(), ea.cols, ea.rows), (cwd.as_str(), Some("名前"), 80, 24));
        assert!(ids().contains(&"prev-1".to_string()));
        // 閉じると外れる
        kill(&a).unwrap();
        wait_gone(&a);
        assert!(!ids().contains(&a));

        // 自分で終わると外れる
        let b = spawn(&cwd, None, &[], 80, 24, || {}).unwrap()["id"].as_str().unwrap().to_string();
        assert!(ids().contains(&b));
        write(&b, "\r").unwrap();
        wait_gone(&b);
        assert!(!ids().contains(&b));

        // /clear などで id が変わると、新しい id で残る。前の id でも同じ端末として扱う
        let c = spawn(&cwd, None, &[], 80, 24, || {}).unwrap()["id"].as_str().unwrap().to_string();
        let pc = pid_of_id(&c).unwrap();
        note_ids(&[("cleared-c".to_string(), pc)]);
        assert!(ids().contains(&"cleared-c".to_string()) && !ids().contains(&c));
        assert!(owns(&c) && owns("cleared-c"));
        // /resume で前の id に戻ると、前の id で残る
        note_ids(&[(c.clone(), pc)]);
        assert!(ids().contains(&c) && !ids().contains(&"cleared-c".to_string()));

        // 立て直した分を外す
        settle("prev-1");
        assert!(!ids().contains(&"prev-1".to_string()));

        // resume は --resume <id> を元の cwd で渡し、このアプリの端末になる
        let r = resume("resumed-1", &cwd, Some("名前"), 80, 24, || {}).unwrap();
        assert_eq!(r["id"], "resumed-1");
        assert!(owns("resumed-1"));
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) && std::fs::read_to_string(&args_out).map(|t| !t.contains("resumed-1")).unwrap_or(true) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let got = std::fs::read_to_string(&args_out).unwrap();
        assert_eq!(got.lines().collect::<Vec<_>>(), vec![cwd.as_str(), "--resume", "resumed-1"]);
        assert!(ids().contains(&"resumed-1".to_string()));
        // 同じ id をもう一度は立てない
        assert!(resume("resumed-1", &cwd, None, 80, 24, || {}).is_err());

        // アプリを終えるときに止めたものは残る（kill_all はほかの試験の端末も止めるので、前半だけを呼ぶ）
        begin_shutdown();
        let before = ids();
        kill(&c).unwrap();
        kill("resumed-1").unwrap();
        wait_gone(&c);
        wait_gone("resumed-1");
        assert_eq!(ids(), before);
        assert!(before.contains(&c) && before.contains(&"resumed-1".to_string()));
        SHUTTING.store(false, Ordering::SeqCst);
        *LEDGER.lock().unwrap_or_else(|e| e.into_inner()) = None;
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
    }

    /// /clear で X から Y になった端末の X が、別の pid の行として見えたら（よその端末で `claude --resume X`）、X はもうこの端末ではない（#174）。
    /// 今の id のまま別の pid に見えたときは外さない（起動の直後や、claude を子として立てる launcher で pid が合わないときに、自分の端末を手放さない）
    #[test]
    fn an_old_id_seen_on_another_pid_leaves_the_terminal() {
        use std::os::unix::fs::PermissionsExt;
        // 町の一覧を数える試験（lib.rs）に、この端末が混ざらないようにする
        let _serial = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-pty-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\nexec cat\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let x = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {}).unwrap()["id"].as_str().unwrap().to_string();
        let z = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {}).unwrap()["id"].as_str().unwrap().to_string();
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let px = pid_of_id(&x).unwrap();
        let pz = pid_of_id(&z).unwrap();
        // 台帳に無い pid（この試験のプロセス）を、よその端末の pid にする
        let other = std::process::id();
        let y = format!("cleared-{x}");

        note_ids(&[(y.clone(), px)]);
        assert_eq!(pid_of_id(&x), Some(px), "/clear の前の id でも同じ端末");
        note_ids(&[(x.clone(), other), (y.clone(), px)]);
        assert_eq!(pid_of_id(&x), None, "よその端末で resume した前の id を、まだこのアプリの端末として扱っている");
        assert_eq!(pid_of_id(&y), Some(px), "今の id はこの端末のまま");
        assert_eq!(ids_of(&y), vec![y.clone()]);

        // 今の id が別の pid に見えても外さない
        note_ids(&[(z.clone(), other)]);
        assert_eq!(pid_of_id(&z), Some(pz));

        for id in [&y, &z] {
            kill(id).unwrap();
        }
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) && (owns(&y) || owns(&z)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!owns(&y) && !owns(&z));
    }

    /// 本物の PTY で、cat を起動して書き、読み、止める（claude の代わり）
    #[test]
    fn spawn_write_read_kill_with_a_stand_in() {
        let dir = std::env::temp_dir().join(format!("fc-pty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\nexec cat\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {}).unwrap();
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r["id"].as_str().unwrap().to_string();
        assert!(owns(&id));
        write(&id, "hello\r").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let t0 = Instant::now();
        let mut seen = String::new();
        subscribe(&id, 1, tx).unwrap();
        while t0.elapsed() < Duration::from_secs(5) && !seen.contains("hello") {
            if let Ok(o) = rx.recv_timeout(Duration::from_millis(100)) {
                match o {
                    TermOut::Text(s) => seen.push_str(&s),
                    TermOut::Event(_, v) => seen.push_str(v["s"].as_str().unwrap_or("")),
                }
            }
        }
        assert!(seen.contains("hello"), "{seen:?}");
        resize(&id, 100, 30).unwrap();
        kill(&id).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) && owns(&id) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!owns(&id));
    }

    /// 代役の claude（中身は script）を立てて id を返す。返す錠は、町の一覧を数える試験（lib.rs）と FC_CLAUDE_BIN を分けるもので、
    /// 端末を止めて台帳から消えるまで持つ（取る順は launched_config_dir_as と同じ NATIVE_TEST_LOCK、BIN_LOCK）
    fn stand_in(tag: &str, script: &str) -> (String, PathBuf, [std::sync::MutexGuard<'static, ()>; 2]) {
        use std::os::unix::fs::PermissionsExt;
        let native = crate::NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let bin_lock = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("fc-pty-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, script.replace("__DIR__", &dir.to_string_lossy())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, &[], 80, 24, || {});
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r.unwrap()["id"].as_str().unwrap().to_string();
        (id, dir, [native, bin_lock])
    }

    fn stop(id: &str) {
        kill(id).unwrap();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) && owns(id) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 代役が raw にした（ready を書いた）のを待つ
    fn wait_ready(dir: &std::path::Path) {
        let t0 = Instant::now();
        while !dir.join("ready").exists() {
            assert!(t0.elapsed() < Duration::from_secs(5), "代役が raw にならない");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 入力を読まない claude に、ターミナルの欄から長い貼り付け（4096 文字）が来ても、term_input はすぐ戻る（#231）。
    /// term_input は async の付かない命令で、Tauri のメインスレッドで動く。戻らないと窓全体が固まる。
    /// 代役は claude と同じく raw にしてから寝る（行の編集のモードのままだと、macOS は行の上限を超えた分を捨て、書き込みは詰まらない）
    #[test]
    fn term_input_returns_while_the_child_does_not_read() {
        let (id, dir, _locks) = stand_in("unread", "#!/bin/sh\nstty raw -echo\n: > '__DIR__/ready'\nexec sleep 30\n");
        wait_ready(&dir);
        let (tx, rx) = std::sync::mpsc::channel();
        let id2 = id.clone();
        // メインスレッドの代わり
        std::thread::spawn(move || { let _ = tx.send(crate::terminal::term_input(id2, "x".repeat(4096))); });
        let r = rx.recv_timeout(Duration::from_secs(1));
        stop(&id);
        assert!(matches!(r, Ok(Ok(()))), "term_input が1秒で戻らなかった: {r:?}");
    }

    /// 打った順に届く（#231）。代役は raw にしてから1秒読まずに待ち（その間 PTY は詰まる）、その後に受けた分を全部ファイルに書く。
    /// 1字ずつと貼り付けを、待たずに続けて term_input に渡す
    #[test]
    fn term_input_keeps_the_order() {
        let script = "#!/bin/sh\nstty raw -echo\n: > '__DIR__/ready'\nsleep 1\nexec cat > '__DIR__/got'\n";
        let (id, dir, _locks) = stand_in("order", script);
        wait_ready(&dir);
        let mut want = String::new();
        let t0 = Instant::now();
        for i in 0..400 {
            let s = if i % 50 == 0 { format!("[paste {i} {}]", "y".repeat(500)) } else { format!("{}", i % 10) };
            crate::terminal::term_input(id.clone(), s.clone()).unwrap();
            want.push_str(&s);
        }
        let queued_in = t0.elapsed();
        let t0 = Instant::now();
        let got = loop {
            let got = std::fs::read_to_string(dir.join("got")).unwrap_or_default();
            if got.len() >= want.len() || t0.elapsed() > Duration::from_secs(10) { break got; }
            std::thread::sleep(Duration::from_millis(50));
        };
        stop(&id);
        assert_eq!(got.len(), want.len(), "届いた長さが違う");
        assert!(got == want, "順が入れ替わった");
        assert!(queued_in < Duration::from_millis(500), "代役が読まない間に term_input が待った: {queued_in:?}");
    }
}

#[cfg(test)]
mod real {
    /// 本物の claude で確かめる（課金がかかるので手で回す）。信頼済みの場所 FC_PTY_TRY_CWD で起動し、
    /// sessions/<pid>.json の pid と id、/clear の後の id を出し、止めずにプロセスを終える（落ちたときと同じく、親の側が閉じる）。
    /// FC_PTY_TRY_CWD=<信頼済みの場所> cargo test --lib real_claude_pty -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_claude_pty() {
        use std::time::{Duration, Instant};
        let cwd = std::env::var("FC_PTY_TRY_CWD").expect("FC_PTY_TRY_CWD");
        let r = super::spawn(&cwd, None, &[], 120, 40, || {}).unwrap();
        let (id, pid) = (r["id"].as_str().unwrap().to_string(), r["pid"].as_u64().unwrap());
        println!("spawned id={id} pid={pid}");
        let (tx, rx) = std::sync::mpsc::channel();
        super::subscribe(&id, 1, tx).unwrap();
        let dump = move || {
            let mut out = String::new();
            while let Ok(o) = rx.try_recv() {
                match o { super::TermOut::Text(s) => out.push_str(&s), super::TermOut::Event(_, v) => out.push_str(v["s"].as_str().unwrap_or("")) }
            }
            let _ = std::fs::write("/tmp/fc-pty-try.out", &out);
            out.len()
        };
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/sessions");
        let read = || std::fs::read_to_string(home.join(format!("{pid}.json"))).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let t0 = Instant::now();
        // 信頼の確認の画面が出たら「Yes」を選ぶ（信頼する前は sessions/<pid>.json が作られない）
        std::thread::sleep(Duration::from_secs(4));
        if read().is_none() {
            println!("no sessions file before trust after {:?}", t0.elapsed());
            super::write(&id, "\x1b[B").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            super::write(&id, "\r").unwrap();
        }
        while t0.elapsed() < Duration::from_secs(30) && read().is_none() {
            std::thread::sleep(Duration::from_millis(200));
        }
        if read().is_none() { println!("dumped {} bytes to /tmp/fc-pty-try.out", dump()); }
        let v = read().expect("sessions/<pid>.json が出なかった");
        println!("sessions/{pid}.json: sessionId={} pid={} status={} after {:?}", v["sessionId"], v["pid"], v["status"], t0.elapsed());
        std::thread::sleep(Duration::from_secs(4));
        super::write(&id, "/clear").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        super::write(&id, "\r").unwrap();
        std::thread::sleep(Duration::from_secs(4));
        let v2 = read().unwrap();
        println!("after /clear: sessionId={} pid={}", v2["sessionId"], v2["pid"]);
        println!("exiting without kill; check: ps -p {pid}");
    }
}

#[cfg(test)]
mod real_permission {
    /// 本物の claude で、承認待ちのときにチャット欄からの送信を断るかを確かめる（課金がかかるので手で回す）。
    /// FC_PTY_TRY_CWD=<信頼済みで、Bash を許可していない場所> <試験のバイナリ> real_permission_wait --ignored --nocapture
    #[test]
    #[ignore]
    fn real_permission_wait() {
        use std::time::{Duration, Instant};
        let cwd = std::env::var("FC_PTY_TRY_CWD").expect("FC_PTY_TRY_CWD");
        println!("login_path = {:?}", super::login_path());
        let r = super::spawn(&cwd, None, &[], 120, 40, || {}).unwrap();
        let (id, pid) = (r["id"].as_str().unwrap().to_string(), r["pid"].as_u64().unwrap() as u32);
        let root = crate::native::claude_home();
        let row = || crate::native::sessions::fresh_row(&root, pid);
        let t0 = Instant::now();
        // 信頼の確認の画面が出たら「Yes」を選ぶ（信頼する前は sessions/<pid>.json が作られない）
        std::thread::sleep(Duration::from_secs(4));
        if row().is_none() {
            println!("trust prompt: before trusting, send_direct says {:?}", crate::composer::send_direct(id.clone(), "x".into()));
            super::write(&id, "\x1b[B").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            super::write(&id, "\r").unwrap();
        }
        while t0.elapsed() < Duration::from_secs(30) && row().is_none() {
            std::thread::sleep(Duration::from_millis(300));
        }
        println!("sessions/{pid}.json after {:?}: {:?}", t0.elapsed(), row());
        std::thread::sleep(Duration::from_secs(5));
        let sent = crate::composer::send_direct(id.clone(), "Bash ツールで date コマンドを実行して、出力だけを答えて".into());
        println!("first send: {sent:?}");
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_secs(60) && row().map(|v| v["state"] != "waiting_permission").unwrap_or(true) {
            std::thread::sleep(Duration::from_millis(300));
        }
        println!("state after {:?}: {:?}", t1.elapsed(), row());
        let second = crate::composer::send_direct(id.clone(), "これは届いてはいけない".into());
        println!("second send while waiting: {second:?}");
        super::kill(&id).unwrap();
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod real_boot {
    /// 本物の claude で、起動の前に送った文を預かり、起動してから送るかを確かめる（課金がかかるので手で回す）。
    /// 起動の直後に send_or_queue を呼び、預かったこと、起動するまで送らないこと、起動したら送ったことを、時刻つきで出す。
    /// 信頼の確認の画面が出たら（sessions/<pid>.json が無いまま）、10秒待って預かったままかを見てから「Yes」を選ぶ。
    /// FC_PTY_TRY_CWD=<場所> cargo test --lib real_boot_queue -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_boot_queue() {
        use std::time::{Duration, Instant};
        let cwd = std::env::var("FC_PTY_TRY_CWD").expect("FC_PTY_TRY_CWD");
        let r = super::spawn(&cwd, None, &[], 120, 40, || {}).unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        let t0 = Instant::now();
        let msg = "この文には「了解」とだけ返して";
        let q = crate::composer::send_or_queue(id.clone(), msg.into()).unwrap();
        println!("{:?} send_or_queue -> {q}", t0.elapsed());
        assert_eq!(q["queued"], true, "起動の直後は預かる");
        let st = || crate::composer::boot_status(&id);
        let mut trusted = false;
        while t0.elapsed() < Duration::from_secs(60) {
            let s = st();
            if !s["done"].as_array().unwrap().is_empty() {
                println!("{:?} done: {}", t0.elapsed(), s["done"]);
                assert!(s["done"][0]["error"].is_null(), "送れた");
                assert_eq!(s["booted"], true, "送ったときは起動済み");
                break;
            }
            if !trusted && s["rowSeen"] == false && t0.elapsed() > Duration::from_secs(10) {
                let screen = super::screen_text(&id).unwrap_or_default();
                println!("{:?} 信頼の確認の画面らしい。booted={} queued={} 画面の末尾:\n{}", t0.elapsed(), s["booted"], s["queued"], screen.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n"));
                assert_eq!(s["queued"].as_array().unwrap().len(), 1, "信頼の確認の画面の間は預かったまま");
                // 「Yes」の行の番号を押す（行の並びは版で変わりうるので、画面から読む）
                let yes = screen.lines().find(|l| l.contains("Yes")).and_then(|l| l.chars().find(|c| c.is_ascii_digit()));
                println!("Yes の番号: {yes:?}");
                match yes { Some(d) => super::write(&id, &d.to_string()).unwrap(), None => { super::write(&id, "\x1b[B").unwrap(); std::thread::sleep(Duration::from_millis(300)); super::write(&id, "\r").unwrap(); } }
                trusted = true;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        std::thread::sleep(Duration::from_secs(8));
        let screen = super::screen_text(&id).unwrap_or_default();
        println!("画面:\n{}", screen.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n"));
        super::kill(&id).unwrap();
    }
}

#[cfg(test)]
mod real_cam {
    /// 本物の cam と claude で、cam usage の best のプロファイルで起動するかを確かめる（画面を出さない。claude は信頼の画面で止まったまま止める）。
    /// 起動した claude の `ps eww` の CLAUDE_CONFIG_DIR と、cam usage --json の best を並べて出す。cargo の環境の CLAUDE_CONFIG_DIR は外して回す。
    /// env -u CLAUDE_CONFIG_DIR FC_CAM_BIN=$HOME/.cam/bin/cam cargo test --lib real_cam_account -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_cam_account() {
        use std::time::Duration;
        assert!(std::env::var("CLAUDE_CONFIG_DIR").is_err(), "env -u CLAUDE_CONFIG_DIR で回す");
        let cam = std::env::var("FC_CAM_BIN").expect("FC_CAM_BIN");
        let dir = std::env::temp_dir().join(format!("fc-real-cam-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let r = super::spawn(dir.to_str().unwrap(), None, &[], 120, 40, || {}).unwrap();
        let (id, pid) = (r["id"].as_str().unwrap().to_string(), r["pid"].as_u64().unwrap());
        std::thread::sleep(Duration::from_secs(4));
        let ps = std::process::Command::new("/bin/ps").args(["eww", "-o", "command=", "-p", &pid.to_string()]).output().unwrap();
        let ps = String::from_utf8_lossy(&ps.stdout).to_string();
        let got = ps.split_whitespace().find(|w| w.starts_with("CLAUDE_CONFIG_DIR=")).map(String::from);
        let usage = std::process::Command::new(&cam).args(["usage", "--json"]).output().unwrap();
        let best = serde_json::from_slice::<serde_json::Value>(&usage.stdout).unwrap()["best"].as_str().map(String::from);
        println!("pid {pid}: {}", got.as_deref().unwrap_or("CLAUDE_CONFIG_DIR なし"));
        println!("cam usage --json best: {best:?}");
        println!("screen: {}", super::screen_text(&id).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).take(6).collect::<Vec<_>>().join(" / "));
        super::kill(&id).unwrap();
        let want = format!("CLAUDE_CONFIG_DIR={}/.cam/profiles/{}", std::env::var("HOME").unwrap(), best.expect("cam の best が null"));
        assert_eq!(got.as_deref(), Some(want.as_str()));
    }
}
