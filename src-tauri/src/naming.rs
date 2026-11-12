//! カードと世帯の名前の決め方。名前は、そのセッションが作業しているプロジェクトの名前にする。
//! プロジェクトの名前は、リポジトリの本体のディレクトリの名前（例 family-computing）。
//! 同じ規則を src/model.ts（cardNames、projectFromPath、isDispatchPlace）にも書いてある。
//! 試験の事例は src/naming-cases.json にまとめ、cargo test と bun test の両方で読む。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 振り分けの場所のうち、ホーム（/Users/<名前> か /home/<名前>）からの相対の分。空はホームそのもの。
/// ここで動くセッションは依頼を振り分けるだけなので、cwd の名前（meta など）を名前にしない
pub const DISPATCH_UNDER_HOME: [&str; 4] = ["", "Documents", "Documents/meta", ".local/share/ccn/lobby"];
/// 振り分けの場所のうち、絶対パスの分
pub const DISPATCH_ABSOLUTE: [&str; 4] = ["/", "/tmp", "/private/tmp", "/root"];

fn segs(p: &str) -> Vec<&str> {
    p.split('/').filter(|s| !s.is_empty()).collect()
}

/// cwd が振り分けの場所か。パスの形だけで決める（別の機械の cwd でも同じ答えにするため、手元のホームは見ない）
pub fn is_dispatch_place(cwd: &str) -> bool {
    let s = segs(cwd);
    let abs = format!("/{}", s.join("/"));
    if DISPATCH_ABSOLUTE.contains(&abs.as_str()) {
        return true;
    }
    if s.len() >= 2 && (s[0] == "Users" || s[0] == "home") {
        let rest = &s[2..];
        return DISPATCH_UNDER_HOME.iter().any(|d| segs(d) == rest);
    }
    false
}

/// パスの形だけで出すプロジェクトの名前。`<名前>.wt/<x>` なら <名前>、それ以外は最後の名前
pub fn project_from_path(cwd: &str) -> Option<String> {
    let s = segs(cwd);
    if s.len() >= 2 {
        if let Some(base) = s[s.len() - 2].strip_suffix(".wt").filter(|b| !b.is_empty()) {
            return Some(base.to_string());
        }
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

/// cwd のプロジェクトの名前。local（この機械の cwd）なら .git を読み、別の機械の町ならパスの形だけで決める
pub fn project_of(cwd: &str, local: bool) -> Option<String> {
    if local {
        if let Some(p) = project_from_git(cwd) {
            return Some(p);
        }
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
    #[serde(default)]
    pub parent: Option<String>,
    /// project_of で出した名前。無ければ project_from_path で出す
    #[serde(default)]
    pub project: Option<String>,
    /// エージェントが hook（scripts/hook.py name）で付けた名前（houses.json の by=agent）
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub started_at: u64,
}

/// カードの名前を全員分決める。
/// 1. cwd が無ければ ccn の題名、それも無ければ ID の先頭8字
/// 2. cwd が振り分けの場所でなければ、cwd のプロジェクトの名前
/// 3. 振り分けの場所なら、a. 子孫のプロジェクト（振り分けの場所にいる子孫は数えない）で一番多いもの。同数なら先に始まった子孫の分
///    b. エージェントが hook で付けた名前、c. cwd の最後の名前
pub fn card_names(ws: &[Who]) -> HashMap<String, String> {
    let ids: HashSet<&str> = ws.iter().map(|w| w.id.as_str()).collect();
    let mut kids: HashMap<&str, Vec<&Who>> = HashMap::new();
    for w in ws {
        if let Some(p) = w.parent.as_deref().filter(|p| *p != w.id && ids.contains(p)) {
            kids.entry(p).or_default().push(w);
        }
    }
    for v in kids.values_mut() {
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
    }
    let own = |w: &Who| -> Option<String> {
        let cwd = w.cwd.as_deref().filter(|c| !c.is_empty())?;
        if is_dispatch_place(cwd) {
            return None;
        }
        w.project.clone().filter(|p| !p.is_empty()).or_else(|| project_from_path(cwd))
    };
    let mut out = HashMap::new();
    for w in ws {
        let cwd = w.cwd.as_deref().filter(|c| !c.is_empty());
        let name = match cwd {
            None => w.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| w.id.chars().take(8).collect()),
            Some(c) if !is_dispatch_place(c) => own(w).unwrap_or_else(|| w.id.chars().take(8).collect()),
            Some(c) => {
                // 子孫を、先に始まった順（幅優先）に数える
                let mut order: Vec<String> = vec![];
                let mut count: HashMap<String, usize> = HashMap::new();
                let mut seen: HashSet<&str> = HashSet::from([w.id.as_str()]);
                let mut queue: Vec<&Who> = kids.get(w.id.as_str()).cloned().unwrap_or_default();
                let mut i = 0;
                while i < queue.len() {
                    let d = queue[i];
                    i += 1;
                    if !seen.insert(d.id.as_str()) {
                        continue;
                    }
                    if let Some(p) = own(d) {
                        if !count.contains_key(&p) {
                            order.push(p.clone());
                        }
                        *count.entry(p).or_default() += 1;
                    }
                    queue.extend(kids.get(d.id.as_str()).cloned().unwrap_or_default());
                }
                let best = order.iter().fold(None::<&String>, |b, p| match b {
                    Some(q) if count[q] >= count[p] => Some(q),
                    _ => Some(p),
                });
                best.cloned()
                    .or_else(|| w.agent_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(String::from))
                    .or_else(|| project_from_path(c))
                    .unwrap_or_else(|| "/".into())
            }
        };
        out.insert(w.id.clone(), name);
    }
    out
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
    fn dispatch_places() {
        for p in ["/Users/x/Documents/meta", "/Users/x/Documents/meta/", "/Users/x", "/home/x/.local/share/ccn/lobby", "/tmp", "/private/tmp", "/", "/Users/x/Documents"] {
            assert!(is_dispatch_place(p), "{p}");
        }
        for p in ["/Users/x/Documents/meta.wt/delegation", "/Users/x/Documents/family-computing", "/tmp/foo", "/Users/x/Documents/meta/sub"] {
            assert!(!is_dispatch_place(p), "{p}");
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
}
