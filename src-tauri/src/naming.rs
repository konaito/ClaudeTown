//! カードと世帯の名前の決め方。名前は、そのセッションが作業しているプロジェクトの名前にする。
//! プロジェクトの名前は、リポジトリの本体のディレクトリの名前（例 family-computing）。
//! 同じ規則を src/model.ts（cardNames、projectFromPath）にも書いてある。
//! 試験の事例は src/naming-cases.json にまとめ、cargo test と bun test の両方で読む。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn segs(p: &str) -> Vec<&str> {
    p.split('/').filter(|s| !s.is_empty()).collect()
}

/// パスの形だけで出すプロジェクトの名前。`<名前>.wt/<x>` なら <名前>、それ以外は最後の名前
pub fn project_from_path(cwd: &str) -> Option<String> {
    let s = segs(cwd);
    if s.len() >= 2
        && let Some(base) = s[s.len() - 2].strip_suffix(".wt").filter(|b| !b.is_empty()) {
            return Some(base.to_string());
        }
    s.last().map(|x| x.to_string())
}

/// git の worktree なら、本体のディレクトリの名前。`.git` がファイルのときだけ見る（ディレクトリなら cwd が本体）
pub fn project_from_git(cwd: &str) -> Option<String> {
    let dot = Path::new(cwd).join(".git");
    if !dot.is_file() {
        return None;
    }
    let text = fs::read_to_string(&dot).ok()?;
    let raw = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gitdir = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { Path::new(cwd).join(raw) };
    // 共通のディレクトリ（本体の .git）。commondir があればそれ、無ければ worktrees/<x> の2つ上
    let common = match fs::read_to_string(gitdir.join("commondir")) {
        Ok(c) => {
            let c = c.trim();
            if Path::new(c).is_absolute() { PathBuf::from(c) } else { gitdir.join(c) }
        }
        Err(_) if gitdir.parent().and_then(|p| p.file_name()).map(|n| n == "worktrees").unwrap_or(false) => {
            gitdir.parent()?.parent()?.to_path_buf()
        }
        // submodule などは、パスの形で決める
        Err(_) => return None,
    };
    let common = normalize(&common);
    let name = common.file_name()?.to_string_lossy().to_string();
    if name == ".git" {
        Some(common.parent()?.file_name()?.to_string_lossy().to_string())
    } else {
        // 素のリポジトリ（foo.git）
        Some(name.strip_suffix(".git").unwrap_or(&name).to_string()).filter(|n| !n.is_empty())
    }
}

/// `..` と `.` を文字の上で畳む（commondir は "../.." のような相対で入っている）
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// project_from_git と同じ答えを返す。`.git` のファイルの更新時刻、大きさ、inode が前に読んだときと同じなら、読まずに前の答えを返す（#11）。
/// snapshot は一覧を取るたびに、セッションごとに `.git` と commondir を読んでいた。
/// worktree を作り直すと `.git` も書き直されるので、commondir だけが変わる場合は考えない
fn project_from_git_cached(cwd: &str) -> Option<String> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (super::FileStamp, Option<String>)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    // .git がファイルでなければ（無い、本体のディレクトリ）、project_from_git も読まずに None を返す
    let Some(meta) = fs::metadata(Path::new(cwd).join(".git")).ok().filter(|m| m.is_file()) else {
        cache.lock().unwrap_or_else(|e| e.into_inner()).remove(cwd);
        return None;
    };
    let st = super::stamp_of(&meta);
    if let Some((s, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(cwd)
        && *s == st && st.modified.is_some() {
            return v.clone();
        }
    let v = project_from_git(cwd);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(cwd.to_string(), (st, v.clone()));
    v
}

/// cwd のプロジェクトの名前。local（この機械の cwd）なら .git を読み、別の機械の町ならパスの形だけで決める
pub fn project_of(cwd: &str, local: bool) -> Option<String> {
    if local
        && let Some(p) = project_from_git_cached(cwd) {
            return Some(p);
        }
    project_from_path(cwd)
}

/// 名前を決めるのに使う、1つのセッションの材料
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    pub id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// project_of で出した名前。無ければ project_from_path で出す
    #[serde(default)]
    pub project: Option<String>,
}

/// カードの名前を全員分決める。世帯の名前は根のカードの名前なので、親のプロジェクトの名前になる。
/// 1. cwd が無ければ ccn の題名、それも無ければ ID の先頭8字
/// 2. cwd があれば、cwd のプロジェクトの名前（worktree は本体の名前。~/Documents 直下、ホーム、/tmp なども cwd の最後の名前）。
///    子孫の cwd や、エージェントが付けた名前（houses.json）は見ない
pub fn card_names(ws: &[Who]) -> HashMap<String, String> {
    ws.iter()
        .map(|w| {
            let id8 = || w.id.chars().take(8).collect::<String>();
            let name = match w.cwd.as_deref().filter(|c| !c.is_empty()) {
                None => w.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(id8),
                Some(c) => w
                    .project
                    .clone()
                    .filter(|p| !p.is_empty())
                    .or_else(|| project_from_path(c))
                    .unwrap_or_else(|| "/".into()),
            };
            (w.id.clone(), name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        sessions: Vec<Who>,
        expect: HashMap<String, String>,
    }

    /// src/naming-cases.json の事例（bun test も同じものを読む）
    #[test]
    fn shared_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../src/naming-cases.json")).unwrap();
        assert!(cases.len() >= 6);
        for c in cases {
            let got = card_names(&c.sessions);
            for (id, want) in &c.expect {
                assert_eq!(got.get(id), Some(want), "{}: {id}", c.name);
            }
        }
    }

    #[test]
    fn project_from_worktree_git_file() {
        let base = std::env::temp_dir().join(format!("ct-naming-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        // 本体 base/proj/.git、worktree base/elsewhere/wt1（名前の形では本体が分からない）
        let wt_git = base.join("proj/.git/worktrees/wt1");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = base.join("elsewhere/wt1");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        assert_eq!(project_of(wt.to_str().unwrap(), true).as_deref(), Some("proj"));
        // 別の機械の町では .git を読まない
        assert_eq!(project_of(wt.to_str().unwrap(), false).as_deref(), Some("wt1"));
        // commondir が無くても worktrees/<x> の形なら本体が分かる。gitdir が相対でもよい
        fs::remove_file(wt_git.join("commondir")).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../../proj/.git/worktrees/wt1\n").unwrap();
        assert_eq!(project_from_git(wt.to_str().unwrap()).as_deref(), Some("proj"));
        // .git がディレクトリ（本体）なら読まずにパスの形で決める
        assert_eq!(project_from_git(base.join("proj").to_str().unwrap()), None);
        assert_eq!(project_of(base.join("proj").to_str().unwrap(), true).as_deref(), Some("proj"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn project_from_git_is_read_again_only_when_dot_git_changes() {
        let base = std::env::temp_dir().join(format!("ct-naming-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for p in ["a/.git/worktrees/w", "b/.git/worktrees/w", "elsewhere/w"] {
            fs::create_dir_all(base.join(p)).unwrap();
        }
        let wt = base.join("elsewhere/w");
        let cwd = wt.to_str().unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", base.join("a/.git/worktrees/w").display())).unwrap();
        assert_eq!(project_from_git_cached(cwd).as_deref(), Some("a"));
        // .git を書き直したら（別の本体を指す）、読み直す。書き直しは別のファイルからの付け替えで、inode が変わる
        let tmp = base.join("elsewhere/git.tmp");
        fs::write(&tmp, format!("gitdir: {}\n", base.join("b/.git/worktrees/w").display())).unwrap();
        fs::rename(&tmp, wt.join(".git")).unwrap();
        assert_eq!(project_from_git_cached(cwd).as_deref(), Some("b"));
        // .git が消えたら None
        fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(project_from_git_cached(cwd), None);
        let _ = fs::remove_dir_all(&base);
    }
}
