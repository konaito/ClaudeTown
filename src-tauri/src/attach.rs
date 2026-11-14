// チャットの入力欄に貼る画像とファイル（#64）。
// ccn の送信は文しか受けないので、画像は手元のファイルにして、入力欄にはそのパスを入れる。
// webview の貼り付けの中身からはファイルのパスが取れない（Finder でコピーしたファイルも名前しか見えない）ので、
// macOS の NSPasteboard を osascript（JavaScript for Automation）で読む。
// 公式の tauri-plugin-clipboard-manager は文と画像（RGBA）しか読めず、ファイルの URL を読む口が無い
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// 貼り付けで保存した画像を残す日数。過ぎたものは次に保存するときに消す。
/// 送る前の下書きが指している画像を消さないよう、日単位で長めに取る（仮置き）
const KEEP_DAYS: u64 = 7;
/// 保存する画像の名前の頭。掃除はこの頭のファイルだけを消す
const PREFIX: &str = "paste-";
/// 一時の場所から写したファイルの名前の頭（#69）。掃除は PREFIX と同じく日数で消す
const DROP_PREFIX: &str = "drop-";

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Pasted {
    /// クリップボードにあったファイルのパス（Finder でコピーしたもの）
    pub files: Vec<String>,
    /// クリップボードの画像を保存したファイルのパス
    pub image: Option<String>,
}

/// クリップボードを読む。ファイルがあればそのパスを返す。無くて save_image なら、画像を PNG にして保存し、そのパスを返す
const SCRIPT: &str = r#"
ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const files = [];
  const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $());
  if (urls && !urls.isNil()) {
    for (let i = 0; i < urls.count; i++) {
      const u = urls.objectAtIndex(i);
      if (u.isFileURL) files.push(u.path.js);
    }
  }
  if (files.length) return JSON.stringify({ files });
  const dest = argv[0];
  if (dest) {
    let d = pb.dataForType("public.png");
    if (!d || d.isNil()) {
      const t = pb.dataForType("public.tiff");
      if (t && !t.isNil()) {
        const rep = $.NSBitmapImageRep.imageRepWithData(t);
        if (rep && !rep.isNil()) d = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      }
    }
    if (d && !d.isNil() && d.writeToFileAtomically(dest, true)) return JSON.stringify({ files: [], image: dest });
  }
  return JSON.stringify({ files: [] });
}
"#;

pub fn clipboard(dir: &Path, save_image: bool) -> Result<Pasted, String> {
    let dest = if save_image {
        fs::create_dir_all(dir).map_err(|e| format!("画像の置き場を作れなかった: {e}"))?;
        prune(dir, SystemTime::now());
        Some(dir.join(file_name(SystemTime::now(), fastrand::u16(..))))
    } else {
        None
    };
    let mut cmd = Command::new("/usr/bin/osascript");
    cmd.args(["-l", "JavaScript", "-e", SCRIPT]);
    if let Some(d) = &dest {
        cmd.arg(d);
    }
    let out = cmd.output().map_err(|e| format!("クリップボードを読めなかった: {e}"))?;
    if !out.status.success() {
        return Err(format!("クリップボードを読めなかった: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("クリップボードの読み取りの結果が読めない: {e}"))?;
    Ok(Pasted {
        files: v["files"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default(),
        image: v["image"].as_str().map(String::from),
    })
}

/// paste-20261113-091530-1a2b.png（UTC）。同じ秒に2回貼っても上書きしないよう、乱数を足す
fn file_name(now: SystemTime, rand: u16) -> String {
    let secs = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil(secs / 86400);
    let s = secs % 86400;
    format!("{PREFIX}{y:04}{m:02}{d:02}-{:02}{:02}{:02}-{rand:04x}.png", s / 3600, s / 60 % 60, s % 60)
}

/// 1970-01-01 からの日数を年月日にする（Howard Hinnant の civil_from_days）
fn civil(days: u64) -> (i64, u32, u32) {
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

/// ドロップと貼り付けで受けたファイルのパスのうち、一時の場所にあるものを attachments の置き場（dir）に写し、写した先のパスに替える（#69）。
/// 撮った直後のスクショのサムネは /var/folders/…/T/TemporaryItems/ にあり、ドロップを受けたアプリにしか読む許可が出ない。
/// さらにサムネを使い終わると消える。受け手の Claude が後で読めるよう、受けたその場で写す。
/// ふつうの場所（~/Desktop など）のファイルは元のパスのまま返す。1つでも写せなければ、理由を付けて全体を断る
pub fn stage(dir: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
    let tmp = std::env::var("TMPDIR").ok();
    if !paths.iter().any(|p| is_temporary(p, tmp.as_deref())) {
        return Ok(paths);
    }
    fs::create_dir_all(dir).map_err(|e| format!("写す先の置き場を作れなかった: {e}"))?;
    prune(dir, SystemTime::now());
    let now = SystemTime::now();
    paths
        .into_iter()
        .map(|p| {
            if !is_temporary(&p, tmp.as_deref()) {
                return Ok(p);
            }
            let src = Path::new(&p);
            let base = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let why = |e: String| format!("{base} を写せなかったので入れない（一時の場所のファイルは受け手から読めない）: {e}");
            if src.is_dir() {
                return Err(why("フォルダは写さない".into()));
            }
            let dest = dir.join(staged_name(now, fastrand::u16(..), &base));
            fs::copy(src, &dest).map_err(|e| why(e.to_string()))?;
            // copy は元の更新時刻を引き継ぐ。古いファイルを写すと次の掃除（prune）ですぐ消えるので、写した時刻にする
            fs::File::options().write(true).open(&dest).and_then(|f| f.set_modified(SystemTime::now())).map_err(|e| why(e.to_string()))?;
            Ok(dest.to_string_lossy().into_owned())
        })
        .collect()
}

/// 一時の場所か。/var/folders（$TMPDIR の親）、/tmp、$TMPDIR、TemporaryItems。/private を付けた形も見る
fn is_temporary(path: &str, tmpdir: Option<&str>) -> bool {
    let p = path.strip_prefix("/private").unwrap_or(path);
    if p.starts_with("/var/folders/") || p.starts_with("/tmp/") || path.contains("/TemporaryItems/") {
        return true;
    }
    tmpdir.map(|t| t.strip_prefix("/private").unwrap_or(t).trim_end_matches('/')).filter(|t| !t.is_empty()).is_some_and(|t| p.starts_with(&format!("{t}/")))
}

/// drop-20261114-052054-1a2b-スクリーンショット-2026-11-14-14.20.54.png（UTC）。元の名前の空白は - にする（受け手がパスを読むときに崩れない）
fn staged_name(now: SystemTime, rand: u16, base: &str) -> String {
    let stamp = file_name(now, rand);
    let stamp = stamp.strip_prefix(PREFIX).and_then(|s| s.strip_suffix(".png")).unwrap_or(&stamp);
    let base: String = base.chars().map(|c| if c.is_whitespace() || c == '/' { '-' } else { c }).collect();
    let base = if base.is_empty() { "file".into() } else { base };
    format!("{DROP_PREFIX}{stamp}-{base}")
}

/// KEEP_DAYS より古い、貼り付けで保存した画像と、写したファイルを消す。ほかのファイルには触らない
fn prune(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let keep = Duration::from_secs(KEEP_DAYS * 86400);
    let mut gone = vec![];
    let Ok(rd) = fs::read_dir(dir) else { return gone };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(PREFIX) && name.ends_with(".png")) && !name.starts_with(DROP_PREFIX) {
            continue;
        }
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok()).map(|age| age > keep).unwrap_or(false);
        if old && fs::remove_file(e.path()).is_ok() {
            gone.push(e.path());
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_by_utc_time() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_561_330); // 2026-11-13 09:15:30 UTC
        assert_eq!(file_name(t, 0x1a2b), "paste-20261113-091530-1a2b.png");
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(11016), (2000, 2, 29));
    }

    #[test]
    fn temporary_places() {
        let t = Some("/var/folders/lp/x/T/");
        assert!(is_temporary("/var/folders/lp/x/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット 2026-11-14 14.20.54.png", t));
        assert!(is_temporary("/private/var/folders/lp/x/T/a.png", t));
        assert!(is_temporary("/tmp/a.png", None));
        assert!(is_temporary("/private/tmp/a.png", None));
        assert!(is_temporary("/Volumes/X/.TemporaryItems/../TemporaryItems/a.png", None));
        assert!(is_temporary("/Users/me/tmpdir/a.png", Some("/Users/me/tmpdir")));
        assert!(!is_temporary("/Users/me/Desktop/スクリーンショット 2026-11-14 14.10.00.png", t));
        assert!(!is_temporary("/Users/me/tmpdirx/a.png", Some("/Users/me/tmpdir")));
        assert!(!is_temporary("/tmpx/a.png", None));
    }

    #[test]
    fn stage_copies_only_temporary_files() {
        let root = std::env::temp_dir().join(format!("fc-stage-{}", fastrand::u32(..)));
        let dest = root.join("attachments");
        fs::create_dir_all(&root).unwrap();
        let tmp = root.join("スクリーンショット 2026-11-14 14.20.54.png");
        fs::write(&tmp, b"png").unwrap();
        // 10日前のファイル。写したものは今の時刻になり、次の掃除で消えない
        fs::File::options().write(true).open(&tmp).unwrap().set_modified(SystemTime::now() - Duration::from_secs(10 * 86400)).unwrap();
        let tmp = tmp.to_string_lossy().into_owned();
        // 試験の置き場は $TMPDIR（/var/folders）の下なので、一時の場所として写す。ふつうの場所のパスはそのまま
        let normal = "/Users/me/Desktop/a.png".to_string();
        let out = stage(&dest, vec![normal.clone(), tmp.clone()]).unwrap();
        assert_eq!(out[0], normal);
        assert_ne!(out[1], tmp);
        assert!(out[1].starts_with(&dest.to_string_lossy().into_owned()));
        assert!(out[1].ends_with("-スクリーンショット-2026-11-14-14.20.54.png"), "{}", out[1]);
        assert!(!out[1].contains(' '));
        assert_eq!(fs::read(&out[1]).unwrap(), b"png");
        assert!(prune(&dest, SystemTime::now()).is_empty());
        // 一時の場所が無ければ置き場も作らない
        assert_eq!(stage(&root.join("none"), vec![normal.clone()]).unwrap(), vec![normal]);
        assert!(!root.join("none").exists());
        // 消えたファイルとフォルダは、理由を付けて断る
        let gone = root.join("gone.png").to_string_lossy().into_owned();
        assert!(stage(&dest, vec![gone]).unwrap_err().contains("gone.png を写せなかった"));
        assert!(stage(&dest, vec![root.to_string_lossy().into_owned()]).unwrap_err().contains("フォルダ"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_removes_only_old_pastes() {
        let dir = std::env::temp_dir().join(format!("fc-attach-{}", fastrand::u32(..)));
        fs::create_dir_all(&dir).unwrap();
        for n in ["paste-old.png", "paste-new.png", "other.png", "drop-old-a.pdf"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        // 8日後から見ると、paste- の2つは古い。other.png は消さない
        let later = SystemTime::now() + Duration::from_secs(8 * 86400);
        let mut gone: Vec<String> = prune(&dir, later).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        gone.sort();
        assert_eq!(gone, vec!["drop-old-a.pdf", "paste-new.png", "paste-old.png"]);
        assert!(dir.join("other.png").exists());
        // 今から見ると、何も消さない
        fs::write(dir.join("paste-fresh.png"), b"x").unwrap();
        assert!(prune(&dir, SystemTime::now()).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
