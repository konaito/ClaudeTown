// 安定版の更新（#295）。設定の画面の「更新」の欄と、ヘッダーの歯車の点のもと。
//
// - 今の版は、release-stable.sh が書く <置き場>/current.ref（「タグ sha」の1行）から読む
// - origin/main は、本体の checkout（既定 ~/Documents/family-computing）で数分ごとに git fetch origin して読む。
//   fetch は裏のスレッドで回し、アプリの起動を待たせない
// - 「更新して再起動」は、fetch した origin/main の scripts/release-stable.sh と stable-lib.sh を一時の場所に取り出し、
//   release-stable.sh origin/main を、アプリから切り離して走らせる。本体の checkout の作業ツリーのスクリプトは走らせない（#299）。
//   スクリプトは途中で安定版（このアプリ）を終わらせる。2026-11-23 に、安定版の端末の中から走らせたスクリプトが、
//   安定版の終わりと一緒に落ち、current.ref、hook の写し、releases.log、起動が抜けた。
//   ここでは新しいセッション（setsid）で走らせ、標準入力は /dev/null、標準出力と標準エラーはファイルにし、
//   0〜2 以外のファイル記述子は exec で閉じる。アプリが終わっても、スクリプトに SIGHUP も SIGPIPE も届かない
//
// 開発版（identifier が jp.fybe.family-computing.dev）では、FC_UPDATE=1 のときだけ動く。
// 開発版で「更新して再起動」を走らせるのは、CT_DEST_DIR、CT_STABLE_HOME、FC_UPDATE_REPO の3つを一時の場所に向けたときだけにする
// （本物の /Applications、~/.family-computing/stable、本体の checkout のタグとビルド用の worktree に触らない）。
//
// 差し替えの口（確かめる用）:
//   FC_UPDATE=1        開発版でも欄と点を出す
//   FC_UPDATE_REPO     本体の checkout の場所（既定 ~/Documents/family-computing）
//   CT_STABLE_HOME     current.ref と記録の置き場（release-stable.sh と同じ変数。既定 ~/.family-computing/stable）
//   FC_UPDATE_PATH     スクリプトに渡す PATH（既定はログインシェルの PATH。偽の bunx を先頭に置くときに使う）
//
// 置き場に足すファイル（古い安定版は読まないので、足しても古い版は困らない）:
//   update-run.log    最後に走らせた更新の出力
//   update-run.exit   最後に走らせた更新の終わり（「YYYY-MM-DD HH:MM:SS 終了コード」の1行）
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{home, now_ms, STABLE_ID};

/// 比べる相手
pub(crate) const BRANCH: &str = "origin/main";
/// 起動してから最初に fetch するまで（起動の直後は立て直しなどで忙しいので、少しずらす）
const FIRST_DELAY: Duration = Duration::from_secs(20);
/// fetch の間隔（仮置き、#295）
const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);
/// git の1回の上限。過ぎたら止めて、失敗として出す
const GIT_LIMIT: Duration = Duration::from_secs(120);
/// 画面に出す出力の末尾の行数
const TAIL: usize = 20;

/// 欄と点を出すか。安定版はいつも出す。開発版は FC_UPDATE=1 のときだけ出す
pub(crate) fn wanted(app_id: &str, flag: Option<&str>) -> bool {
    app_id == STABLE_ID || flag == Some("1")
}

/// 更新を走らせてよいか。開発版は、入れ先（CT_DEST_DIR）、置き場（CT_STABLE_HOME）、リポジトリ（FC_UPDATE_REPO）の3つを差し替えたときだけ走らせる
pub(crate) fn run_allowed(app_id: &str, dest_dir: Option<&str>, stable_home: Option<&str>, repo: Option<&str>) -> Result<(), String> {
    if app_id == STABLE_ID {
        return Ok(());
    }
    let set = |v: Option<&str>| v.is_some_and(|s| !s.is_empty());
    if set(dest_dir) && set(stable_home) && set(repo) {
        Ok(())
    } else {
        Err("開発版では、CT_DEST_DIR、CT_STABLE_HOME、FC_UPDATE_REPO を一時の場所に向けたときだけ更新を走らせる".into())
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct Current {
    pub tag: String,
    pub sha: String,
}

/// current.ref の中身（「タグ sha」の1行）を読む。形が違えば None
pub(crate) fn parse_current_ref(s: &str) -> Option<Current> {
    let mut it = s.split_whitespace();
    let tag = it.next()?;
    let sha = it.next()?;
    if it.next().is_some() || sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(Current { tag: tag.into(), sha: sha.to_ascii_lowercase() })
}

/// 今の版と origin/main の関係
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Compare {
    /// 同じコミット
    Same,
    /// origin/main が今の版の子孫で、n コミット新しい
    Ahead { n: u32 },
    /// origin/main が今の版の子孫ではない（今の版が main に無いコミットから上げてある、など）。更新とはみなさない
    Diverged,
}

/// 比べた結果を決める。is_ancestor は「今の版が origin/main の祖先か」、count は今の版..origin/main のコミットの数
pub(crate) fn compare(cur: &str, remote: &str, is_ancestor: bool, count: u32) -> Compare {
    if cur == remote {
        Compare::Same
    } else if is_ancestor && count > 0 {
        Compare::Ahead { n: count }
    } else {
        Compare::Diverged
    }
}

/// update-run.exit の1行（「YYYY-MM-DD HH:MM:SS 終了コード」）を読む
pub(crate) fn parse_exit_file(s: &str) -> Option<(String, i32)> {
    let line = s.lines().next()?.trim();
    let (at, code) = line.rsplit_once(' ')?;
    Some((at.trim().to_string(), code.parse().ok()?))
}

/// 出力の末尾の n 行（空行は除く）
pub(crate) fn tail_lines(s: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].iter().map(|l| l.to_string()).collect()
}

/// ログインシェルの PATH に、cargo と /usr/sbin が無ければ足す（release-stable.sh は bun、cargo、ditto、PlistBuddy を呼ぶ）
pub(crate) fn script_path(login: Option<&str>, home: &Path) -> String {
    let mut parts: Vec<String> = login.unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin").split(':').filter(|s| !s.is_empty()).map(String::from).collect();
    for extra in [home.join(".cargo/bin").to_string_lossy().into_owned(), home.join(".bun/bin").to_string_lossy().into_owned(), "/usr/sbin".into()] {
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

// ---------- 置き場所 ----------

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

fn app_id() -> &'static str {
    crate::APP_ID.get().map(String::as_str).unwrap_or("")
}

fn repo() -> PathBuf {
    env("FC_UPDATE_REPO").map(PathBuf::from).unwrap_or_else(|| home().join("Documents/family-computing"))
}

fn stable_home() -> PathBuf {
    env("CT_STABLE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".family-computing/stable"))
}

// ---------- git ----------

/// git を GIT_LIMIT まで待って走らせる。終了コードと標準出力を返す。走らせられないか時間切れなら Err
fn git(repo: &Path, args: &[&str]) -> Result<(i32, String, String), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git を起動できない: {e}"))?;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < GIT_LIMIT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} が{}秒で終わらなかった", args.join(" "), GIT_LIMIT.as_secs()));
            }
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).trim().to_string(), String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

fn rev(repo: &Path, r: &str) -> Result<String, String> {
    match git(repo, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")])? {
        (0, out, _) if !out.is_empty() => Ok(out),
        _ => Err(format!("{r} がリポジトリに無い")),
    }
}

fn compare_in(repo: &Path, cur: &str) -> Result<(String, Compare), String> {
    let remote = rev(repo, BRANCH)?;
    rev(repo, cur).map_err(|_| format!("今の版のコミット {} がリポジトリに無い", &cur[..7.min(cur.len())]))?;
    if remote == cur {
        return Ok((remote, Compare::Same));
    }
    let is_ancestor = match git(repo, &["merge-base", "--is-ancestor", cur, &remote])? {
        (0, ..) => true,
        (1, ..) => false,
        (_, _, err) => return Err(format!("今の版と {BRANCH} を比べられない: {err}")),
    };
    let count = if is_ancestor {
        match git(repo, &["rev-list", "--count", &format!("{cur}..{remote}")])? {
            (0, out, _) => out.parse().map_err(|_| format!("コミットの数を読めない: {out}"))?,
            (_, _, err) => return Err(format!("コミットの数を数えられない: {err}")),
        }
    } else {
        0
    };
    Ok((remote.clone(), compare(cur, &remote, is_ancestor, count)))
}

// ---------- 裏の fetch ----------

#[derive(Default)]
struct Check {
    /// 最後に fetch を終えた時刻（ms）
    at: Option<u64>,
    /// 最後の fetch の失敗の理由
    error: Option<String>,
    /// fetch している最中
    busy: bool,
}

static CHECK: Mutex<Check> = Mutex::new(Check { at: None, error: None, busy: false });

fn fetch_once() {
    {
        let mut c = CHECK.lock().unwrap_or_else(|e| e.into_inner());
        if c.busy {
            return;
        }
        c.busy = true;
    }
    let r = match git(&repo(), &["fetch", "--quiet", "origin"]) {
        Ok((0, ..)) => None,
        Ok((code, _, err)) => Some(format!("git fetch origin が {code} で終わった: {}", err.lines().last().unwrap_or(""))),
        Err(e) => Some(e),
    };
    let mut c = CHECK.lock().unwrap_or_else(|e| e.into_inner());
    c.busy = false;
    c.at = Some(now_ms() as u64);
    c.error = r;
}

/// 裏で fetch を始める（もう動いていれば何もしない）
fn kick() {
    if CHECK.lock().unwrap_or_else(|e| e.into_inner()).busy {
        return;
    }
    let _ = std::thread::Builder::new().name("update-fetch".into()).spawn(fetch_once);
}

/// 起動のときに呼ぶ。欄と点を出さない版では何もしない
pub(crate) fn start() {
    if !wanted(app_id(), env("FC_UPDATE").as_deref()) {
        return;
    }
    let _ = std::thread::Builder::new().name("update-check".into()).spawn(|| {
        std::thread::sleep(FIRST_DELAY);
        loop {
            fetch_once();
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

// ---------- 更新を走らせる ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum Run {
    /// 走らせていない（前の記録も無い）
    Idle,
    /// 走っている
    Running { started_at: u64 },
    /// 終わった。ok は終了コードが 0 か。at は終わった時刻（update-run.exit の文字列、無ければ空）
    Finished { ok: bool, code: Option<i32>, at: String, tail: Vec<String> },
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);

/// 走らせるシェルの本文。$1 が本体の checkout、$2 が update-run.exit。fetch してから、origin/main の release-stable.sh と
/// stable-lib.sh を一時の場所に取り出して走らせ、終わりを $2 に書く。
/// 本体の checkout の作業ツリーのスクリプトは走らせない。ローカルの main は pull されずに古いことがあり、
/// 新しいスクリプトの直しが更新に入らなかった（#299）。本体の checkout の作業ツリーとブランチには触らない。
/// 取り出したスクリプトは git の外にあるので、リポジトリの場所は CT_REPO で渡す
const WRAPPER: &str = r#"
set -o pipefail
echo "== $(date '+%Y-%m-%d %H:%M:%S') 更新を始める（pid $$）"
echo "bunx: $(command -v bunx || echo 見つからない)"
echo "cargo: $(command -v cargo || echo 見つからない)"
code=1
if ! git -C "$1" fetch origin; then
  echo "git fetch origin に失敗した" >&2
elif ! tmp="$(mktemp -d "${TMPDIR:-/tmp}/claude-town-update.XXXXXX")"; then
  echo "スクリプトを取り出す一時の場所を作れない" >&2
else
  if git -C "$1" archive origin/main scripts/release-stable.sh scripts/stable-lib.sh | tar -x -C "$tmp" \
    && [ -x "$tmp/scripts/release-stable.sh" ] && [ -f "$tmp/scripts/stable-lib.sh" ]; then
    echo "origin/main のスクリプトを取り出した: $tmp"
    CT_REPO="$1" "$tmp/scripts/release-stable.sh" origin/main
    code=$?
  else
    echo "origin/main から release-stable.sh と stable-lib.sh を取り出せない" >&2
  fi
  rm -rf "$tmp"
fi
echo "== $(date '+%Y-%m-%d %H:%M:%S') 終わった（終了コード ${code}）"
echo "$(date '+%Y-%m-%d %H:%M:%S') $code" > "$2"
exit "$code"
"#;

/// cmd をアプリから切り離して起動する。新しいセッション（setsid）にし、標準入力は /dev/null、
/// 標準出力と標準エラーは log（書き足し）にする。0〜2 以外のファイル記述子には exec で閉じる印を付ける
/// （端末の PTY や single-instance のソケットを、スクリプトとその先の新しい安定版に渡さない）
pub(crate) fn spawn_detached(cmd: &mut Command, log: &Path) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;
    let out = fs::OpenOptions::new().create(true).append(true).open(log)?;
    let err = out.try_clone()?;
    cmd.stdin(Stdio::null()).stdout(out).stderr(err);
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // 閉じずに印だけ付ける（std が exec の失敗を伝えるのに使うパイプは、もともと印が付いている）
            let max = match libc::sysconf(libc::_SC_OPEN_MAX) {
                n if n > 0 => (n as i32).min(65536),
                _ => 10240,
            };
            for fd in 3..max {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags != -1 && flags & libc::FD_CLOEXEC == 0 {
                    libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                }
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// 更新を始める。走らせられないときは理由を返す。始めたら、終わるのを裏のスレッドで待つ
pub(crate) fn begin() -> Result<(), String> {
    if !wanted(app_id(), env("FC_UPDATE").as_deref()) {
        return Err("この版では更新を走らせない".into());
    }
    run_allowed(app_id(), env("CT_DEST_DIR").as_deref(), env("CT_STABLE_HOME").as_deref(), env("FC_UPDATE_REPO").as_deref())?;
    let repo = repo();
    // 走らせるスクリプトは origin/main から取り出すので、作業ツリーのスクリプトの有無は見ない（#299）
    if !repo.join(".git").exists() {
        return Err(format!("git のリポジトリではない: {}", repo.display()));
    }
    {
        let mut r = RUN.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*r, Some(Run::Running { .. })) {
            return Err("もう走っている".into());
        }
        *r = Some(Run::Running { started_at: now_ms() as u64 });
    }
    let fail = |msg: String| {
        *RUN.lock().unwrap_or_else(|e| e.into_inner()) = Some(Run::Finished { ok: false, code: None, at: String::new(), tail: vec![msg.clone()] });
        msg
    };
    let state = stable_home();
    fs::create_dir_all(&state).map_err(|e| fail(format!("置き場を作れない: {}: {e}", state.display())))?;
    let log = state.join("update-run.log");
    let exit = state.join("update-run.exit");
    // 前の記録を消してから始める（前の終わりを今回の終わりと取り違えない）
    let _ = fs::remove_file(&exit);
    let _ = fs::write(&log, "");
    let path = env("FC_UPDATE_PATH").unwrap_or_else(|| script_path(crate::pty::login_path().as_deref(), &home()));
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-c").arg(WRAPPER).arg("update-run").arg(&repo).arg(&exit).env("PATH", path).current_dir(&repo);
    let child = spawn_detached(&mut cmd, &log).map_err(|e| fail(format!("スクリプトを起動できない: {e}")))?;
    let pid = child.id();
    eprintln!("[update] 更新を始めた: pid {pid}、出力 {}", log.display());
    let _ = std::thread::Builder::new().name("update-run".into()).spawn(move || wait_run(child, log, exit));
    Ok(())
}

/// 走らせたスクリプトの終わりを待つ。ふつうはスクリプトがこのアプリを終わらせるので、ここまで来るのは失敗したときか、
/// 入れ先を差し替えて走らせたとき
fn wait_run(mut child: Child, log: PathBuf, exit: PathBuf) {
    let code = child.wait().ok().and_then(|s| s.code());
    let tail = tail_lines(&fs::read_to_string(&log).unwrap_or_default(), TAIL);
    let at = fs::read_to_string(&exit).ok().and_then(|s| parse_exit_file(&s)).map(|(at, _)| at).unwrap_or_default();
    *RUN.lock().unwrap_or_else(|e| e.into_inner()) = Some(Run::Finished { ok: code == Some(0), code, at, tail });
}

/// このアプリが走らせていないときの記録（前の起動で走らせた更新の終わり）
fn last_run(state: &Path) -> Run {
    let Some((at, code)) = fs::read_to_string(state.join("update-run.exit")).ok().and_then(|s| parse_exit_file(&s)) else {
        return Run::Idle;
    };
    let tail = tail_lines(&fs::read_to_string(state.join("update-run.log")).unwrap_or_default(), TAIL);
    Run::Finished { ok: code == 0, code: Some(code), at, tail }
}

// ---------- 画面に渡す ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    /// 本体の checkout の場所
    pub repo: String,
    pub branch: &'static str,
    /// 今の版（current.ref）。読めなければ None で、理由は current_error
    pub current: Option<Current>,
    pub current_error: Option<String>,
    /// origin/main の sha
    pub remote: Option<String>,
    pub compare: Option<Compare>,
    pub compare_error: Option<String>,
    /// 更新がある（origin/main が今の版の子孫で、同じでない）。歯車の点はこれで出す
    pub available: bool,
    /// 最後に fetch を終えた時刻（ms）と、その失敗の理由
    pub checked_at: Option<u64>,
    pub check_error: Option<String>,
    pub checking: bool,
    pub run: Run,
}

fn status_now() -> Status {
    let repo = repo();
    let state = stable_home();
    let (current, current_error) = match fs::read_to_string(state.join("current.ref")) {
        Ok(s) => match parse_current_ref(&s) {
            Some(c) => (Some(c), None),
            None => (None, Some(format!("current.ref の形が読めない: {}", s.trim()))),
        },
        Err(e) => (None, Some(format!("current.ref を読めない: {e}"))),
    };
    let (remote, compare, compare_error) = match &current {
        Some(c) => match compare_in(&repo, &c.sha) {
            Ok((r, cmp)) => (Some(r), Some(cmp), None),
            Err(e) => (rev(&repo, BRANCH).ok(), None, Some(e)),
        },
        None => (rev(&repo, BRANCH).ok(), None, None),
    };
    let available = matches!(compare, Some(Compare::Ahead { .. }));
    let (checked_at, check_error, checking) = {
        let c = CHECK.lock().unwrap_or_else(|e| e.into_inner());
        (c.at, c.error.clone(), c.busy)
    };
    let run = RUN.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| last_run(&state));
    Status { repo: repo.to_string_lossy().into_owned(), branch: BRANCH, current, current_error, remote, compare, compare_error, available, checked_at, check_error, checking, run }
}

crate::blocking_command! {
/// 更新の状態。欄と点を出さない版では null。refresh なら、裏で fetch も始める（終わりを待たない）
pub(crate) fn update_status(refresh: bool) -> Result<Option<Status>, String> {
    if !wanted(app_id(), env("FC_UPDATE").as_deref()) {
        return Ok(None);
    }
    if refresh {
        kick();
    }
    Ok(Some(status_now()))
}
}

crate::blocking_command! {
/// 「更新して再起動」。スクリプトを切り離して走らせ、始めたら状態を返す
pub(crate) fn update_run() -> Result<Status, String> {
    begin()?;
    Ok(status_now())
}
}

/// 開発用の引数 --update-run（scripts/test-update-detach.sh が使う）。画面を作らずに更新を走らせ、終わるまで待つ。
/// スクリプトがこのプロセスを終わらせても、スクリプトが最後まで進むかを確かめるのに使う。
/// 安定版の実行ファイルでは断る（ボタンを押さずに本物の更新が走らないように）
pub(crate) fn run_cli() -> i32 {
    if app_id() == STABLE_ID {
        eprintln!("--update-run は開発版の実行ファイルでだけ使う");
        return 2;
    }
    if let Err(e) = begin() {
        eprintln!("{e}");
        return 2;
    }
    println!("pid {}", std::process::id());
    loop {
        std::thread::sleep(Duration::from_millis(200));
        if let Some(Run::Finished { ok, code, .. }) = RUN.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            println!("終わった: {code:?}");
            return if ok { 0 } else { 1 };
        }
    }
}

pub(crate) mod cmd {
    pub use super::update_run::*;
    pub use super::update_status::*;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn wanted_only_stable_or_flag() {
        assert!(wanted(STABLE_ID, None));
        assert!(!wanted("jp.fybe.family-computing.dev", None));
        assert!(!wanted("jp.fybe.family-computing.dev", Some("0")));
        assert!(wanted("jp.fybe.family-computing.dev", Some("1")));
    }

    #[test]
    fn dev_runs_only_with_all_overrides() {
        let dev = "jp.fybe.family-computing.dev";
        assert!(run_allowed(STABLE_ID, None, None, None).is_ok());
        assert!(run_allowed(dev, None, None, None).is_err());
        assert!(run_allowed(dev, Some("/tmp/a"), None, None).is_err());
        assert!(run_allowed(dev, None, Some("/tmp/b"), Some("/tmp/c")).is_err());
        assert!(run_allowed(dev, Some("/tmp/a"), Some("/tmp/b"), None).is_err());
        assert!(run_allowed(dev, Some(""), Some("/tmp/b"), Some("/tmp/c")).is_err());
        assert!(run_allowed(dev, Some("/tmp/a"), Some("/tmp/b"), Some("/tmp/c")).is_ok());
    }

    #[test]
    fn reads_current_ref() {
        let sha = "7d9635899d8590eaa3b73862d432bc64afb0d21a";
        assert_eq!(parse_current_ref(&format!("stable-20261123-2100 {sha}\n")), Some(Current { tag: "stable-20261123-2100".into(), sha: sha.into() }));
        assert_eq!(parse_current_ref(&format!("stable-x {}\n", sha.to_uppercase())).unwrap().sha, sha);
        assert_eq!(parse_current_ref(""), None);
        assert_eq!(parse_current_ref("stable-x"), None);
        assert_eq!(parse_current_ref("stable-x 7d96358"), None);
        assert_eq!(parse_current_ref(&format!("stable-x {sha} extra")), None);
        assert_eq!(parse_current_ref("stable-x zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), None);
    }

    #[test]
    fn compares() {
        assert_eq!(compare("a", "a", true, 0), Compare::Same);
        assert_eq!(compare("a", "b", true, 3), Compare::Ahead { n: 3 });
        assert_eq!(compare("a", "b", false, 0), Compare::Diverged);
        assert_eq!(compare("a", "b", true, 0), Compare::Diverged);
    }

    #[test]
    fn reads_exit_file_and_tail() {
        assert_eq!(parse_exit_file("2026-11-23 21:21:11 0\n"), Some(("2026-11-23 21:21:11".into(), 0)));
        assert_eq!(parse_exit_file("2026-11-23 21:21:11 1"), Some(("2026-11-23 21:21:11".into(), 1)));
        assert_eq!(parse_exit_file(""), None);
        assert_eq!(parse_exit_file("2026-11-23 x"), None);
        assert_eq!(tail_lines("a\n\nb\nc\n", 2), vec!["b", "c"]);
        assert_eq!(tail_lines("a\n", 5), vec!["a"]);
    }

    #[test]
    fn script_path_adds_cargo_and_sbin_once() {
        let h = Path::new("/Users/x");
        assert_eq!(script_path(Some("/a:/usr/sbin"), h), "/a:/usr/sbin:/Users/x/.cargo/bin:/Users/x/.bun/bin");
        assert_eq!(script_path(None, h), "/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.cargo/bin:/Users/x/.bun/bin");
    }

    /// git の一時のリポジトリを作り、2つのコミットを origin/main に見立てる
    fn temp_repo() -> (PathBuf, String, String) {
        let d = std::env::temp_dir().join(format!("fc-update-test-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(&d).unwrap();
        let g = |args: &[&str]| {
            let o = Command::new("git").arg("-C").arg(&d).args(args).output().unwrap();
            assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        g(&["init", "-q"]);
        g(&["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "v1"]);
        let v1 = g(&["rev-parse", "HEAD"]);
        g(&["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "v2"]);
        g(&["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "v3"]);
        let v3 = g(&["rev-parse", "HEAD"]);
        g(&["update-ref", "refs/remotes/origin/main", &v3]);
        (d, v1, v3)
    }

    #[test]
    fn compares_in_a_real_repo() {
        let (d, v1, v3) = temp_repo();
        assert_eq!(compare_in(&d, &v1).unwrap(), (v3.clone(), Compare::Ahead { n: 2 }));
        assert_eq!(compare_in(&d, &v3).unwrap(), (v3.clone(), Compare::Same));
        // 今の版が main に無いコミット
        let o = Command::new("git").arg("-C").arg(&d).args(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit-tree", "-m", "side", &format!("{v1}^{{tree}}")]).output().unwrap();
        let side = String::from_utf8_lossy(&o.stdout).trim().to_string();
        assert_eq!(compare_in(&d, &side).unwrap().1, Compare::Diverged);
        assert!(compare_in(&d, "0000000000000000000000000000000000000000").is_err());
        let _ = fs::remove_dir_all(&d);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fc-update-{name}-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn wait_file(p: &Path, limit: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            if p.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// 落ちる対照: 出力をパイプにして読み手が居なくなると（アプリが終わったときと同じ）、子は次の echo で SIGPIPE で落ち、最後まで進まない
    #[test]
    fn piped_child_dies_when_reader_goes_away() {
        let d = temp_dir("piped");
        let marker = d.join("done");
        let mut child = Command::new("/bin/bash")
            .arg("-c")
            .arg(r#"sleep 0.5; echo 途中; echo ok > "$1""#)
            .arg("x")
            .arg(&marker)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        drop(child.stdout.take());
        let st = child.wait().unwrap();
        assert_eq!(st.signal(), Some(libc::SIGPIPE), "{st:?}");
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(&d);
    }

    /// 切り離した子は、新しいセッションの長になり、出力はファイルに書き、親の手を離れても最後まで進む。
    /// 0〜2 以外の記述子（印の無いもの）は子に渡らない
    #[test]
    fn detached_child_is_session_leader_and_finishes() {
        let d = temp_dir("detached");
        let marker = d.join("done");
        let log = d.join("out.log");
        let fds = d.join("fds");
        // 印の無い記述子を1つ開けておく（端末の PTY の master の代わり）
        // 番号は ls が自分で開く 3 番などと重ならないよう、100 番以上の空いている番号をもらう（F_DUPFD の写しには印が付かない）
        let leak = fs::File::open("/dev/null").unwrap();
        let leak_fd = unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&leak), libc::F_DUPFD, 100) };
        assert!(leak_fd >= 100, "記述子を写せない");
        assert_eq!(unsafe { libc::fcntl(leak_fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0, "写した記述子に印が付いている");
        let mut cmd = Command::new("/bin/bash");
        cmd.arg("-c")
            .arg(r#"sleep 0.5; echo 途中; ls /dev/fd > "$2"; echo ok > "$1""#)
            .arg("x")
            .arg(&marker)
            .arg(&fds);
        let child = spawn_detached(&mut cmd, &log).unwrap();
        let pid = child.id() as i32;
        let sid = unsafe { libc::getsid(pid) };
        assert_eq!(sid, pid, "子が新しいセッションの長になっていない");
        assert_ne!(sid, unsafe { libc::getsid(0) });
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);
        drop(child);
        assert!(wait_file(&marker, Duration::from_secs(10)), "子が最後まで進まなかった");
        assert!(fs::read_to_string(&log).unwrap().contains("途中"));
        let open: Vec<String> = fs::read_to_string(&fds).unwrap().lines().map(String::from).collect();
        assert!(!open.contains(&leak_fd.to_string()), "印の無い記述子 {leak_fd} が子に渡った: {open:?}");
        unsafe { libc::close(leak_fd) };
        drop(leak);
        let _ = fs::remove_dir_all(&d);
    }
}
