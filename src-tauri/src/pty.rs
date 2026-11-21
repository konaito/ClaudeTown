// アプリの中の端末（PTY）。「＋ 新しい世帯」で claude をこのアプリの子プロセスとして起動し、出力を右パネルの xterm.js に流す。
// crate は portable-pty（wezterm の一部、MIT）。同期の API で、読み書きをスレッドで回す今の作りにそのまま合う。
//
// - 起動するとき `--session-id <uuid>` を渡す。Claude Code は ~/.claude/sessions/<pid>.json にこの id を書く（2026-11-21 に実測）。
//   /clear などで id が変わっても pid は同じなので、台帳は pid で引き、一覧で同じ pid に見えた id を足していく（ids）。
// - 出力の末尾 KEEP_BYTES を持ち、端末を開いた画面には size と replay（持っている分）を送ってから、続きを data で流す。
// - アプリを終えるとき、ここから立てた claude を全部止める（kill_all）。アプリが落ちたときは、PTY の親の側が閉じて
//   claude に SIGHUP が届く（下の試験と README に結果を書いた）。どちらでも、アプリから立てた世帯はアプリと一緒に止まる。
// - 書き口（writer）は claude が動いている間は落とさない。portable-pty は書き口を落とすときに改行と EOT を書くので、
//   動いている claude には Enter が届いてしまう。

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
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
    cwd: String,
    started_at: u64,
    size: (u16, u16),
    master: Box<dyn MasterPty + Send>,
    /// 書き口は台帳の錠の外で書く（claude が読まずに PTY が詰まっても、出力の読み手と一覧を止めない）
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 出力の末尾
    out: Vec<u8>,
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
    with(|m| {
        for (id, pid) in rows {
            if let Some(p) = m.get_mut(pid) {
                if !p.ids.contains(id) {
                    p.ids.push(id.clone());
                }
            }
        }
    });
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
    if let Ok(b) = std::env::var("FC_CLAUDE_BIN") {
        if !b.is_empty() {
            return Ok(PathBuf::from(b));
        }
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

// ---------- 起動 ----------

/// claude を PTY で起動し、セッションの id を返す。cwd はディレクトリでなければ断る
pub fn spawn(cwd: &str, name: Option<&str>, cols: u16, rows: u16, notice: impl Fn() + Send + 'static) -> Result<Value, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("場所が無いか、ディレクトリではない: {cwd}"));
    }
    let path = login_path();
    let bin = claude_bin(path.as_deref())?;
    let id = new_uuid();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| format!("端末を開けなかった: {e}"))?;
    let mut cmd = CommandBuilder::new(&bin);
    cmd.args(["--session-id", &id]);
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) {
        cmd.args(["--name", n]);
    }
    cmd.cwd(cwd);
    for (k, _) in std::env::vars() {
        if drop_env(&k) {
            cmd.env_remove(&k);
        }
    }
    if let Some(p) = &path {
        cmd.env("PATH", p);
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
        m.insert(pid, Proc { pid, ids: vec![id.clone()], cwd: cwd.to_string(), started_at, size: (cols, rows), master: pair.master, writer: Arc::new(Mutex::new(writer)), killer, out: vec![], sub: None, carry: vec![] });
    });
    eprintln!("[pty] claude を起動した pid {pid} id {id} cwd {cwd}");
    std::thread::spawn(move || read_loop(pid, reader));
    std::thread::spawn(move || {
        let st = child.wait();
        let code = st.as_ref().ok().map(|s| s.exit_code());
        eprintln!("[pty] claude が終わった pid {pid} {st:?}");
        // 読み手が最後の出力を送り終えるのを少し待ってから、台帳から外す
        std::thread::sleep(Duration::from_millis(200));
        let gone = with(|m| m.remove(&pid));
        if let Some(p) = gone {
            if let Some((_, tx)) = &p.sub {
                let _ = tx.send(TermOut::Event("exit".into(), json!({ "reason": "終わった", "code": code })));
            }
        }
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
        if let Some(p) = pid_of(m, id).and_then(|pid| m.get_mut(&pid)) {
            if generation.is_none() || p.sub.as_ref().map(|s| s.0) == generation {
                p.sub = None;
            }
        }
    });
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

    /// 書き込みが詰まっても台帳の錠を持たない（読まない子に大きく書いている間も、owns と list が返る）
    #[test]
    fn a_stuck_write_does_not_hold_the_table() {
        let dir = std::env::temp_dir().join(format!("fc-pty-stuck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        // 入力を読まない子
        std::fs::write(&bin, "#!/bin/sh\nexec sleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _g = BIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("FC_CLAUDE_BIN", &bin) };
        let r = spawn(dir.to_str().unwrap(), None, 80, 24, || {}).unwrap();
        unsafe { std::env::remove_var("FC_CLAUDE_BIN") };
        let id = r["id"].as_str().unwrap().to_string();
        let id2 = id.clone();
        // PTY の入力の欄（数KB）を超えて書く。子が読まないので、この書き込みは戻らない
        std::thread::spawn(move || { let _ = write(&id2, &"x".repeat(1 << 20)); });
        std::thread::sleep(Duration::from_millis(300));
        let t0 = Instant::now();
        assert!(owns(&id));
        assert!(!list().is_empty());
        assert!(t0.elapsed() < Duration::from_millis(200), "台帳の錠が書き込みに取られている");
        kill(&id).unwrap();
    }

    static BIN_LOCK: Mutex<()> = Mutex::new(());

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
        let r = spawn(dir.to_str().unwrap(), None, 80, 24, || {}).unwrap();
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
        let r = super::spawn(&cwd, None, 120, 40, || {}).unwrap();
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
        let r = super::spawn(&cwd, None, 120, 40, || {}).unwrap();
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
