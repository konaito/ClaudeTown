// ネットが切れても町と会話を出すための保存（オフラインのキャッシュ）。
// 別の機械の町（/n/<peer>/api）は、Cloudflare を通るので、ネットが切れると一覧も会話も読めない。
// 手元のノードの peers も Cloudflare の API から引くので、切れると町の選択肢が消える。
// そこで、読めたときに次の3つを保存し、読めないときに出す。置き場所はアプリ側（fc_path の Scope::App の cache/）で、
// 開発版と安定版で分かれる。安定版はこのファイルを読まない。
// - conv/<町>__<セッション>.json  会話の欄の最後の KEEP_MESSAGES 件（画面に出す形）。開いたセッションだけ
// - towns/<町>.json               町の一覧（snapshot の agents）
// - peers.json                    ccn の peers
// 形式はどれも { "v": 1, "savedAt": <ms>, ...中身 }。v が違うものは読まない。

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const VERSION: u64 = 1;
/// 会話の保存を残す日数と件数。開いていないセッションの分は、起動のたびにこれを超えた古い順に消す
pub const CONV_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
pub const CONV_MAX_FILES: usize = 300;

/// 町の名前。手元の町は "_local"
pub fn town(peer: &Option<String>) -> String {
    safe(peer.as_deref().filter(|p| !p.is_empty()).unwrap_or("_local"))
}

/// ファイル名に使えない文字を _ にする（peer と session_id は外から来る値なので、/ や .. を通さない）
fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(80).collect();
    if t.is_empty() { "_".into() } else { t }
}

pub fn conv_file(dir: &Path, peer: &Option<String>, session_id: &str) -> PathBuf {
    dir.join("conv").join(format!("{}__{}.json", town(peer), safe(session_id)))
}

pub fn town_file(dir: &Path, peer: &Option<String>) -> PathBuf {
    dir.join("towns").join(format!("{}.json", town(peer)))
}

pub fn peers_file(dir: &Path) -> PathBuf {
    dir.join("peers.json")
}

/// 一時ファイルに書いてから置き換える。同じファイルへの書き込みが重なっても、半端な中身を読まないよう、一時ファイルの名前は呼ぶたびに変える
pub fn write(path: &Path, body: Value) -> Result<(), String> {
    let mut body = body;
    body["v"] = json!(VERSION);
    body["savedAt"] = json!(now_ms());
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}-{}", std::process::id(), fastrand::u64(..)));
    fs::write(&tmp, serde_json::to_vec(&body).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn read(path: &Path) -> Option<Value> {
    let v: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (v["v"].as_u64() == Some(VERSION)).then_some(v)
}

/// 画面へ渡す、保存してあった会話
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConvCache {
    pub saved_at: u64,
    pub total: u64,
    pub items: Vec<Value>,
}

pub fn save_conv(dir: &Path, peer: &Option<String>, session_id: &str, total: u64, items: &[Value]) -> Result<(), String> {
    write(&conv_file(dir, peer, session_id), json!({ "total": total, "items": items }))
}

pub fn load_conv(dir: &Path, peer: &Option<String>, session_id: &str) -> Option<ConvCache> {
    let v = read(&conv_file(dir, peer, session_id))?;
    Some(ConvCache {
        saved_at: v["savedAt"].as_u64().unwrap_or(0),
        total: v["total"].as_u64().unwrap_or(0),
        items: v["items"].as_array().cloned().unwrap_or_default(),
    })
}

pub fn remove_conv(dir: &Path, peer: &Option<String>, session_id: &str) {
    let _ = fs::remove_file(conv_file(dir, peer, session_id));
}

/// 会話の保存のうち、max_age より古いものと、新しい順に max_files を超えたものを消す。消した数を返す。
/// 「ccn の一覧に無いから消す」はしない（一覧が一瞬空になることがあり、そのときに全部消える）
pub fn prune_conv(dir: &Path, max_age: Duration, max_files: usize) -> usize {
    let Ok(rd) = fs::read_dir(dir.join("conv")) else { return 0 };
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .map(|p| (fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
        .collect();
    // 新しい順
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut n = 0;
    for (i, (t, p)) in files.iter().enumerate() {
        let old = now.duration_since(*t).map(|d| d > max_age).unwrap_or(false);
        // 書きかけで残った一時ファイル（.tmp…）も、古ければ消える
        if old || i >= max_files {
            if fs::remove_file(p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fc-offline-{name}-{}-{}", std::process::id(), fastrand::u64(..)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn conv_round_trip_per_town_and_session() {
        let d = tmpdir("conv");
        let items = vec![json!({ "role": "user", "text": "a", "n": 0 }), json!({ "role": "assistant", "text": "b", "n": 1 })];
        save_conv(&d, &Some("incertotech".into()), "s1", 2, &items).unwrap();
        let c = load_conv(&d, &Some("incertotech".into()), "s1").unwrap();
        assert_eq!(c.items, items);
        assert_eq!(c.total, 2);
        assert!(c.saved_at > 0);
        // 町が違えば別のもの。手元の町（None と空文字）は同じ
        assert!(load_conv(&d, &None, "s1").is_none());
        save_conv(&d, &None, "s1", 1, &items[..1]).unwrap();
        assert_eq!(load_conv(&d, &Some(String::new()), "s1").unwrap().items.len(), 1);
        remove_conv(&d, &Some("incertotech".into()), "s1");
        assert!(load_conv(&d, &Some("incertotech".into()), "s1").is_none());
        // 画面へは camelCase で渡す
        assert_eq!(serde_json::to_value(&c).unwrap()["savedAt"], json!(c.saved_at));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn names_from_outside_stay_inside_the_dir() {
        let d = Path::new("/x");
        assert_eq!(conv_file(d, &Some("../../etc".into()), "a/b"), PathBuf::from("/x/conv/______etc__a_b.json"));
        assert_eq!(town_file(d, &None), PathBuf::from("/x/towns/_local.json"));
    }

    #[test]
    fn other_versions_are_not_read() {
        let d = tmpdir("ver");
        let p = d.join("peers.json");
        fs::write(&p, r#"{"v":0,"peers":[]}"#).unwrap();
        assert!(read(&p).is_none());
        write(&p, json!({ "peers": [] })).unwrap();
        assert!(read(&p).is_some());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn prune_keeps_the_newest_files() {
        let d = tmpdir("prune");
        for i in 0..5 {
            save_conv(&d, &None, &format!("s{i}"), 0, &[]).unwrap();
            // 更新時刻の順をはっきりさせる
            std::thread::sleep(Duration::from_millis(15));
        }
        assert_eq!(prune_conv(&d, CONV_MAX_AGE, 3), 2);
        assert!(load_conv(&d, &None, "s4").is_some() && load_conv(&d, &None, "s2").is_some());
        assert!(load_conv(&d, &None, "s0").is_none() && load_conv(&d, &None, "s1").is_none());
        // 古さだけで消す
        assert_eq!(prune_conv(&d, Duration::ZERO, 100), 3);
        fs::remove_dir_all(&d).ok();
    }
}
