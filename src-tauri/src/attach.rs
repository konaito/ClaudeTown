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

/// KEEP_DAYS より古い、貼り付けで保存した画像を消す。ほかのファイルには触らない
fn prune(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let keep = Duration::from_secs(KEEP_DAYS * 86400);
    let mut gone = vec![];
    let Ok(rd) = fs::read_dir(dir) else { return gone };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PREFIX) || !name.ends_with(".png") {
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
    fn prune_removes_only_old_pastes() {
        let dir = std::env::temp_dir().join(format!("fc-attach-{}", fastrand::u32(..)));
        fs::create_dir_all(&dir).unwrap();
        for n in ["paste-old.png", "paste-new.png", "other.png"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        // 8日後から見ると、paste- の2つは古い。other.png は消さない
        let later = SystemTime::now() + Duration::from_secs(8 * 86400);
        let mut gone: Vec<String> = prune(&dir, later).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        gone.sort();
        assert_eq!(gone, vec!["paste-new.png", "paste-old.png"]);
        assert!(dir.join("other.png").exists());
        // 今から見ると、何も消さない
        fs::write(dir.join("paste-fresh.png"), b"x").unwrap();
        assert!(prune(&dir, SystemTime::now()).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
