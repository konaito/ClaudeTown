// 端末の claude をどのアカウントで起動するか。cam（Claude Account Manager、~/.cam）がある機械では、`cam auto` と同じく
// `cam usage --json` の best のコマンドで起動する。cam の launcher（~/.cam/bin/<名前>）は `cam sync <名前>` の後に
// CLAUDE_CONFIG_DIR=~/.cam/profiles/<名前> で claude を起動する。ここも同じにする。
// 選び方は ccn の src/engine/account.ts（claude-code-nodes）に合わせた。Claude Town が ccn を通さずに起動するようになったときに抜けていた。
// 選べないとき（cam が無い、落ちる、5秒で返らない、JSON が読めない、best が null）は env を触らず、今まで通りに起動する。
// 例外は新しく立てるときに、cam が「枠の残るコマンドが無い」（choice: none）と答え、次に戻る時刻が先にあるとき。起動をやめて、その時刻を画面に出す（`cam auto` も起動しない）。
// resume は断らない。アプリを開いたときの立て直しで断ると、前回の端末が画面に何も出ずに戻らなくなる。上限のアカウントで立っても、送るまでは害がない
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// cam usage と cam sync を待つ上限。過ぎたら止めて今まで通りにする
const TIMEOUT: Duration = Duration::from_secs(5);
/// 結果を使い回す時間。起動のときの立て直し（台帳の件数だけ続けて起動する）で cam usage を何度も呼ばない。usage の API は 429 を返しやすい（cam の README）
const TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq)]
pub enum Choice {
    /// このプロファイルで起動する。dir は claude に渡す CLAUDE_CONFIG_DIR
    Profile { name: String, dir: PathBuf },
    /// 枠の残るコマンドが無い（choice: none）。いちばん早く戻るコマンドと時刻（epoch 秒）
    None { next: Option<(String, i64)> },
    /// 選ばない。env を触らずに起動する（理由はログに出す）
    Keep(String),
}

/// cam のコマンド名の決まり（cam の valid_name、ccn の NAME）
fn valid_name(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|f| f.is_ascii_lowercase()) && c.all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || x == '_' || x == '-')
}

/// `cam usage --json` の出力から選ぶ。is_dir は、プロファイルのディレクトリがあるか（無いのは --default のコマンドで、env を触らない）
pub fn choose(stdout: &str, profiles: &Path, is_dir: impl Fn(&Path) -> bool) -> Choice {
    let v: serde_json::Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return Choice::Keep("cam usage が JSON を返さなかった".into()),
    };
    let choice = v["choice"].as_str().unwrap_or("?");
    let Some(best) = v["best"].as_str().filter(|b| !b.is_empty()) else {
        if choice == "none" {
            let n = &v["next_available"];
            let next = n["name"].as_str().zip(n["at"].as_i64()).map(|(a, t)| (a.to_string(), t));
            return Choice::None { next };
        }
        return Choice::Keep(format!("cam に使えるコマンドが無い（choice: {choice}）"));
    };
    if !valid_name(best) {
        return Choice::Keep(format!("cam が読めない名前を返した: {best}"));
    }
    // launcher と1字も違わないパスにする。Keychain の項目名がこのパスの sha256 で決まるので、canonicalize や末尾の / で変えない
    let dir = PathBuf::from(format!("{}/{best}", profiles.display()));
    if is_dir(&dir) {
        Choice::Profile { name: best.to_string(), dir }
    } else {
        Choice::Keep(format!("cam の best（{best}）は --default のコマンド"))
    }
}

/// choice: none のとき起動をやめるか。戻る時刻が分かっていて、まだ先のときだけやめる。
/// cam は控え（cached）の 100% を、リセット時刻を過ぎても上限として数えるので、過ぎた時刻なら今まで通り起動する
pub fn refuse_reason(c: &Choice, now: i64) -> Option<String> {
    match c {
        Choice::None { next: Some((name, at)) } if *at > now => {
            Some(format!("使えるアカウントが無い（cam usage）。いちばん早く戻るのは {name}（{}）", local_time(*at)))
        }
        _ => None,
    }
}

/// epoch 秒を、この Mac の時刻で「M/D HH:MM」にする
fn local_time(t: i64) -> String {
    let tt = t as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&tt, &mut tm) }.is_null() {
        return t.to_string();
    }
    format!("{}/{} {:02}:{:02}", tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min)
}

/// cam の実行ファイル。FC_CAM_BIN があればそれ（試験用）、無ければログインシェルの PATH、~/.cam/bin/cam の順に探す。
/// 試験では FC_CAM_BIN が無ければ選ばない（cargo test から本物の cam usage と cam sync を呼ばない）
fn cam_bin(path: Option<&str>) -> Option<PathBuf> {
    if let Ok(b) = std::env::var("FC_CAM_BIN")
        && !b.is_empty() {
            return Some(PathBuf::from(b));
        }
    if cfg!(test) {
        return None;
    }
    let home = crate::home();
    path.unwrap_or("").split(':').filter(|d| !d.is_empty()).map(PathBuf::from).chain([home.join(".cam/bin")]).map(|d| d.join("cam")).find(|c| c.is_file())
}

/// プロファイルの置き場所。launcher と同じ $HOME/.cam/profiles（FC_CAM_PROFILES は試験用）
fn profiles_dir() -> PathBuf {
    match std::env::var("FC_CAM_PROFILES") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => PathBuf::from(format!("{}/.cam/profiles", crate::home().display())),
    }
}

/// 上限つきで実行し、終わったら標準出力と終了コードを返す。過ぎたら止めて Err
fn run(cam: &Path, args: &[&str], path: Option<&str>) -> Result<(String, Option<i32>), String> {
    let mut cmd = std::process::Command::new(cam);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    // cam は bash で jq を呼ぶ。Finder から開いたアプリの PATH には無いことがあるので、claude と同じログインシェルの PATH を渡す
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cam を起動できなかった: {e}"))?;
    let mut out = child.stdout.take().ok_or("cam の出力を読めない")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t0 = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if t0.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cam {} が {}秒で返らなかった", args.join(" "), TIMEOUT.as_secs()));
            }
        }
    };
    Ok((reader.join().unwrap_or_default(), status.code()))
}

fn pick_uncached(cam: &Path, profiles: &Path, path: Option<&str>) -> Choice {
    match run(cam, &["usage", "--json"], path) {
        Err(e) => Choice::Keep(e),
        Ok((_, code)) if code != Some(0) => Choice::Keep(format!("cam usage が {code:?} で終わった")),
        Ok((out, _)) => choose(&out, profiles, |p| p.is_dir()),
    }
}

/// 使い回しの控え。cam とプロファイルの置き場所が同じときだけ使う
static CACHE: Mutex<Option<(PathBuf, PathBuf, Instant, Choice)>> = Mutex::new(None);

/// 選ぶ。cam が無ければ Keep。結果は TTL の間使い回す。同時の呼び出しは錠で1回の cam usage にまとめる
pub fn pick(path: Option<&str>) -> Choice {
    let Some(cam) = cam_bin(path) else { return Choice::Keep("cam が無い".into()) };
    let profiles = profiles_dir();
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((c, p, at, choice)) = g.as_ref()
        && *c == cam && *p == profiles && at.elapsed() < TTL {
            return choice.clone();
        }
    let choice = pick_uncached(&cam, &profiles, path);
    *g = Some((cam, profiles, Instant::now(), choice.clone()));
    choice
}

/// 起動の直前の用意。返すのは claude に渡す CLAUDE_CONFIG_DIR（None なら env を触らない）。起動をやめるときは Err（refuse が true のときだけ。新しく立てるとき）。
/// プロファイルを選んだら launcher と同じく `cam sync <名前>` を掛ける（共有のリンク、MCP、信頼済みフォルダの同期。失敗しても起動は続ける）。
/// 信頼済みフォルダは cam sync が ~/.claude.json と全プロファイルの和をプロファイルに写すので、ccn のように cwd を書き足すことはしない
/// （launcher も書かない。Claude Town は信頼の画面を端末で出す）
pub fn prepare(path: Option<&str>, refuse: bool) -> Result<Option<PathBuf>, String> {
    let choice = pick(path);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    if let Some(why) = refuse_reason(&choice, now).filter(|_| refuse) {
        eprintln!("[account] 起動をやめる: {why}");
        return Err(why);
    }
    match choice {
        Choice::Profile { name, dir } => {
            if let Some(cam) = cam_bin(path) {
                match run(&cam, &["sync", &name], path) {
                    Ok((_, Some(0))) => {}
                    r => eprintln!("[account] cam sync {name} が通らなかった（起動は続ける）: {r:?}"),
                }
            }
            eprintln!("[account] {name} で起動する（{}）", dir.display());
            Ok(Some(dir))
        }
        Choice::None { next } => {
            eprintln!("[account] cam に使えるコマンドが無いが、resume か、戻る時刻が過ぎているか分からないので今まで通り起動する: {next:?}");
            Ok(None)
        }
        Choice::Keep(why) => {
            eprintln!("[account] 今まで通り起動する: {why}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick_of(json: &str, dirs: &[&str]) -> Choice {
        choose(json, Path::new("/h/.cam/profiles"), |p| dirs.iter().any(|d| p == Path::new(d)))
    }

    #[test]
    fn best_with_a_profile_is_the_launcher_path() {
        let c = pick_of(r#"{"best":"ceo","choice":"normal","next_available":null}"#, &["/h/.cam/profiles/ceo"]);
        // ~/.cam/bin/ceo の CLAUDE_CONFIG_DIR="/Users/<人>/.cam/profiles/ceo" と同じ形（末尾の / なし）
        assert_eq!(c, Choice::Profile { name: "ceo".into(), dir: PathBuf::from("/h/.cam/profiles/ceo") });
        if let Choice::Profile { dir, .. } = c {
            assert_eq!(dir.to_str().unwrap(), "/h/.cam/profiles/ceo");
        }
    }

    #[test]
    fn a_default_command_keeps_the_env() {
        assert!(matches!(pick_of(r#"{"best":"main","choice":"normal"}"#, &[]), Choice::Keep(_)));
    }

    #[test]
    fn a_bad_name_keeps_the_env() {
        assert!(matches!(pick_of(r#"{"best":"../x","choice":"normal"}"#, &["/h/.cam/profiles/../x"]), Choice::Keep(_)));
        assert!(matches!(pick_of(r#"{"best":"Ceo","choice":"normal"}"#, &["/h/.cam/profiles/Ceo"]), Choice::Keep(_)));
    }

    #[test]
    fn no_json_or_no_best_keeps_the_env() {
        assert!(matches!(pick_of("cam: error", &[]), Choice::Keep(_)));
        assert!(matches!(pick_of(r#"{"best":null,"choice":"unknown","next_available":null}"#, &[]), Choice::Keep(_)));
        assert!(matches!(pick_of(r#"{"best":"","choice":"normal"}"#, &[]), Choice::Keep(_)));
    }

    #[test]
    fn none_carries_the_next_account() {
        let c = pick_of(r#"{"best":null,"choice":"none","next_available":{"name":"cto","at":1795400000}}"#, &[]);
        assert_eq!(c, Choice::None { next: Some(("cto".into(), 1795400000)) });
        assert_eq!(pick_of(r#"{"best":null,"choice":"none","next_available":null}"#, &[]), Choice::None { next: None });
    }

    #[test]
    fn refuse_only_when_the_next_time_is_ahead() {
        let c = Choice::None { next: Some(("cto".into(), 2000)) };
        let why = refuse_reason(&c, 1000).unwrap();
        assert!(why.contains("cto"), "{why}");
        // 戻る時刻を過ぎている（cam の控えが古い）、時刻が分からない、選べたときは断らない
        assert_eq!(refuse_reason(&c, 2000), None);
        assert_eq!(refuse_reason(&Choice::None { next: None }, 1000), None);
        assert_eq!(refuse_reason(&Choice::Keep("x".into()), 1000), None);
        assert_eq!(refuse_reason(&Choice::Profile { name: "a".into(), dir: "/a".into() }, 1000), None);
    }

    #[test]
    fn a_failing_or_slow_cam_keeps_the_env() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fc-account-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fail = dir.join("fail");
        std::fs::write(&fail, "#!/bin/sh\necho '{\"best\":\"x\"}'\nexit 3\n").unwrap();
        let slow = dir.join("slow");
        std::fs::write(&slow, "#!/bin/sh\nexec sleep 30\n").unwrap();
        for f in [&fail, &slow] {
            std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(matches!(pick_uncached(&fail, &dir, None), Choice::Keep(_)));
        let t0 = Instant::now();
        assert!(matches!(pick_uncached(&slow, &dir, None), Choice::Keep(_)));
        assert!(t0.elapsed() < TIMEOUT + Duration::from_secs(2), "5秒を超えて待った: {:?}", t0.elapsed());
        assert!(matches!(pick_uncached(&dir.join("missing"), &dir, None), Choice::Keep(_)));
    }
}
