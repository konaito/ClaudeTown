//! 場所に連携しているリポジトリの名前（owner/repo）を、.git/config の remote から読む。読むだけで、書き換えない。
//! 新しい世帯のペイン（#99）の一覧が使う。認証情報（https://user:token@…）は URL から捨て、owner/repo だけを返す。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// remote の URL から owner/repo を取る。https、ssh://、scp 形式（git@host:owner/repo.git）に対応し、host と認証情報は返さない。
/// 手元のパスや file:// はリモートとは見ない（None）。owner が取れないとき（パスが1段）は repo だけ返す
pub fn slug_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        // host（と user:token@）の後ろがパス
        rest.split_once('/')?.1
    } else if let Some((left, p)) = url.split_once(':') {
        // scp 形式。host に / が入るもの（Windows のパスなど）と、手元のパスは除く
        if left.contains('/') || left.is_empty() {
            return None;
        }
        p
    } else {
        return None;
    };
    let path = path.split(['?', '#']).next().unwrap_or("");
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let last = segs.last()?;
    let repo = last.strip_suffix(".git").unwrap_or(last);
    if repo.is_empty() {
        return None;
    }
    match segs.len().checked_sub(2).map(|i| segs[i]) {
        Some(owner) => Some(format!("{owner}/{repo}")),
        None => Some(repo.to_string()),
    }
}

/// .git/config のテキストから remote の URL を選ぶ。origin があれば origin、無ければ先に書いてあったもの
fn remote_url(config: &str) -> Option<String> {
    let mut cur: Option<String> = None;
    let mut found: Vec<(String, String)> = vec![];
    for line in config.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            cur = t.strip_prefix("[remote \"").and_then(|r| r.strip_suffix("\"]")).map(|n| n.to_string());
        } else if let (Some(name), Some((k, v))) = (&cur, t.split_once('=')) {
            if k.trim().eq_ignore_ascii_case("url") && !v.trim().is_empty() {
                found.push((name.clone(), v.trim().to_string()));
            }
        }
    }
    found.iter().find(|(n, _)| n == "origin").or(found.first()).map(|(_, u)| u.clone())
}

/// cwd の git の共通ディレクトリ（worktree なら本体の .git）。cwd がリポジトリの根でなければ None
fn common_git_dir(cwd: &Path) -> Option<PathBuf> {
    let dot = cwd.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = fs::read_to_string(&dot).ok()?;
    let raw = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gitdir = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { cwd.join(raw) };
    match fs::read_to_string(gitdir.join("commondir")) {
        Ok(c) => {
            let c = c.trim();
            Some(if Path::new(c).is_absolute() { PathBuf::from(c) } else { gitdir.join(c) })
        }
        Err(_) => Some(gitdir),
    }
}

pub fn repo_of(cwd: &str) -> Option<String> {
    let common = common_git_dir(Path::new(cwd))?;
    slug_from_url(&remote_url(&fs::read_to_string(common.join("config")).ok()?)?)
}

/// 場所ごとのリポジトリ名。連携していない場所は含めない
pub fn repos_of(paths: &[String]) -> HashMap<String, String> {
    paths.iter().filter_map(|p| repo_of(p).map(|r| (p.clone(), r))).collect()
}

/// 画面から呼ぶ命令の包み。中身の関数は上にある。待つ命令は blocking で別のスレッドへ出す
pub(crate) mod cmd {
    /// 新しい世帯の一覧の各場所に連携しているリポジトリ名（owner/repo）。.git/config を読むだけ（#99）
    #[tauri::command]
    pub async fn place_repos(paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> { crate::blocking(move || Ok(super::repos_of(&paths))).await }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_forms() {
        assert_eq!(slug_from_url("https://github.com/acme/app.git").as_deref(), Some("acme/app"));
        assert_eq!(slug_from_url("https://github.com/acme/app").as_deref(), Some("acme/app"));
        assert_eq!(slug_from_url("git@github.com:acme/app.git").as_deref(), Some("acme/app"));
        assert_eq!(slug_from_url("ssh://git@host.example:2222/acme/app.git").as_deref(), Some("acme/app"));
        // 認証情報は返さない
        let s = slug_from_url("https://user:s3cret@git.example.com/acme/app.git").unwrap();
        assert_eq!(s, "acme/app");
        assert!(!s.contains("s3cret") && !s.contains("user"));
        // GitLab の入れ子のグループは、最後の2段
        assert_eq!(slug_from_url("https://gitlab.example.com/grp/sub/app.git").as_deref(), Some("sub/app"));
        // 手元のパス、file:// はリモートとは見ない
        assert_eq!(slug_from_url("/srv/git/app.git"), None);
        assert_eq!(slug_from_url("../app"), None);
        assert_eq!(slug_from_url("file:///srv/git/app.git"), None);
        assert_eq!(slug_from_url(""), None);
    }

    #[test]
    fn origin_first() {
        let c = "[core]\n\tbare = false\n[remote \"up\"]\n\turl = https://h.example/a/up.git\n[remote \"origin\"]\n\turl = git@h.example:b/mine.git\n";
        assert_eq!(remote_url(c).as_deref(), Some("git@h.example:b/mine.git"));
        let c2 = "[remote \"up\"]\n\turl = https://h.example/a/up.git\n";
        assert_eq!(remote_url(c2).as_deref(), Some("https://h.example/a/up.git"));
        assert_eq!(remote_url("[core]\n\tbare = false\n[branch \"main\"]\n\turl = x\n"), None);
    }

    #[test]
    fn reads_repo_dir_worktree_and_none() {
        let base = std::env::temp_dir().join(format!("ct-repo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main = base.join("proj");
        fs::create_dir_all(main.join(".git/worktrees/wt1")).unwrap();
        fs::write(main.join(".git/config"), "[remote \"origin\"]\n\turl = https://tok:en@h.example/acme/proj.git\n").unwrap();
        let wt = base.join("elsewhere/wt1");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt1").display())).unwrap();
        fs::write(main.join(".git/worktrees/wt1/commondir"), "../..\n").unwrap();
        // リモートの無いリポジトリと、リポジトリではない場所
        let local = base.join("local");
        fs::create_dir_all(local.join(".git")).unwrap();
        fs::write(local.join(".git/config"), "[core]\n\tbare = false\n").unwrap();
        let plain = base.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let p = |x: &Path| x.to_string_lossy().to_string();
        let got = repos_of(&[p(&main), p(&wt), p(&local), p(&plain), p(&base.join("missing"))]);
        assert_eq!(got.get(&p(&main)).map(String::as_str), Some("acme/proj"));
        assert_eq!(got.get(&p(&wt)).map(String::as_str), Some("acme/proj"));
        assert_eq!(got.len(), 2);
        let _ = fs::remove_dir_all(&base);
    }
}
