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
use std::sync::{Arc, Mutex, OnceLock};
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

/// 一覧で見えた行（id と pid）を台帳に足す。/clear などで id が変わっても、同じ pid なら同じ端末として扱う
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
    pub pid: u32,
    pub cwd: String,
    pub started_at: u64,
}

pub fn list() -> Vec<Info> {
    with(|m| {
        let mut v: Vec<Info> = m.values().map(|p| Info { id: p.ids[0].clone(), ids: p.ids.clone(), pid: p.pid, cwd: p.cwd.clone(), started_at: p.started_at }).collect();
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
/// claude が呼ぶ git や bun も見つからない。ターミナルで開いたときと同じ PATH を、ログインシェルに1回だけ聞いて覚える。
/// 対話の設定（.zshrc）で PATH を足す人が多いので -i も付ける。出力の前後に設定が何か書いても拾えるよう、印で挟む
fn login_path() -> Option<String> {
    static P: OnceLock<Option<String>> = OnceLock::new();
    P.get_or_init(|| {
        let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
        let mut child = std::process::Command::new(&shell)
            .args(["-l", "-i", "-c", "printf '\\n__FC_PATH__%s__FC_PATH__\\n' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let t0 = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if t0.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("[pty] ログインシェルが5秒で PATH を返さなかった");
                    return None;
                }
            }
        }
        let mut s = String::new();
        child.stdout.take()?.read_to_string(&mut s).ok()?;
        let p = s.split("__FC_PATH__").nth(1)?.to_string();
        (!p.is_empty()).then_some(p)
    })
    .clone()
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

/// 新しい世帯を立てるときのモデルと権限モード（設定の既定、src/session/defaults.ts）を、claude の --model と --permission-mode にする。
/// 空の値は渡さない（この Mac の Claude Code の既定になる）。空白を含む値や、知らない権限モードは断る（引数を1つずつ渡すので混ざりはしないが、打ち間違いを起動の前に止める）
pub fn start_args(model: Option<&str>, mode: Option<&str>) -> Result<Vec<String>, String> {
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
    let config_dir = crate::account::prepare(path.as_deref(), resume.is_none())?;
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
    // 選べたときだけ差し替える。アプリの環境に別の値があっても（cam の launcher から開いた開発版）、選んだプロファイルにする
    if let Some(d) = &config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", d);
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
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let started_at = crate::now_ms() as u64;
    with(|m| {
        m.insert(pid, Proc { pid, ids: vec![id.clone()], cur: id.clone(), name, cwd: cwd.to_string(), started_at, size: (cols, rows), master: pair.master, writer: Arc::new(Mutex::new(writer)), killer, out: vec![], screen: new_screen(cols, rows), sub: None, carry: vec![] });
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
        if let Some(p) = gone
            && let Some((_, tx)) = &p.sub {
                let _ = tx.send(TermOut::Event("exit".into(), json!({ "reason": "終わった", "code": code })));
            }
        // 閉じた、または claude が自分で終わったので、次の起動で戻さない（アプリを終えている途中なら persist は書かない）
        persist();
        notice();
    });
    Ok(json!({ "id": id, "pid": pid, "cwd": cwd }))
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

/// このアプリが立てたセッションの pid
pub fn pid_of_id(id: &str) -> Option<u32> {
    with(|m| pid_of(m, id))
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

/// アプリを終えるときに、ここから立てた claude を全部止める。SIGHUP を全部に送り、1秒待って残りに SIGKILL
pub fn kill_all() {
    // 台帳はアプリを終える前のまま残す（次の起動で戻す）
    begin_shutdown();
    let pids: Vec<u32> = with(|m| m.keys().copied().collect());
    if pids.is_empty() {
        return;
    }
    for &pid in &pids {
        unsafe { libc::kill(pid as i32, libc::SIGHUP) };
    }
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(1) && pids.iter().any(|&p| alive(p)) {
        std::thread::sleep(Duration::from_millis(50));
    }
    for &pid in pids.iter().filter(|&&p| alive(p)) {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
    eprintln!("[pty] アプリを終えるので {} 体の claude を止めた", pids.len());
}

fn alive(pid: u32) -> bool {
    let r = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
    if r == pid as i32 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

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

    static BIN_LOCK: Mutex<()> = Mutex::new(());

    /// 偽の cam と偽の claude を置いた試験用のディレクトリ。cam usage --json は usage を返し、sync は呼ばれた名前を sync.log に足す。
    /// claude は自分の環境を env.txt に書いてから寝る
    fn fake_cam_dir(tag: &str, usage: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fc-pty-cam-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profiles/acct")).unwrap();
        std::fs::write(dir.join("usage.json"), usage).unwrap();
        let cam = format!(
            "#!/bin/sh\ncase \"$1\" in\n  usage) cat '{d}/usage.json' ;;\n  sync) echo \"$2\" >> '{d}/sync.log' ;;\nesac\n",
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
        // 町の一覧を数える試験（lib.rs）に、この端末が混ざらないようにする。錠は端末が台帳から消えるまで持つ
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
        let id = r?["id"].as_str().unwrap().to_string();
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
        Ok(env.lines().find_map(|l| l.strip_prefix("CLAUDE_CONFIG_DIR=")).map(String::from))
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

    /// 選べないとき（choice: unknown）は env を触らない。アプリの環境の値のまま起動する
    #[test]
    fn launch_keeps_the_env_when_cam_cannot_choose() {
        let dir = fake_cam_dir("unknown", r#"{"best":null,"choice":"unknown","next_available":null,"accounts":[]}"#);
        assert_eq!(launched_config_dir(&dir).unwrap().as_deref(), Some("/nowhere/inherited"));
        assert!(!dir.join("sync.log").exists());
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
        assert_eq!(start_args(Some("sonnet"), Some("plan")).unwrap(), vec!["--model", "sonnet", "--permission-mode", "plan"]);
        // 設定していない項目と空の値は渡さない
        assert!(start_args(None, Some(" ")).unwrap().is_empty());
        assert!(start_args(Some("opus 1"), None).is_err());
        assert!(start_args(Some("--x"), None).is_err());
        assert!(start_args(None, Some("yolo")).is_err());
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
