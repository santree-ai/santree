//! The opt-in **global status-line passthrough**.
//!
//! santree's usage meters fill from the status-line payload Claude hands the
//! `santree-hook statusline` command — but only for sessions santree launched,
//! because that command rides in the `--settings` file [`crate::hooks`] injects.
//! Most of a user's Claude sessions run elsewhere. This module lets them opt in
//! to capturing those too, in the only shape COMPLIANCE.md allows: no token, no
//! hidden `/usage`, just the same status-line payload Claude already gives any
//! status line. On opt-in, `statusLine.command` in the user's global
//! `settings.json` becomes
//!
//! ```text
//! '<hook bin>' --db '<db>' statusline --then '<their original command>'
//! ```
//!
//! The hook records the payload and then runs the original command on the same
//! bytes, forwarding its output — so what the user sees does not change. The
//! original is kept inside the wrapper, shell-quoted, which is what makes the
//! change reversible; and it is recognised by *parsing* the command string back
//! into shell words, so a wrapper written by another build (dev vs installed
//! app) still reads as "enabled" and `set(true)` re-points it at the current
//! binary.
//!
//! The rewrite touches one key and preserves the rest of the file — key order
//! (`serde_json/preserve_order`), indentation and trailing newline — and keeps a
//! one-time `settings.json.santree-backup` of the file as it was before santree
//! first changed it.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use santree_core::domain::ClaudeGlobalCapture;
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::hooks::{db_path, hook_bin, sh_quote, statusline_command};

/// The hook binary's file name — what a wrapper is recognised by, whatever
/// directory it lives in.
const HOOK_BIN_NAME: &str = "santree-hook";

/// The pre-change copy, written once next to the settings file.
const BACKUP_SUFFIX: &str = ".santree-backup";

/// The current state, read from the user's global settings.
pub(crate) fn status() -> Result<ClaudeGlobalCapture> {
    let path = settings_path()?;
    let text = read_text(&path)?;
    let doc = Doc::parse(text.as_deref())?;
    Ok(capture_status(&doc.root, &path))
}

/// Turn the passthrough on or off, rewriting the user's global settings file
/// only when that actually changes it. Idempotent: enabling twice re-points the
/// wrapper at the current hook binary without nesting it.
pub(crate) fn set(app: &AppHandle, enabled: bool) -> Result<ClaudeGlobalCapture> {
    let path = settings_path()?;
    if !enabled {
        return apply(&path, None);
    }
    // Only an *enable* needs these, so a disable still works from a build whose
    // bundled hook has gone missing.
    let bin = hook_bin(app).context("the santree-hook binary is not available")?;
    let db = db_path(app).context("no app data directory")?;
    apply(
        &path,
        Some(&|original| wrapper_command(&bin, &db, original)),
    )
}

/// Builds the wrapped `statusLine` command from whatever the user already had
/// there — [`wrapper_command`] with the hook binary and db path already bound.
type StatusLineWrapper<'a> = dyn Fn(Option<&str>) -> Result<String> + 'a;

/// The file half of [`set`]: read → edit → back up once → write → report.
/// `Some(wrapper)` enables (it builds the wrapped `statusLine` command from
/// whatever was there); `None` disables.
///
/// Split out from [`set`] — which adds only the `AppHandle` lookups above — so
/// the tests drive this path instead of a copy of it. A test that re-implements
/// read/backup/write cannot see [`backup_once`] disappear, and what disappears
/// with it is the user's only copy of a `~/.claude/settings.json` we are about
/// to rewrite.
fn apply(path: &Path, wrapper: Option<&StatusLineWrapper<'_>>) -> Result<ClaudeGlobalCapture> {
    let text = read_text(path)?;
    let mut doc = Doc::parse(text.as_deref())?;

    let changed = match wrapper {
        Some(wrapper) => enable(&mut doc.root, wrapper)?,
        None => disable(&mut doc.root),
    };

    if changed {
        // Only when there was a file to lose: a settings.json santree creates has
        // no prior version worth keeping.
        if text.is_some() {
            backup_once(path)?;
        }
        write_atomic(path, &doc.render())?;
    }
    Ok(capture_status(&doc.root, path))
}

// ── The settings file ───────────────────────────────────────────────────────

/// Claude's config directory as the running app sees it — shared with
/// [`crate::claude_usage`], so every reader of Claude's own state agrees on
/// where that state lives.
pub fn claude_config_dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    config_dir(
        std::env::var_os("CLAUDE_CONFIG_DIR").as_deref(),
        env("XDG_CONFIG_HOME").as_deref(),
        env("HOME").as_deref(),
        |p| p.is_file(),
    )
}

/// `<claude config dir>/settings.json`.
fn settings_path() -> Result<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    config_dir(
        std::env::var_os("CLAUDE_CONFIG_DIR").as_deref(),
        env("XDG_CONFIG_HOME").as_deref(),
        env("HOME").as_deref(),
        |p| p.is_file(),
    )
    .map(|d| d.join("settings.json"))
    .context("no home directory to find Claude's settings in")
}

/// Claude's config directory, resolved the way `usage.rs`'s `projects_roots`
/// does: `CLAUDE_CONFIG_DIR` is authoritative when set; otherwise `~/.claude`,
/// unless only the XDG location (`$XDG_CONFIG_HOME/claude`, default
/// `~/.config/claude`) already holds a `settings.json`. `exists` is injected so
/// this can be tested without touching the real home directory.
fn config_dir(
    claude_config_dir: Option<&OsStr>,
    xdg_config_home: Option<&Path>,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(cfg) = claude_config_dir {
        // The app's usage reader accepts a comma-separated list of roots; the
        // settings file lives in the first one.
        if let Some(first) = cfg
            .to_string_lossy()
            .split(',')
            .map(str::trim)
            .find(|p| !p.is_empty())
        {
            return Some(PathBuf::from(first));
        }
    }
    let home = home?;
    let default = home.join(".claude");
    if exists(&default.join("settings.json")) {
        return Some(default);
    }
    let xdg = xdg_config_home
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"))
        .join("claude");
    if exists(&xdg.join("settings.json")) {
        return Some(xdg);
    }
    Some(default)
}

/// The file's text, or `None` when it doesn't exist yet.
fn read_text(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Copy the file to `<file>.santree-backup` unless that already exists — the
/// backup is "before santree ever touched this", not "before the last toggle".
fn backup_once(path: &Path) -> Result<()> {
    let backup = backup_path(path);
    if backup.exists() {
        return Ok(());
    }
    std::fs::copy(path, &backup)
        .map(drop)
        .with_context(|| format!("writing {}", backup.display()))
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(BACKUP_SUFFIX);
    path.with_file_name(name)
}

/// Write via a sibling temp file + rename so a crash mid-write can't leave the
/// user's global Claude settings half-written. Keeps the original's mode.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".santree-tmp");
    let tmp = path.with_file_name(tmp_name);
    std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))
}

/// A settings document plus the formatting the file already had, so the
/// rewrite reads as a one-key edit in a diff rather than a reformat.
struct Doc {
    root: Map<String, Value>,
    /// One indentation level, as found in the file (`"  "`, `"\t"`, …).
    indent: String,
    /// The file was a single line — keep it that way.
    compact: bool,
    trailing_newline: bool,
}

impl Doc {
    /// `None` = the file doesn't exist; an empty file counts the same. Anything
    /// that isn't a JSON object is refused rather than overwritten.
    fn parse(text: Option<&str>) -> Result<Doc> {
        let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
            return Ok(Doc {
                root: Map::new(),
                indent: "  ".into(),
                compact: false,
                trailing_newline: true,
            });
        };
        let value: Value =
            serde_json::from_str(text).context("Claude's settings.json is not valid JSON")?;
        let Value::Object(root) = value else {
            bail!("Claude's settings.json is not a JSON object");
        };
        let compact = !text.trim().contains('\n');
        let indent = text
            .lines()
            .skip(1)
            .map(|l| &l[..l.len() - l.trim_start().len()])
            .find(|ws| !ws.is_empty())
            .unwrap_or("  ")
            .to_string();
        Ok(Doc {
            root,
            indent,
            compact,
            trailing_newline: text.ends_with('\n'),
        })
    }

    fn render(&self) -> String {
        let value = Value::Object(self.root.clone());
        let mut out = if self.compact {
            serde_json::to_vec(&value).expect("a JSON map serializes")
        } else {
            let mut buf = Vec::new();
            let formatter = serde_json::ser::PrettyFormatter::with_indent(self.indent.as_bytes());
            let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
            serde::Serialize::serialize(&value, &mut ser).expect("a JSON map serializes");
            buf
        };
        if self.trailing_newline {
            out.push(b'\n');
        }
        String::from_utf8(out).expect("serde_json emits UTF-8")
    }
}

// ── The statusLine key ──────────────────────────────────────────────────────

/// What the file's `statusLine.command` is, from santree's point of view.
#[derive(Debug, PartialEq, Eq)]
enum Current {
    /// No usable status-line command.
    None,
    /// The user's own command, untouched by santree.
    Theirs(String),
    /// santree's wrapper, carrying the user's original if there was one.
    Ours(Option<String>),
}

fn current(root: &Map<String, Value>) -> Current {
    let command = root
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty());
    match command {
        None => Current::None,
        Some(c) => match parse_wrapper(c) {
            Some(original) => Current::Ours(original),
            None => Current::Theirs(c.to_string()),
        },
    }
}

fn capture_status(root: &Map<String, Value>, path: &Path) -> ClaudeGlobalCapture {
    let (enabled, original_command) = match current(root) {
        Current::None => (false, None),
        Current::Theirs(c) => (false, Some(c)),
        Current::Ours(original) => (true, original),
    };
    ClaudeGlobalCapture {
        enabled,
        original_command,
        settings_path: path.to_string_lossy().into_owned(),
    }
}

/// Wrap whatever is there. Returns whether the document changed. `wrapper`
/// builds the command for a given original (injected so the pure part is
/// testable without an `AppHandle`).
fn enable(
    root: &mut Map<String, Value>,
    wrapper: impl Fn(Option<&str>) -> Result<String>,
) -> Result<bool> {
    let original = match current(root) {
        Current::None => None,
        Current::Theirs(c) => Some(c),
        // Already ours: keep the inner original, never wrap the wrapper.
        Current::Ours(original) => original,
    };
    let command = wrapper(original.as_deref())?;
    Ok(set_command(root, &command))
}

/// Restore the original (or drop the key when there was none). Returns whether
/// the document changed; a file santree never wrapped is left alone.
fn disable(root: &mut Map<String, Value>) -> bool {
    match current(root) {
        Current::Ours(Some(original)) => set_command(root, &original),
        Current::Ours(None) => root.remove("statusLine").is_some(),
        Current::None | Current::Theirs(_) => false,
    }
}

/// Set `statusLine.command` (and `type: "command"`), keeping any other keys of
/// the `statusLine` object — `padding`, say — in place. Returns whether anything
/// changed.
fn set_command(root: &mut Map<String, Value>, command: &str) -> bool {
    let object = match root.get_mut("statusLine") {
        Some(Value::Object(object)) => object,
        _ => {
            let mut object = Map::new();
            object.insert("type".into(), Value::String("command".into()));
            root.insert("statusLine".into(), Value::Object(object));
            match root.get_mut("statusLine") {
                Some(Value::Object(object)) => object,
                _ => unreachable!("just inserted"),
            }
        }
    };
    let unchanged = object.get("type").and_then(Value::as_str) == Some("command")
        && object.get("command").and_then(Value::as_str) == Some(command);
    if unchanged {
        return false;
    }
    object.insert("type".into(), Value::String("command".into()));
    object.insert("command".into(), Value::String(command.into()));
    true
}

// ── The wrapper command ─────────────────────────────────────────────────────

/// `'<bin>' --db '<db>' statusline [--then '<original>']` — the same shape
/// [`crate::hooks`] injects for santree's own launches, plus the passthrough.
fn wrapper_command(bin: &Path, db: &Path, original: Option<&str>) -> Result<String> {
    let bin = bin.to_str().context("the hook binary path is not UTF-8")?;
    let db = db.to_str().context("the db path is not UTF-8")?;
    Ok(statusline_command(&sh_quote(bin), &sh_quote(db), original))
}

/// `Some(original)` when `command` is santree's wrapper. Recognised by shape
/// after shell-word parsing — never by substring: exactly `<…/santree-hook> --db
/// <db> statusline`, optionally followed by `--then <original>`. The binary is
/// matched on its file name only, so a wrapper written by an installed app is
/// still recognised from a dev build (and vice versa).
fn parse_wrapper(command: &str) -> Option<Option<String>> {
    let words = shell_words(command)?;
    let is_hook = |w: &str| Path::new(w).file_name().and_then(OsStr::to_str) == Some(HOOK_BIN_NAME);
    match words.as_slice() {
        [bin, db_flag, _db, mode] if is_hook(bin) && db_flag == "--db" && mode == "statusline" => {
            Some(None)
        }
        [bin, db_flag, _db, mode, then_flag, original]
            if is_hook(bin)
                && db_flag == "--db"
                && mode == "statusline"
                && then_flag == "--then" =>
        {
            Some(Some(original.clone()))
        }
        _ => None,
    }
}

/// Split a POSIX shell command line into words: single quotes literal, double
/// quotes with the four escapes (`\"`, `\\`, `\$`, `` \` ``), backslash outside
/// quotes, whitespace between words. `None` on an unterminated quote. Enough to
/// read back what [`sh_quote`] wrote, and any hand-edited equivalent.
fn shell_words(s: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        ch => cur.push(ch),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            e @ ('"' | '\\' | '$' | '`') => cur.push(e),
                            other => {
                                cur.push('\\');
                                cur.push(other);
                            }
                        },
                        ch => cur.push(ch),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match chars.next()? {
                    '\n' => {}
                    ch => cur.push(ch),
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/Applications/santree.app/Contents/Resources/santree-hook";
    const DEV_BIN: &str = "/Users/me/dev/santree-app/target/debug/santree-hook";
    const DB: &str = "/Users/me/Library/Application Support/com.santree.desktop/santree.db";

    fn wrap(bin: &str, original: Option<&str>) -> String {
        wrapper_command(Path::new(bin), Path::new(DB), original).unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "santree-global-capture-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// [`super::apply`] — the real read/backup/write path, which is everything
    /// `set` does apart from resolving the hook binary and db path from the
    /// `AppHandle`. Re-implementing it here instead is how the backup could have
    /// been deleted with every one of these tests still green.
    fn apply(path: &Path, enabled: bool, bin: &str) -> ClaudeGlobalCapture {
        let wrapper =
            |original: Option<&str>| wrapper_command(Path::new(bin), Path::new(DB), original);
        let wrapper: Option<&StatusLineWrapper<'_>> = if enabled { Some(&wrapper) } else { None };
        super::apply(path, wrapper).unwrap()
    }

    fn status_of(path: &Path) -> ClaudeGlobalCapture {
        let text = read_text(path).unwrap();
        capture_status(&Doc::parse(text.as_deref()).unwrap().root, path)
    }

    #[test]
    fn wrapper_round_trips_the_original_command_through_a_real_shell() {
        // Everything a user's status line might contain: quotes of both kinds,
        // `$`, backticks, a pipe, a newline.
        let hostile = "~/.claude/statusline.sh --style 'fancy' \"$HOME\" `id` | head -1\necho done";
        let command = wrap(BIN, Some(hostile));
        assert_eq!(parse_wrapper(&command), Some(Some(hostile.to_string())));
        assert_eq!(parse_wrapper(&wrap(BIN, None)), Some(None));

        // What the hook's argv will actually be, per the shell Claude uses.
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "printf '%s\\n' {}",
                command.replacen(&sh_quote(BIN), "", 1)
            ))
            .output()
            .unwrap();
        let argv: Vec<&str> = std::str::from_utf8(&out.stdout)
            .unwrap()
            .split('\n')
            .collect();
        assert_eq!(argv[..4], ["--db", DB, "statusline", "--then"]);
        // ONE argument, verbatim — including its embedded newline.
        assert_eq!(argv[4..].join("\n"), format!("{hostile}\n"));
    }

    #[test]
    fn detects_our_wrapper_by_shape_from_any_hook_path() {
        for bin in [BIN, DEV_BIN, "santree-hook", "./santree-hook"] {
            assert_eq!(
                parse_wrapper(&wrap(bin, Some("my-status"))),
                Some(Some("my-status".into())),
                "{bin}"
            );
            assert_eq!(parse_wrapper(&wrap(bin, None)), Some(None), "{bin}");
        }
        // Not ours: a user's own script (even one mentioning us), a hook event
        // command, a lookalike binary, extra words, an unterminated quote.
        for theirs in [
            "/Users/me/.claude/statusline.sh",
            "cat ~/.santree-hook-notes | head -1",
            "'/opt/santree-hook' --db '/d.db' Stop",
            "'/opt/santree-hook-fake' --db '/d.db' statusline",
            "'/opt/santree-hook' --db '/d.db' statusline extra",
            "'/opt/santree-hook' --db '/d.db' statusline --then",
            "'/opt/santree-hook --db '/d.db' statusline",
            "",
        ] {
            assert_eq!(parse_wrapper(theirs), None, "{theirs:?}");
        }
    }

    #[test]
    fn shell_words_reads_posix_quoting() {
        assert_eq!(
            shell_words(r#"a 'b c' "d \"e\" $f" g\ h  "#).unwrap(),
            ["a", "b c", "d \"e\" $f", "g h"]
        );
        assert_eq!(shell_words("").unwrap(), Vec::<String>::new());
        assert!(shell_words("'open").is_none());
        assert!(shell_words("\"open").is_none());
    }

    #[test]
    fn enable_wraps_and_disable_restores_byte_for_byte() {
        let dir = scratch("roundtrip");
        let path = dir.join("settings.json");
        // Four-space indentation, keys in a deliberate order, other statusLine
        // keys, nested structures, and a trailing newline — all must survive.
        let original = "{\n    \"model\": \"opus\",\n    \"statusLine\": {\n        \"type\": \"command\",\n        \"command\": \"~/.claude/statusline.sh\",\n        \"padding\": 1\n    },\n    \"hooks\": {\n        \"Stop\": [\n            {\n                \"hooks\": []\n            }\n        ]\n    },\n    \"theme\": \"dark\"\n}\n";
        std::fs::write(&path, original).unwrap();

        assert_eq!(
            status_of(&path),
            ClaudeGlobalCapture {
                enabled: false,
                original_command: Some("~/.claude/statusline.sh".into()),
                settings_path: path.to_string_lossy().into_owned(),
            }
        );

        let on = apply(&path, true, BIN);
        assert!(on.enabled);
        assert_eq!(
            on.original_command.as_deref(),
            Some("~/.claude/statusline.sh")
        );
        let text = std::fs::read_to_string(&path).unwrap();
        let expected = original.replace(
            "\"command\": \"~/.claude/statusline.sh\"",
            &format!(
                "\"command\": {}",
                serde_json::to_string(&wrap(BIN, Some("~/.claude/statusline.sh"))).unwrap()
            ),
        );
        assert_eq!(text, expected, "one key changed, nothing else moved");
        let backup = dir.join("settings.json.santree-backup");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // Enabling again from a *different* build re-points the wrapper at that
        // binary, keeps the inner original (no nesting), and leaves the backup —
        // the pre-santree file — untouched.
        let again = apply(&path, true, DEV_BIN);
        assert_eq!(again, on);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(DEV_BIN) && !text.contains(BIN), "{text}");
        assert_eq!(
            parse_wrapper(
                serde_json::from_str::<Value>(&text).unwrap()["statusLine"]["command"]
                    .as_str()
                    .unwrap()
            ),
            Some(Some("~/.claude/statusline.sh".into()))
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        // And a third time with the same build: nothing to change.
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(apply(&path, true, DEV_BIN), on);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );

        let off = apply(&path, false, DEV_BIN);
        assert!(!off.enabled);
        assert_eq!(
            off.original_command.as_deref(),
            Some("~/.claude/statusline.sh")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        // Disabling what isn't enabled is a no-op.
        assert_eq!(apply(&path, false, DEV_BIN), off);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_an_original_the_wrapper_is_our_bar_and_disable_drops_the_key() {
        let dir = scratch("bare");
        let path = dir.join("settings.json");
        // Claude's own two-space format, no trailing newline (as it writes it).
        let original = "{\n  \"model\": \"opus\",\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(git status)\"\n    ]\n  }\n}";
        std::fs::write(&path, original).unwrap();

        let on = apply(&path, true, BIN);
        assert!(on.enabled);
        assert_eq!(on.original_command, None);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.ends_with('\n'));
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["statusLine"]["type"], "command");
        assert_eq!(value["statusLine"]["command"], wrap(BIN, None));
        assert!(text.starts_with("{\n  \"model\": \"opus\","), "{text}");

        let off = apply(&path, false, BIN);
        assert_eq!(off.original_command, None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_settings_file_is_created_without_a_backup() {
        let dir = scratch("missing");
        let path = dir.join("nested").join("settings.json");
        assert!(!status_of(&path).enabled);

        let on = apply(&path, true, BIN);
        assert!(on.enabled);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            format!(
                "{{\n  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": {}\n  }}\n}}\n",
                serde_json::to_string(&wrap(BIN, None)).unwrap()
            )
        );
        assert!(!dir
            .join("nested")
            .join("settings.json.santree-backup")
            .exists());

        apply(&path, false, BIN);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_settings_file_it_cannot_parse_is_left_alone() {
        let dir = scratch("broken");
        let path = dir.join("settings.json");
        for broken in ["{ not json", "[1, 2]", "\"a string\""] {
            std::fs::write(&path, broken).unwrap();
            let text = read_text(&path).unwrap();
            assert!(Doc::parse(text.as_deref()).is_err(), "{broken:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        }
        // A compact single-line file stays single-line.
        std::fs::write(&path, "{\"model\":\"opus\"}").unwrap();
        apply(&path, true, BIN);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains('\n'), "{text}");
        assert!(
            text.starts_with("{\"model\":\"opus\",\"statusLine\":"),
            "{text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_dir_follows_claude_config_dir_then_home_then_xdg() {
        let home = Path::new("/Users/me");
        let none = |_: &Path| false;
        assert_eq!(
            config_dir(Some(OsStr::new("/cfg/a, /cfg/b")), None, Some(home), none),
            Some(PathBuf::from("/cfg/a"))
        );
        assert_eq!(
            config_dir(None, None, Some(home), none),
            Some(PathBuf::from("/Users/me/.claude"))
        );
        // Only the XDG location holds a settings file → use it.
        let xdg_only = |p: &Path| p == Path::new("/Users/me/.config/claude/settings.json");
        assert_eq!(
            config_dir(None, None, Some(home), xdg_only),
            Some(PathBuf::from("/Users/me/.config/claude"))
        );
        let custom_xdg = |p: &Path| p == Path::new("/xdg/claude/settings.json");
        assert_eq!(
            config_dir(None, Some(Path::new("/xdg")), Some(home), custom_xdg),
            Some(PathBuf::from("/xdg/claude"))
        );
        // Both exist → `~/.claude` wins, since that is what Claude itself reads.
        assert_eq!(
            config_dir(None, None, Some(home), |_| true),
            Some(PathBuf::from("/Users/me/.claude"))
        );
        assert_eq!(config_dir(None, None, None, none), None);
    }
}
