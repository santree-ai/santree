//! `COMPLIANCE.md`, made executable.
//!
//! `COMPLIANCE.md` is the contract that keeps santree a terminal emulator rather
//! than an agent harness: no credential handling, no output-parsing that drives
//! input, no unattended loop, no vendor impersonation. That document is prose,
//! and prose only holds while somebody remembers to read it. This module is the
//! half of it a machine can check, so a change that crosses one of those lines
//! fails a test instead of shipping.
//!
//! Two kinds of test live here, in that order of preference:
//!
//! * **Behavioural** — call the real function and assert the invariant. Always
//!   better: it survives any refactor that keeps the behaviour.
//! * **Source scans** — for the "this pattern must never reappear" rules, where
//!   what is forbidden is a call site existing at all, and no single function can
//!   be asked about that. These read santree's own source from
//!   `CARGO_MANIFEST_DIR`. Every scan strips comments first (see
//!   [`strip_rust_comments`]), so a comment that merely *names* a forbidden
//!   pattern — including the ones in this file — can never trip a test.
//!
//! Not every claim in `COMPLIANCE.md` is checkable, and the ones that aren't are
//! judgment calls ("human-initiated", "single-shot, under human review") that a
//! test would only pretend to enforce. Those stay prose.
//!
//! Tests that belong beside the code they guard live there and are not duplicated
//! here — notably `claude_usage.rs` (the usage host, matched by parse, and the
//! honest User-Agent), `hooks.rs` (the MCP config's `${` refusal and its
//! PR-scoped argv), `agent.rs` (the headless helpers' flags), `review_drafts.rs`
//! (a stale or foreign draft is refused), `crates/hook/tests/exit_zero.rs` (the
//! hook binary prints nothing and exits 0, and serves exactly its seven tools)
//! and `crates/pty` (`TERM` plus the user's own variables is the only env
//! channel in, and the nested-session markers santree inherited are dropped on
//! the way — see COMPLIANCE.md's "Inherited nested-session markers").

use std::path::{Path, PathBuf};

// ── Reading santree's own source ────────────────────────────────────────────

/// The repository root — `src-tauri`'s parent. Derived from the manifest dir so
/// the scans run identically on any machine and in CI.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent")
        .to_path_buf()
}

/// One repo-relative file, verbatim.
fn read(rel: &str) -> String {
    let path = repo_root().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

/// One repo-relative Rust file with its comments removed.
fn code(rel: &str) -> String {
    strip_rust_comments(&read(rel))
}

/// The part of a Rust file that ships: everything before its `#[cfg(test)] mod`.
/// Test fixtures legitimately contain SQL, hostile strings and vendor names that
/// the scans below are hunting for.
fn shipped(rel: &str) -> String {
    let src = code(rel);
    let mut from = 0usize;
    while let Some(at) = src[from..].find("#[cfg(test)]") {
        let start = from + at;
        let rest = src[start + "#[cfg(test)]".len()..].trim_start();
        if rest.starts_with("mod ") {
            return src[..start].to_string();
        }
        from = start + 1;
    }
    src
}

/// Every `.rs` file santree itself writes: the app plus the three workspace
/// crates, minus this one. (This file quotes the forbidden patterns in order to
/// forbid them, so scanning it would make every test below fail on its own
/// rulebook.) Yields `(repo-relative path, comment-stripped source)`.
fn rust_sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for dir in [
        "src-tauri/src",
        "crates/core/src",
        "crates/pty/src",
        "crates/hook/src",
    ] {
        collect_rust(&repo_root().join(dir), &mut out);
    }
    out.retain(|(path, _)| path != "src-tauri/src/compliance.rs");
    out.sort();
    assert!(
        out.len() > 40,
        "the source scan found only {} files — it is looking in the wrong place",
        out.len()
    );
    out
}

fn collect_rust(dir: &Path, out: &mut Vec<(String, String)>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rust(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let rel = path
                .strip_prefix(repo_root())
                .expect("under the repo root")
                .to_string_lossy()
                .into_owned();
            out.push((rel, strip_rust_comments(&read_path(&path))));
        }
    }
}

fn read_path(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

/// Rust source with every comment removed and every string literal left intact.
///
/// Both halves matter. Dropping comments is what keeps a scan from firing on a
/// doc comment that names the very pattern it forbids; keeping literals is what
/// keeps `"https://api.anthropic.com"` from being read as a line comment that
/// swallows the rest of its line.
fn strip_rust_comments(src: &str) -> String {
    let c: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < c.len() {
        // Line comment: drop to the newline, which is kept so line-scoped
        // assertions still see the right lines.
        if c[i] == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // Block comment, nested as rustc allows. Newlines inside are kept.
        if c[i] == '/' && c.get(i + 1) == Some(&'*') {
            let mut depth = 1usize;
            i += 2;
            while i < c.len() && depth > 0 {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    if c[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            continue;
        }
        // Raw string: no escapes inside, so the terminator is a quote followed by
        // exactly as many hashes as opened it.
        if c[i] == 'r' && matches!(c.get(i + 1), Some('"') | Some('#')) {
            if let Some(next) = copy_raw_string(&c, i, &mut out) {
                i = next;
                continue;
            }
        }
        if c[i] == '"' {
            i = copy_quoted(&c, i, '"', &mut out);
            continue;
        }
        // A single quote opens a char literal only when it closes like one;
        // otherwise it opens a lifetime (`&'static str`), which is ordinary code.
        if c[i] == '\'' && (c.get(i + 1) == Some(&'\\') || c.get(i + 2) == Some(&'\'')) {
            i = copy_quoted(&c, i, '\'', &mut out);
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Copy a `delim`-quoted literal starting at `start` verbatim, honouring
/// backslash escapes. Returns the index just past the closing delimiter.
fn copy_quoted(c: &[char], start: usize, delim: char, out: &mut String) -> usize {
    out.push(c[start]);
    let mut i = start + 1;
    while i < c.len() {
        if c[i] == '\\' {
            out.push(c[i]);
            if let Some(next) = c.get(i + 1) {
                out.push(*next);
            }
            i += 2;
            continue;
        }
        out.push(c[i]);
        i += 1;
        if c[i - 1] == delim {
            break;
        }
    }
    i
}

/// Copy a raw string starting at `start` (which is its `r`). `None` when what
/// follows isn't actually a raw string, in which case nothing was written.
fn copy_raw_string(c: &[char], start: usize, out: &mut String) -> Option<usize> {
    let (hashes, open) = raw_string_open(c, start)?;
    out.extend(&c[start..=open]);
    let mut i = open + 1;
    while i < c.len() {
        if c[i] == '"' {
            if let Some(end) = raw_string_close(c, i, hashes) {
                out.extend(&c[i..end]);
                return Some(end);
            }
        }
        out.push(c[i]);
        i += 1;
    }
    Some(i)
}

/// `(hash count, index of the opening quote)` when `start` begins a raw string.
fn raw_string_open(c: &[char], start: usize) -> Option<(usize, usize)> {
    let mut j = start + 1;
    let mut hashes = 0usize;
    while c.get(j) == Some(&'#') {
        hashes += 1;
        j += 1;
    }
    (c.get(j) == Some(&'"')).then_some((hashes, j))
}

/// The index just past a raw string's terminator, when `quote` is one.
fn raw_string_close(c: &[char], quote: usize, hashes: usize) -> Option<usize> {
    let mut k = quote + 1;
    let mut seen = 0usize;
    while seen < hashes && c.get(k) == Some(&'#') {
        seen += 1;
        k += 1;
    }
    (seen == hashes).then_some(k)
}

/// Every string literal in comment-stripped Rust source. Raw strings are
/// included, without their `r#` fence; escapes are resolved to the escaped
/// character (so a `\`-continued SQL literal reads as one statement).
fn string_literals(src: &str) -> Vec<String> {
    let c: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == 'r' {
            if let Some((hashes, open)) = raw_string_open(&c, i) {
                let mut body = String::new();
                i = open + 1;
                while i < c.len() {
                    if c[i] == '"' {
                        if let Some(end) = raw_string_close(&c, i, hashes) {
                            i = end;
                            break;
                        }
                    }
                    body.push(c[i]);
                    i += 1;
                }
                out.push(body);
                continue;
            }
        }
        if c[i] == '"' {
            let mut body = String::new();
            i += 1;
            while i < c.len() {
                if c[i] == '\\' {
                    if let Some(next) = c.get(i + 1) {
                        body.push(*next);
                    }
                    i += 2;
                    continue;
                }
                if c[i] == '"' {
                    i += 1;
                    break;
                }
                body.push(c[i]);
                i += 1;
            }
            out.push(body);
            continue;
        }
        i += 1;
    }
    out
}

/// The balanced-parenthesis argument text of every `<needle>…)` call in
/// comment-stripped source. `needle` ends in `(`.
fn call_args(src: &str, needle: &str) -> Vec<String> {
    debug_assert!(needle.ends_with('('));
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(at) = src[from..].find(needle) {
        let open = from + at + needle.len();
        let mut depth = 1usize;
        let mut end = None;
        for (offset, ch) in src[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + offset);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(end) = end {
            out.push(src[open..end].to_string());
        }
        from = open;
    }
    out
}

/// The body of `fn <name>(`, from its opening brace to the matching close.
fn fn_body<'a>(src: &'a str, name: &str) -> &'a str {
    let at = src.find(&format!("fn {name}(")).unwrap_or_else(|| {
        panic!("`fn {name}` is gone — rewrite this test against what replaced it")
    });
    let open = at + src[at..].find('{').expect("a function has a body");
    let mut depth = 0usize;
    for (offset, ch) in src[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..=open + offset];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces in `fn {name}`")
}

/// The first `n` characters from `at`, without slicing through one.
fn window(src: &str, at: usize, n: usize) -> String {
    src[at..].chars().take(n).collect()
}

/// An `n`-character window at each occurrence of `marker` — enough context to
/// see what a flag was set to, without parsing the expression around it.
fn windows_after(src: &str, marker: &str, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(hit) = src[from..].find(marker) {
        let start = from + hit;
        out.push(window(src, start, n));
        from = start + 1;
    }
    out
}

/// The quoted text following each occurrence of `marker`, which must end in `"`.
/// Used to read what a comparison compares against.
fn quoted_after(src: &str, marker: &str) -> Vec<String> {
    debug_assert!(marker.ends_with('"'));
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(hit) = src[from..].find(marker) {
        let start = from + hit + marker.len();
        out.push(src[start..].chars().take_while(|c| *c != '"').collect());
        from = start;
    }
    out
}

/// Every `<prefix><path>` reference in comment-stripped source — how one module
/// reaches into another, e.g. every `github::…` in `review_drafts.rs`.
fn qualified_paths(src: &str, prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(at) = src[from..].find(prefix) {
        let start = from + at;
        out.push(
            src[start..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':')
                .collect::<String>()
                .trim_end_matches(':')
                .to_string(),
        );
        from = start + prefix.len();
    }
    out
}

/// The tables one SQL statement reads or writes.
fn sql_tables(sql: &str) -> Vec<String> {
    let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = Vec::new();
    for keyword in ["INSERT INTO ", "UPDATE ", "DELETE FROM ", "FROM "] {
        let mut from = 0usize;
        while let Some(at) = flat[from..].find(keyword) {
            let after = from + at + keyword.len();
            let table = flat[after..]
                .split(|c: char| c.is_whitespace() || c == '(' || c == ',')
                .next()
                .unwrap_or_default();
            // `ON CONFLICT … DO UPDATE SET` is an upsert clause, not a table.
            if !table.is_empty() && table != "SET" {
                out.push(table.to_string());
            }
            from = after;
        }
    }
    out
}

/// SQL with `--` comments removed, split into statements.
fn sql_statements(src: &str) -> Vec<String> {
    src.lines()
        .map(|line| line.split("--").next().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
        .split(';')
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .collect()
}

/// Identifiers in `sql` whose name reads like a stored credential.
fn secret_shaped_identifiers(sql: &str) -> Vec<String> {
    const WORDS: [&str; 6] = [
        "token",
        "secret",
        "password",
        "credential",
        "apikey",
        "api_key",
    ];
    let mut out = Vec::new();
    for word in sql.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let lower = word.to_ascii_lowercase();
        if !word.is_empty() && WORDS.iter().any(|w| lower.contains(w)) {
            out.push(word.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

// ── The scans' own foundation ───────────────────────────────────────────────

/// Not a COMPLIANCE.md rule — the guard on every rule below it. A stripper that
/// ate string literals would make every scan in this file silently vacuous, and
/// a vacuous compliance test is worse than none: it reports green forever.
#[test]
fn the_comment_stripper_drops_comments_and_keeps_string_literals() {
    let src = r##"
// a line comment naming a forbidden thing
/* a block /* nested */ comment */
const URL: &str = "https://api.anthropic.com/api/oauth/usage"; // trailing
const RAW: &str = r#"a raw " string // not a comment"#;
fn f<'a>(x: &'a str) -> char { let q = '\''; let s = "said \" then // stopped"; '/' }
"##;
    let out = strip_rust_comments(src);
    for gone in ["a line comment", "nested", "trailing"] {
        assert!(!out.contains(gone), "{gone} survived: {out}");
    }
    // The URL's `//` must survive, and so must the rest of its line.
    assert!(
        out.contains("https://api.anthropic.com/api/oauth/usage"),
        "{out}"
    );
    assert!(
        out.contains(r##"r#"a raw " string // not a comment"#"##),
        "{out}"
    );
    assert!(out.contains(r#"said \" then // stopped"#), "{out}");
    // A lifetime is code, not a char literal, so nothing after it is swallowed.
    assert!(out.contains("fn f<'a>(x: &'a str)"), "{out}");

    let literals = string_literals(&out);
    assert!(literals.contains(&"https://api.anthropic.com/api/oauth/usage".to_string()));
    assert!(literals.contains(&r#"a raw " string // not a comment"#.to_string()));
    assert!(literals.iter().any(|l| l.contains("said")));

    assert_eq!(
        call_args("foo.header(\"a\", B(1))", ".header("),
        ["\"a\", B(1)"]
    );
    assert_eq!(
        fn_body("fn g(x: u8) { if x { y } }\n", "g"),
        "{ if x { y } }"
    );
}

// ── COMPLIANCE.md § No credential handling ──────────────────────────────────

/// COMPLIANCE.md, "No credential handling", and CLAUDE.md's secrets invariant:
/// app-owned secrets belong in the OS keychain, never in plaintext SQLite.
///
/// Breaking this puts a live credential on disk in the clear, where every later
/// reader inherits it — a backup, a crash bundle, another process on the machine,
/// or whoever next runs `sqlite3 santree.db`. Migrations are append-only and an
/// installed app replays them, so a column added once is a column that existed on
/// someone's disk forever.
#[test]
fn no_migration_stores_a_secret_in_plaintext() {
    // The only names that may look like a credential today, each because it
    // isn't one. Anything else is a new violation, and this list is where the
    // argument for it has to be made.
    const ALLOWED: [(&str, &str); 3] = [
        // Linear's OAuth pair, from the very first schema. Migration 0014 moves
        // both into the OS keychain and DROPs the columns; the CREATE survives
        // only because migrations cannot be rewritten. Asserted below, not
        // assumed.
        ("0001_init.sql", "access_token"),
        ("0001_init.sql", "refresh_token"),
        // A count of LLM context tokens for the usage bar. Not a credential.
        ("0011_session_usage_live.sql", "input_tokens"),
    ];

    let dir = repo_root().join("src-tauri/migrations");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("migrations directory")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "sql"))
        .collect();
    files.sort();
    assert!(files.len() > 20, "the migration scan found almost nothing");

    for path in &files {
        let name = path.file_name().expect("file name").to_string_lossy();
        for statement in sql_statements(&read_path(path)) {
            // A statement that removes a column is the fix, not the violation.
            if statement.to_ascii_uppercase().contains("DROP COLUMN") {
                continue;
            }
            for ident in secret_shaped_identifiers(&statement) {
                assert!(
                    ALLOWED.contains(&(name.as_ref(), ident.as_str())),
                    "{name} introduces `{ident}`, which reads like a stored credential. \
                     Secrets go in the OS keychain (see linear.rs / env.rs); if this one \
                     genuinely isn't a secret, add it to ALLOWED with the reason."
                );
            }
        }
    }

    // Keeps the allowlist honest: 0001's two columns are tolerated only because
    // 0014 takes them away again.
    let drop = read("src-tauri/migrations/0014_linear_tokens_to_keychain.sql");
    for column in ["access_token", "refresh_token"] {
        assert!(
            drop.contains(&format!("DROP COLUMN {column}")),
            "0014 no longer drops {column}, so 0001's plaintext column now survives"
        );
    }
}

/// COMPLIANCE.md, "No harness behavior", and the "Identified honestly" bound on
/// the Claude-usage exception: santree spawns a vendor's real binary and renders
/// its real output — it never *impersonates* the vendor's client.
///
/// Breaking this means santree's own HTTP traffic claims to be Claude Code (or
/// Codex, or Cursor) to that vendor's servers. It happened once already: the
/// usage request went out as a Claude Code version string until it was replaced
/// with `santree/<version>`. A rule the code breaks is not a rule, so this fails
/// if the disguise comes back — in that header or in any future one.
#[test]
fn no_outbound_request_claims_to_be_a_vendor_cli() {
    // Client identifiers, not vendor names: `anthropic-beta` is a real API header
    // and `@anthropic-ai/claude-code` is a real npm path. What is forbidden is
    // presenting *as* one of these programs.
    const DISGUISES: [&str; 7] = [
        "claude-code/",
        "claude-cli",
        "codex-cli",
        "codex/",
        "cursor/",
        "opencode/",
        "gemini-cli",
    ];

    let mut user_agents = 0usize;
    for (path, src) in rust_sources() {
        let mut calls = call_args(&src, ".header(");
        calls.extend(call_args(&src, ".user_agent("));
        for call in calls {
            let lower = call.to_ascii_lowercase();
            for disguise in DISGUISES {
                assert!(
                    !lower.contains(disguise),
                    "{path}: an outbound header claims to be `{disguise}`: {call}"
                );
            }
            if !lower.contains("user-agent") {
                continue;
            }
            user_agents += 1;
            // The value is either a literal or a SCREAMING_CASE constant declared
            // in the same file. Either way it has to say santree.
            let mut value = call.clone();
            for word in call.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
                let is_const = word.len() > 2
                    && word
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit());
                if !is_const {
                    continue;
                }
                if let Some(at) = src.find(&format!("const {word}")) {
                    value.push_str(&window(&src, at, 200));
                }
            }
            assert!(
                value.contains("santree"),
                "{path}: this User-Agent does not identify santree: {value}"
            );
        }
    }
    assert!(
        user_agents >= 3,
        "only {user_agents} User-Agent headers found — the scan has stopped seeing them"
    );
}

/// COMPLIANCE.md, "Claude subscription usage — a scoped exception": the whole
/// exception is that `claude_usage.rs` is the *only* module that reads an agent
/// CLI's stored credential, and `claude_fetch_usage` the only command that
/// reaches it.
///
/// Breaking this widens a deliberately single-purpose read into a general
/// capability. A second reader — however well meant — is a second place a
/// vendor's token can be forwarded from, and the exception stops being narrow
/// enough to defend.
#[test]
fn a_vendor_credential_is_read_in_one_module_and_reachable_through_one_command() {
    // How Claude Code's credential is stored: the keychain item, the fallback
    // file, and the argv that reads a keychain item at all.
    const CREDENTIAL_STORES: [&str; 3] = [
        "Claude Code-credentials",
        ".credentials.json",
        "find-generic-password",
    ];
    const READER: &str = "src-tauri/src/claude_usage.rs";

    for (path, src) in rust_sources() {
        for store in CREDENTIAL_STORES {
            assert!(
                !src.contains(store) || path == READER,
                "{path} reads a vendor CLI's credential store ({store}). COMPLIANCE.md \
                 permits exactly one reader, claude_usage.rs, for exactly one request."
            );
        }
        // Every other module has to go through the command, not the module.
        let is_owner =
            path == READER || path == "src-tauri/src/commands.rs" || path == "src-tauri/src/lib.rs";
        assert!(
            is_owner || !src.contains("claude_usage::"),
            "{path} calls into the credential reader; only the one command may"
        );
    }

    let reaches = shipped("src-tauri/src/commands.rs")
        .matches("claude_usage::")
        .count();
    assert_eq!(
        reaches, 1,
        "the credential reader is reachable from {reaches} places in commands.rs; \
         COMPLIANCE.md says one (`claude_fetch_usage`)"
    );
}

/// COMPLIANCE.md, "Claude subscription usage": the token is *never logged, never
/// persisted*, no type carrying it derives `Debug` or `Serialize`, and only the
/// derived percentages and reset times reach SQLite.
///
/// Breaking this leaks a live OAuth token into santree's own log file — the one
/// users attach to bug reports — or into its database. Nothing else about the
/// exception matters if the credential ends up written down.
#[test]
fn the_usage_credential_is_never_logged_serialized_or_stored() {
    let src = shipped("src-tauri/src/claude_usage.rs");

    for derive in call_args(&src, "derive(") {
        for trait_name in ["Debug", "Serialize"] {
            assert!(
                !derive.contains(trait_name),
                "claude_usage.rs derives {trait_name} ({derive}). A credential-carrying type \
                 that can be formatted or serialized is one stray `{{:?}}` from a logged token."
            );
        }
    }

    let mut logged = 0usize;
    for level in ["error!(", "warn!(", "info!(", "debug!(", "trace!("] {
        for line in call_args(&src, &format!("log::{level}")) {
            logged += 1;
            let lower = line.to_ascii_lowercase();
            for word in ["token", "bearer", "credential", "auth"] {
                assert!(
                    !lower.contains(word),
                    "claude_usage.rs logs something named `{word}`: {line}"
                );
            }
        }
    }
    assert!(
        logged > 0,
        "the log scan found no log calls — it has stopped working"
    );

    // Only the derived windows are stored, and only in the one display-only table
    // the status-line capture also writes.
    let statements = string_literals(&src)
        .into_iter()
        .filter(|l| l.contains("INSERT") || l.contains("UPDATE") || l.contains("SELECT"))
        .collect::<Vec<_>>();
    assert!(
        !statements.is_empty(),
        "the SQL scan found nothing to check"
    );
    for sql in statements {
        assert!(
            sql.contains("claude_rate_limits"),
            "claude_usage.rs writes somewhere other than the rate-limit table: {sql}"
        );
        let lower = sql.to_ascii_lowercase();
        for word in ["token", "credential", "secret"] {
            assert!(
                !lower.contains(word),
                "claude_usage.rs persists `{word}`: {sql}"
            );
        }
    }
}

/// COMPLIANCE.md, "One host, matched by parse", and CLAUDE.md's sink-matching
/// invariant: a host allowlist is a parsed-host comparison, never a string
/// prefix.
///
/// Breaking this is how a credential reaches the wrong server. A URL on
/// `api.anthropic.com.evil.test` passes a `starts_with("https://api.anthropic.com")`
/// test and fails a `host_str()` one. The same shape guards Linear's upload host
/// and GitHub's, so the scan covers all three rather than only the one that
/// carries a token.
#[test]
fn every_host_allowlist_is_matched_by_a_parsed_host_not_a_string_prefix() {
    for (path, src) in rust_sources() {
        for call in call_args(&src, "starts_with(") {
            let lower = call.to_ascii_lowercase();
            assert!(
                !(lower.contains("http://") || lower.contains("https://")),
                "{path} matches a URL by prefix: starts_with({call}). Compare \
                 `url.host_str() == Some(host)` instead — a prefix also matches \
                 a look-alike host that merely begins the same way."
            );
        }
    }

    // The three modules that gate on a host must still be doing it by parse.
    for module in ["claude_usage.rs", "linear.rs", "repo.rs"] {
        assert!(
            code(&format!("src-tauri/src/{module}")).contains("host_str()"),
            "{module} no longer compares a parsed host; if its allowlist moved, move this \
             check with it rather than dropping it"
        );
    }
}

// ── COMPLIANCE.md § Inherited nested-session markers ────────────────────────

/// COMPLIANCE.md, "Inherited nested-session markers": the strip is a property of
/// *spawning a process behind a PTY*, not of one module, and santree does that
/// in two places.
///
/// `crates/pty` owns the list and its own behavioural tests. What no test could
/// see from inside that crate is the second spawn site: `stream.rs` runs setup
/// scripts and builds behind their own PTY, and for as long as it existed it
/// handed them the launching Claude session's id — and, worse,
/// `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, a live IPC
/// channel and its bearer token.
///
/// Both halves are asserted. Every spawn site must strip, and the marker names
/// must live in exactly one file: a site that copies the list instead of
/// importing it passes the first check on the day it lands and drifts silently
/// from then on, which is precisely how this leak survived its own fix.
#[test]
fn every_pty_spawn_site_strips_the_inherited_session_markers() {
    const OWNER: &str = "crates/pty/src/lib.rs";

    let mut sites = 0;
    for (path, src) in rust_sources() {
        if src.contains("CommandBuilder::new(") {
            sites += 1;
            assert!(
                src.contains("strip_inherited_session_markers"),
                "{path} spawns a process behind a PTY without stripping the inherited \
                 session markers; it would hand on the launching session's identity and \
                 its messaging token"
            );
        }
        // The list itself, not a copy of it. Shipped code only: a test may
        // legitimately name one marker to prove the caller's own value wins.
        let shipped = shipped(&path);
        for marker in santree_pty::INHERITED_SESSION_MARKERS {
            assert!(
                !shipped.contains(marker) || path == OWNER,
                "{path} names `{marker}` itself. Import INHERITED_SESSION_MARKERS from \
                 crates/pty — a second copy is a second thing to keep in sync."
            );
        }
    }
    assert!(
        sites >= 2,
        "the scan found {sites} PTY spawn sites; it is looking in the wrong place"
    );
}

// ── COMPLIANCE.md § No automated control loop ───────────────────────────────

/// COMPLIANCE.md, "No automated control loop" and "Where this is enforced in
/// code": the backend streams bytes and never inspects them to decide what to
/// type. `terminal.rs` is the one adapter over the PTY, and its two input
/// commands — `terminal_write` for the user's keystrokes, `terminal_seed` for
/// the single human-initiated launch line — are the only way bytes go *in*.
///
/// Both reach the PTY through the module's one `write_pty` helper, so counting
/// `manager.write(` alone would no longer notice a *third* command: it would
/// call the helper and leave that count at one. The helper's own call sites are
/// therefore counted too, and a new writer has to come here and say why.
///
/// Breaking this is the line the whole document exists to hold: a second module
/// with PTY-write access is a module that can answer the agent on the user's
/// behalf, and santree stops being a terminal emulator.
///
/// The write check matches on the receiver name (`manager` / `pty`, the two
/// bindings a `PtyManager` is ever held under), so a rename needs this test
/// updated. The module allowlist above it is what actually bounds who could
/// introduce a new write in the first place.
#[test]
fn only_the_terminal_adapter_writes_bytes_into_a_pty() {
    // Modules that may name the PTY manager at all. A new entry here is a new
    // module able to reach a live terminal, and wants a reviewer.
    const MAY_HOLD_A_PTY: [&str; 5] = [
        "src-tauri/src/terminal.rs",  // the adapter itself
        "src-tauri/src/commands.rs",  // hands it to resource accounting
        "src-tauri/src/lib.rs",       // registers it as managed state
        "src-tauri/src/resources.rs", // sums each session's process tree
        "src-tauri/src/update.rs",    // closes every session before restarting
    ];
    // `agent_procs.rs` deliberately does NOT appear above: it reads the process
    // table, not the manager, and takes its pane roots as plain
    // `(LiveTerminal, pid)` pairs — a term_key, the provider in that pane, and a
    // pid — from `terminal::pane_roots`. Keeping it unable to name a PtyManager
    // is what makes "observation only" structural rather than a promise.

    for (path, src) in rust_sources() {
        if path.starts_with("crates/pty/") {
            continue;
        }
        if src.contains("PtyManager") {
            assert!(
                MAY_HOLD_A_PTY.contains(&path.as_str()),
                "{path} reaches the PTY manager. Everything that talks to a terminal goes \
                 through terminal.rs; add it here only with a reason."
            );
        }
        for receiver in ["manager.write(", "pty.write("] {
            assert!(
                !src.contains(receiver) || path == "src-tauri/src/terminal.rs",
                "{path} writes into a PTY. Only `terminal_write` may, and only with bytes \
                 the human typed or the one seed they asked for."
            );
        }
    }

    let terminal = shipped("src-tauri/src/terminal.rs");
    assert_eq!(
        terminal.matches("manager.write(").count(),
        1,
        "terminal.rs should hold exactly one PTY write — the `write_pty` helper that \
         `terminal_write` and `terminal_seed` both go through"
    );
    // One definition plus exactly two callers. A third is a third way for bytes
    // to enter a terminal, which is the thing this whole test exists to notice.
    assert_eq!(
        terminal.matches("write_pty(").count(),
        3,
        "write_pty should have exactly two callers — `terminal_write` (the user's \
         keystrokes) and `terminal_seed` (the one human-initiated launch line). A new \
         one is a new way to answer the agent on the user's behalf: name it here, with \
         a reason, or route it through one of the two."
    );
}

// ── COMPLIANCE.md § Session-state hooks + status line ───────────────────────

/// Every way the settings builder could stop being unable to gate Claude, as a
/// list of human-readable violations. Empty is the only acceptable answer, and
/// the test below feeds it a deliberately broken builder to prove it can speak.
fn hook_registration_violations(src: &str) -> Vec<String> {
    const STATE_EVENTS: [&str; 8] = [
        "SessionStart",
        "UserPromptSubmit",
        // The mid-turn heartbeats. Decision-capable (Claude documents
        // `decision: "block"` for PostToolUse) — and so are `Stop` and
        // `UserPromptSubmit`, which have always been here. `async: true` is what
        // makes all of them observers, and it is asserted below.
        "PostToolUse",
        "PostToolUseFailure",
        "Notification",
        "PermissionRequest",
        "Stop",
        "SessionEnd",
    ];
    // The two santree must never inject, on their own merits rather than because
    // they are "per-tool". `PreToolUse` is the only hook that can *authorize or
    // rewrite* a tool call — `hookSpecificOutput.permissionDecision`
    // ("allow"/"deny"/"ask") and `updatedInput` are documented as PreToolUse-only
    // — so registering it is the one way santree could answer a permission prompt
    // on the user's behalf even by accident. `PermissionDenied` is the matching
    // verdict channel.
    const DECISION_EVENTS: [&str; 2] = ["PreToolUse", "PermissionDenied"];

    let mut out = Vec::new();

    let at = src.find("const EVENTS").expect(
        "hooks.rs no longer has an EVENTS list — rewrite this test against what replaced it",
    );
    let end = at + src[at..].find("];").expect("EVENTS is a slice literal");
    let mut declared = string_literals(&src[at..end]);
    declared.sort();
    let mut expected = STATE_EVENTS.map(str::to_string).to_vec();
    expected.sort();
    if declared != expected {
        out.push(format!(
            "the injected hook events changed: {declared:?}. Every decision-capable event must \
             be registered `async: true` so it cannot gate Claude; confirm that, then update \
             the expected list."
        ));
    }

    for event in DECISION_EVENTS {
        if src.contains(&format!("\"{event}\"")) {
            out.push(format!(
                "hooks.rs names {event}, which Claude blocks on and reads a verdict from"
            ));
        }
    }

    let builder = fn_body(src, "base_settings_map");

    // The builder singles out exactly one event, and that singling-out *is* the
    // synchronous exception. A second `== "<Event>"` means a second hook has been
    // given special treatment.
    let compared = quoted_after(builder, "== \"");
    if compared != ["SessionEnd"] {
        out.push(format!(
            "the settings builder singles out {compared:?}; only SessionEnd may, and only \
             because teardown has no decision left to gate"
        ));
    }

    // …and the `async` flag is only ever turned on.
    let registrations = windows_after(builder, "\"async\"", 60);
    if registrations.len() != 1 {
        out.push(format!(
            "expected one `async` registration in the settings builder, found {}",
            registrations.len()
        ));
    }
    for near in registrations {
        if !near.contains("true") || near.contains("false") {
            out.push(format!(
                "a hook is registered `async: false` and can now gate Claude's decisions: {near}"
            ));
        }
    }
    out
}

/// COMPLIANCE.md, "It cannot gate the CLI's decisions": every hook Claude treats
/// as a decision channel is registered `async: true`, so Claude does not wait for
/// it and ignores whatever it emits — the hook *structurally cannot* approve or
/// deny anything. `SessionEnd` is the one synchronous *state* hook: it fires at
/// teardown, where there is no decision left to gate.
///
/// This covers the state hooks only. The English tutor deliberately registers a
/// second, synchronous `UserPromptSubmit` entry — synchronous precisely so its
/// stdout reaches the model — which is a separate, documented exception and not
/// something this test would or should catch.
///
/// Breaking this turns santree from an observer into a gate on the user's own
/// permission prompts — the difference between badging a worktree "needs you" and
/// answering the prompt for them.
///
/// The guarantee is `async`, not a list of event names. Verified against the
/// CLI's own settings schema: `async` is described there as "If true, hook runs
/// in background without blocking", and most of what santree injects is
/// decision-capable without it — `decision: "block"` is documented for `Stop`,
/// `UserPromptSubmit` and `PostToolUse` alike. So the structural checks below
/// (exactly one `async` registration, only ever `true`, and only `SessionEnd`
/// exempted) are the real test. `PreToolUse` is still checked by name because it
/// is the only hook that can *authorize* a tool call rather than comment on one.
///
/// A source scan, not a behavioural one: `hooks::base_settings_map` builds the
/// settings from a Tauri `AppHandle`, is private to its module, and tauri's
/// `test` feature isn't enabled, so the settings map cannot be produced here. If
/// that changes, replace this with a call and assert over the real JSON.
#[test]
fn no_injected_hook_can_gate_claude_and_pretooluse_is_never_injected() {
    let found = hook_registration_violations(&shipped("src-tauri/src/hooks.rs"));
    assert!(found.is_empty(), "{}", found.join("\n"));

    // The scan, proved to speak: a builder that added a per-tool hook and made a
    // second event synchronous has to come back with all four complaints. Without
    // this, a scan that silently stopped matching would read as compliance.
    const COULD_GATE_CLAUDE: &str = r#"
const EVENTS: &[&str] = &[
    "SessionStart", "UserPromptSubmit", "Notification",
    "PermissionRequest", "Stop", "SessionEnd", "PreToolUse",
];
fn base_settings_map(app: &AppHandle) -> Option<Map<String, Value>> {
    for &event in EVENTS {
        let is_end = event == "SessionEnd";
        let blocking = event == "PermissionRequest";
        if !is_end && !blocking {
            hook.insert("async".into(), json!(false));
        }
    }
    Some(root)
}
"#;
    assert_eq!(
        hook_registration_violations(COULD_GATE_CLAUDE).len(),
        4,
        "{:#?}",
        hook_registration_violations(COULD_GATE_CLAUDE)
    );
}

/// COMPLIANCE.md, "Global passthrough (opt-in)": the user's own status-line
/// command "is never interpreted by santree — it is one shell-quoted argument,
/// re-emitted only into that same settings file and executed only by the user's
/// own Claude".
///
/// Breaking this means a status-line command containing `$(…)`, a backtick or a
/// `;` gets executed by santree while it builds the settings file, rather than by
/// the user's Claude when it renders — arbitrary code execution out of a config
/// file santree rewrote. Behavioural: the generated command is handed to a real
/// `sh`, and what `sh` splits it into is what is asserted.
#[test]
fn the_status_line_passthrough_hands_the_users_command_on_as_one_argument() {
    use std::process::Command;

    let bin = crate::hooks::sh_quote("/Applications/santree.app/Contents/Resources/santree-hook");
    let db = crate::hooks::sh_quote("/Users/me/Library/Application Support/santree/santree.db");

    let plain = crate::hooks::statusline_command(&bin, &db, None);
    assert!(
        !plain.contains("--then"),
        "no passthrough means no --then: {plain}"
    );

    // Everything a shell would love to act on, in one command. The only effect
    // any of it could have is creating `marker`, which is what proves quoting.
    let marker = std::env::temp_dir().join(format!("santree-compliance-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let hostile = format!(
        "$(touch {m}) `touch {m}` ; echo 'quoted' $HOME && rm -f {m} | tee /dev/null",
        m = marker.display()
    );
    let line = crate::hooks::statusline_command(&bin, &db, Some(&hostile));

    // `printf '%s\n' <line>` makes the shell do exactly the word-splitting and
    // expansion Claude's own `command` would, then prints one argv element per
    // line — so the assertion below is over real argv, not over a string.
    let out = Command::new("sh")
        .arg("-c")
        .arg(format!("printf '%s\\n' {line}"))
        .output()
        .expect("running sh");
    assert!(
        out.status.success(),
        "sh rejected the generated command: {line}"
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let argv: Vec<&str> = stdout.lines().collect();

    assert_eq!(
        argv,
        [
            "/Applications/santree.app/Contents/Resources/santree-hook",
            "--db",
            "/Users/me/Library/Application Support/santree/santree.db",
            "statusline",
            "--then",
            hostile.as_str(),
        ],
        "the user's status-line command must survive verbatim, as one argument"
    );
    assert!(
        !marker.exists(),
        "the payload was executed rather than quoted"
    );
}

// ── COMPLIANCE.md § Review MCP server ───────────────────────────────────────

/// COMPLIANCE.md, "Nothing it writes leaves the machine": the review tool server
/// "has no network access, no GitHub token, and no `git`… It listens on nothing,
/// makes no network connection, and spawns no subprocess".
///
/// Breaking this is the difference between an agent that files a draft for the
/// user to send and one that posts under the user's name. This server is the one
/// process a model drives directly, so its inability to reach GitHub has to be
/// structural rather than a policy it is asked to follow.
///
/// (`crates/hook/src/passthrough.rs` does spawn `sh` — that is the status-line
/// passthrough running the *user's own* command, a different mode of the same
/// binary, and it is out of scope on purpose.)
#[test]
fn the_review_tool_server_can_reach_neither_github_nor_the_network() {
    let manifest = read("crates/hook/Cargo.toml");
    for http in [
        "reqwest", "hyper", "ureq", "curl", "isahc", "surf", "octocrab",
    ] {
        assert!(
            !manifest.contains(http),
            "the hook crate now depends on {http}; the review server must have no way out"
        );
    }
    // Its tokio is the workspace one with default features off; `net` or `full`
    // would hand it sockets.
    let tokio_line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("tokio ="))
        .expect("the hook crate pins tokio");
    for feature in ["\"net\"", "\"full\""] {
        assert!(
            !tokio_line.contains(feature),
            "the hook crate enables tokio {feature}: {tokio_line}"
        );
    }

    for module in ["crates/hook/src/mcp.rs", "crates/hook/src/review_tools.rs"] {
        let src = shipped(module);
        for reach in [
            "Command::new",
            "TcpStream",
            "TcpListener",
            "std::net::",
            "github",
        ] {
            assert!(
                !src.contains(reach),
                "{module} uses `{reach}`. The review tools write santree's own rows and \
                 nothing else; a subprocess or a socket is a way out of that."
            );
        }
    }
}

/// COMPLIANCE.md: the review server's "tools write three tables in santree's own
/// SQLite (`review_drafts`, `review_briefs`, `review_work_items`) for the PR named
/// in its argv, and nothing else."
///
/// Breaking this hands an agent-driven process write access to the rest of
/// santree's state — settings, terminal sessions, the repo list — from a tool call
/// the model chose to make.
#[test]
fn the_review_tools_write_only_santrees_own_three_tables() {
    const OWN_TABLES: [&str; 3] = ["review_drafts", "review_briefs", "review_work_items"];

    let src = shipped("crates/hook/src/review_tools.rs");
    let mut seen = 0usize;
    for sql in string_literals(&src) {
        for table in sql_tables(&sql) {
            seen += 1;
            assert!(
                OWN_TABLES.contains(&table.as_str()),
                "the review tools touch `{table}`, which is not one of santree's three \
                 review tables: {sql}"
            );
        }
    }
    assert!(
        seen > 5,
        "only {seen} table references found — the SQL scan has drifted"
    );

    // The scan, proved to speak: an upsert clause is not a table, and a real
    // reach into santree's other state is.
    assert_eq!(
        sql_tables("INSERT INTO review_briefs (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET b = 1"),
        ["review_briefs"]
    );
    assert_eq!(sql_tables("UPDATE settings SET value = ?"), ["settings"]);
    assert_eq!(sql_tables("SELECT token FROM linear_orgs"), ["linear_orgs"]);
}

/// COMPLIANCE.md: "In `review_work_items`, they may only have an existing
/// PR-scoped item marked complete; the agent cannot add, rewrite, or delete
/// items."
///
/// The work queue is the human's list of what a review asked for. An agent that
/// could add to it would be writing its own instructions; one that could delete
/// from it could quietly drop a reviewer's request and then report done.
#[test]
fn the_review_agent_may_only_complete_a_work_item_never_create_or_delete_one() {
    let src = shipped("crates/hook/src/review_tools.rs");
    let mut updates = 0usize;
    for sql in string_literals(&src) {
        let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        if !flat.contains("review_work_items") {
            continue;
        }
        for forbidden in [
            "INSERT INTO review_work_items",
            "DELETE FROM review_work_items",
        ] {
            assert!(
                !flat.contains(forbidden),
                "the review tools can now `{forbidden}`"
            );
        }
        if flat.contains("UPDATE review_work_items") {
            updates += 1;
            assert!(
                flat.contains("SET done = 1"),
                "the only update an agent may make is ticking an item off: {flat}"
            );
        }
    }
    assert_eq!(
        updates, 1,
        "expected exactly one work-item update statement, found {updates}"
    );
}

// COMPLIANCE.md's "the shared list is what keeps the server's tools and the grant
// the same set" is enforced beside the code, against the one shared
// `santree_core::review_tools::REVIEW_TOOL_NAMES`: `crates/hook`'s
// `review_tools.rs` asserts the server serves exactly it. The second end of that
// clamp used to be `codex.rs`, which auto-approved the same list on the App
// Server thread; it went with the server. Nothing to add here.

/// COMPLIANCE.md, "Two human decisions stand between an agent's finding and
/// anyone else seeing it":
/// `review_drafts::publish` is the only path out, and it runs the same
/// `reviews::add_inline_comment` the diff's own `+` button does, landing in the
/// user's *pending* review for them to submit.
///
/// Breaking this collapses the two human decisions the whole feature is built
/// around. `review_drafts.rs` is the one module holding agent-authored rows beside
/// a GitHub client, so a `submit_review`, an `add_issue_comment` or any other
/// mutation appearing here would let a model's finding post itself under the
/// user's name.
#[test]
fn the_only_path_from_an_agents_draft_to_github_is_the_users_pending_review() {
    // Reads that locate the PR, plus the one write. Nothing else belongs here.
    const PERMITTED: [&str; 5] = [
        "github::split_slug",
        "github::token",
        "github::pr_publish_anchor",
        "github::PrPublishAnchor",
        "reviews::add_inline_comment",
    ];

    let src = shipped("src-tauri/src/review_drafts.rs");
    for prefix in ["github::", "reviews::"] {
        for name in qualified_paths(&src, prefix) {
            assert!(
                PERMITTED.contains(&name.as_str()),
                "review_drafts.rs calls `{name}`. Publishing must stay the single write, \
                 into the user's pending review, on a click."
            );
        }
    }
    assert_eq!(
        src.matches("reviews::add_inline_comment").count(),
        1,
        "there should be exactly one call that puts a draft on GitHub"
    );

    // The scan, proved to speak: this is the shape it exists to catch.
    assert_eq!(
        qualified_paths(
            "if done { reviews::submit_review(&id).await?; }",
            "reviews::"
        ),
        ["reviews::submit_review"]
    );
}

// ── COMPLIANCE.md § Codex has no control plane ──────────────────────────────

/// COMPLIANCE.md, "Codex has no control plane": a Codex session is the
/// unmodified `codex` binary in a PTY, and the surfaces that used the App
/// Server's protocol ask the CLI instead.
///
/// This is the rule the previous version of this test could not state, because
/// it was written to keep the control plane *safe* rather than absent. The
/// server it guarded cost more than it protected: it outlived the app that
/// started it (87 orphaned `codex app-server` processes on one machine, the
/// oldest four days old), each holding a Unix socket, and it held Codex's
/// per-thread writer lock — which is what surfaced to users as "thread `<id>`
/// already has an active writer" when a thread was resumed.
///
/// Bringing one back is a re-litigation, not a refactor: a long-lived Codex
/// child that santree owns is a control plane whatever it is called, and the
/// writer-lock conflict comes back with it.
#[test]
fn santree_owns_no_codex_control_plane() {
    assert!(
        !repo_root().join("src-tauri/src/codex.rs").exists(),
        "codex.rs is back; the App Server and its socket were removed on purpose"
    );

    // The launch shape, not the word: `app-server` and `--listen` are how one is
    // started, and `unix://` is the address it would be reached on.
    for (path, src) in rust_sources() {
        for shape in ["app-server", "--listen", "unix://"] {
            assert!(
                !src.contains(shape),
                "{path} contains `{shape}`. santree runs the plain `codex` CLI; a \
                 santree-owned Codex service is what this rule exists to keep out."
            );
        }
    }

    // The scan, proved to speak: this is the shape it exists to catch.
    assert!(
        strip_rust_comments(r#"cmd.args(["app-server", "--listen", &addr]);"#)
            .contains("app-server")
    );
}

/// COMPLIANCE.md, "santree only tightens a Codex sandbox": the flag that turns
/// every guarantee off is never passed, from any surface.
///
/// `--dangerously-bypass-approvals-and-sandbox` is what other launchers default
/// to, and reaching for it is the natural move the first time a sandboxed
/// session cannot do something. It is also the end of the review story: the AI
/// review's findings reach GitHub only through `review_drafts::publish`, on a
/// click, and an agent that can escape its sandbox does not need that path.
///
/// Deliberately not a ban on the word "dangerous": `--dangerously-bypass-hook-trust`
/// is a different flag, is passed on purpose, and is documented where it is
/// emitted. This test names the one that must not appear.
#[test]
fn nothing_asks_codex_to_bypass_its_sandbox() {
    const BYPASS: &str = "--dangerously-bypass-approvals-and-sandbox";
    // `shipped`, not the whole file: the tests below `#[cfg(test)]` in
    // `codex_config.rs` feed exactly these strings in as hostile input, which is
    // how that module proves it rejects them.
    for (path, _) in rust_sources() {
        let src = shipped(&path);
        assert!(
            !src.contains(BYPASS),
            "{path} passes `{BYPASS}`. santree tightens a Codex sandbox or leaves \
             the user's alone; it never turns one off."
        );
        // The same thing under its other name.
        assert!(
            !src.contains("danger-full-access"),
            "{path} names Codex's unsandboxed mode"
        );
    }
    for rel in [
        "src/features/terminal/agentProvider.ts",
        "src/features/trees/useAgentTab.ts",
    ] {
        assert!(
            !read(rel).contains(BYPASS),
            "{rel} passes `{BYPASS}` into a Codex seed."
        );
    }

    // The scan, proved to speak.
    assert!(strip_rust_comments(&format!(r#"args.push("{BYPASS}");"#)).contains(BYPASS));
}

/// COMPLIANCE.md, "Never credential material": Codex owns its auth storage and
/// santree has no code path to it.
///
/// Distinct from the Claude carve-out above, which is a *scoped exception* with
/// one named reader. Codex has no exception at all: nothing in santree may read
/// `~/.codex/auth.json`, and the account status the UI shows comes from asking
/// the CLI (`codex login status`), which answers with a sentence about the store
/// rather than anything in it.
///
/// Breaking this is the difference between a terminal and a harness — and it is
/// an easy break to make by accident, because the file is plain JSON sitting
/// next to the rollouts santree already reads.
#[test]
fn nothing_reads_codexs_auth_storage() {
    // santree's *own* predecessor CLI kept its Linear OAuth token in a file of
    // the same name (`~/.config/santree/auth.json`), and migrating it into the
    // keychain is the whole point of that module. Our own credential is not an
    // agent CLI's — see CLAUDE.md, which draws the same line.
    const OURS: &str = "src-tauri/src/legacy.rs";

    for (path, src) in rust_sources() {
        for store in ["auth.json", "CODEX_API_KEY", "OPENAI_API_KEY"] {
            assert!(
                !src.contains(store) || path == OURS,
                "{path} reaches for Codex's credentials ({store}). Ask the CLI \
                 (`codex login status`) instead — santree never handles them."
            );
        }
    }

    // The one Codex file santree does read, and the terms it reads it on: a
    // rollout transcript, for display only.
    assert!(
        code("src-tauri/src/codex_rollouts.rs").contains("latest_rate_limits"),
        "the rollout snapshot is the only permitted source for Codex usage"
    );
}
