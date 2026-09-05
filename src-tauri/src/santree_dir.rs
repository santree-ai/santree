//! The `.santree/` directory a managed repo carries, and what in it is whose.
//!
//! Two kinds of thing live there. `init.sh` and `prompts/` are the **repo's**:
//! committed with the code, so every clone and every teammate gets the same
//! setup script and the same prompts. `worktrees/` is **santree's**: one nested
//! checkout per ticket, never content of the parent checkout. A nested
//! `.gitignore` keeps that split without asking every repo to learn it. It is
//! written once, when santree first creates the directory, and never rewritten,
//! so a repo that decides to ignore more (or less) keeps its own rule.

use std::path::{Path, PathBuf};

/// The ignore file santree drops into a fresh `.santree/`. `reviews/` is the
/// pre-unification review checkout dir, still present in older repos.
const IGNORE: &str = "\
# Written by santree. The nested checkouts below are santree's, not this repo's
# content; init.sh and prompts/ beside them are meant to be committed.
worktrees/
reviews/
";

/// The repo's `.santree/` directory, created (with its `.gitignore`) if missing.
pub fn ensure(repo_root: &Path) -> std::io::Result<PathBuf> {
    let dir = repo_root.join(".santree");
    std::fs::create_dir_all(&dir)?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, IGNORE)?;
    }
    Ok(dir)
}

/// Where a repo's committed prompt layers live: `.santree/prompts/<name>.njk`.
pub fn prompts_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".santree").join("prompts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_creates_the_dir_and_ignore_once() {
        let root = std::env::temp_dir().join(format!("santree-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dir = ensure(&root).unwrap();
        assert!(dir.is_dir());
        let ignore = dir.join(".gitignore");
        assert!(std::fs::read_to_string(&ignore)
            .unwrap()
            .lines()
            .any(|l| l == "worktrees/"));

        // A repo's own edit to the ignore file survives the next ensure.
        std::fs::write(&ignore, "worktrees/\nprompts/\n").unwrap();
        ensure(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(&ignore).unwrap(),
            "worktrees/\nprompts/\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
