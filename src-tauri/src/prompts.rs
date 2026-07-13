//! AI prompt templates, rendered with minijinja.
//!
//! Each prompt ships with a readable `.njk` **default** embedded at compile time,
//! but the *effective* source is resolved at render time: a per-repo override,
//! then an app-wide override (both stored in the `settings` table under
//! `prompt.<name>`), then the embedded default. This lets users edit prompts from
//! Settings → Prompts while the binary stays self-contained and always has a
//! working fallback.
//!
//! Composition is by name: a prompt can embed another with `{% include "issue" %}`
//! (all prompts are registered in the render environment, so includes honor
//! overrides too), or receive a pre-rendered sub-prompt as a variable — the `work`
//! and `fill-pr` defaults take the `issue` prompt rendered into `ticket_content`.

use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, Context, Result};
use minijinja::{context, Environment, Value};
use santree_core::domain::{
    Priority, PromptInfo, PromptKind, PromptPreview, PromptVar, TriageComment, TriageDetail,
};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::settings;

/// One documented variable a prompt receives (name + human blurb for the editor).
struct VarDoc {
    name: &'static str,
    description: &'static str,
}

/// Static definition of one built-in prompt: identity, embedded default, and the
/// variable catalog surfaced to the editor. (Include links are computed live from
/// the source, not declared here, so they track user edits.)
struct PromptDef {
    name: &'static str,
    label: &'static str,
    description: &'static str,
    kind: PromptKind,
    default: &'static str,
    variables: &'static [VarDoc],
}

/// A user-created shared block: a reusable partial any flow can `{% include %}`.
/// Its content lives in the `settings` table like any other prompt override; this
/// manifest (app scope, [`BLOCKS_KEY`]) records which custom blocks exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CustomBlock {
    name: String,
    label: String,
}

/// App-scope settings key holding the JSON array of [`CustomBlock`] definitions.
const BLOCKS_KEY: &str = "prompt.custom_blocks";

/// Documented variables of the `issue` prompt — also available to any prompt that
/// `{% include "issue" %}`s it (the `work`/`fill-pr` flows flatten them in).
const ISSUE_VARS: &[VarDoc] = &[
    VarDoc { name: "tracker_name", description: "Issue tracker name, e.g. \"Linear\"." },
    VarDoc { name: "identifier", description: "Issue identifier, e.g. \"AK-165\"." },
    VarDoc { name: "title", description: "Issue title." },
    VarDoc { name: "url", description: "Canonical issue URL (may be empty)." },
    VarDoc { name: "state", description: "Workflow state name, e.g. \"In Progress\"." },
    VarDoc { name: "priority_label", description: "Urgent/High/Medium/Low — empty when unset." },
    VarDoc { name: "labels", description: "List of label names — use `{{ labels | join(\", \") }}`." },
    VarDoc { name: "description", description: "Markdown description (inline images as data URIs)." },
    VarDoc {
        name: "comments",
        description: "Threaded comments. Loop with `{% for c in comments %}`; each has `author`, `body`, and `children` (replies).",
    },
];

/// The built-in prompts, in editor display order (Flows first, then the built-in
/// block). Add a prompt here and drop its default `.njk` in `prompts/` together.
static PROMPT_DEFS: &[PromptDef] = &[
    PromptDef {
        name: "work",
        label: "Work / start task",
        description: "The agent's opening prompt when you start a task on a worktree.",
        kind: PromptKind::Flow,
        default: include_str!("../prompts/work.njk"),
        variables: &[
            VarDoc { name: "ticket_id", description: "The issue id, e.g. \"AK-165\"." },
            VarDoc { name: "title", description: "The worktree/issue title." },
            VarDoc {
                name: "ticket_content",
                description: "The rendered Issue block (description + comment thread). Empty when the issue couldn't be fetched.",
            },
            VarDoc { name: "custom_context", description: "The user's per-task notes, if any." },
            VarDoc { name: "mode", description: "\"implement\" (default) or \"plan\" (read-only planning)." },
        ],
    },
    PromptDef {
        name: "fill-commit",
        label: "Commit message",
        description: "Drafts a one-line commit message from the staged diff (headless).",
        kind: PromptKind::Flow,
        default: include_str!("../prompts/fill-commit.njk"),
        variables: &[
            VarDoc { name: "branch_name", description: "The worktree's git branch." },
            VarDoc { name: "ticket_id", description: "The issue id, empty for the base worktree." },
            VarDoc { name: "ticket_content", description: "The rendered Issue block, when available." },
            VarDoc { name: "diff_content", description: "The staged diff (capped at ~12k chars)." },
        ],
    },
    PromptDef {
        name: "fill-pr",
        label: "PR description",
        description: "Fills the repo's PR template from the branch diff + commits (headless).",
        kind: PromptKind::Flow,
        default: include_str!("../prompts/fill-pr.njk"),
        variables: &[
            VarDoc { name: "pr_template", description: "The repo's PR template markdown." },
            VarDoc { name: "branch_name", description: "The worktree's git branch." },
            VarDoc { name: "ticket_id", description: "The issue id." },
            VarDoc { name: "ticket_content", description: "The rendered Issue block (description + comments)." },
            VarDoc { name: "base_branch", description: "The PR's base branch." },
            VarDoc { name: "commit_log", description: "The branch's commit log vs base." },
            VarDoc { name: "diff_stat", description: "The `--stat` summary of changed files." },
            VarDoc { name: "diff", description: "The full branch diff vs base (capped)." },
        ],
    },
    PromptDef {
        name: "fix-ci",
        label: "Fix CI",
        description: "The agent's prompt when fixing a failed CI check on a worktree.",
        kind: PromptKind::Flow,
        default: include_str!("../prompts/fix-ci.njk"),
        variables: &[
            VarDoc { name: "ticket_id", description: "The issue id, empty for the base worktree." },
            VarDoc { name: "title", description: "The worktree/issue title." },
            VarDoc { name: "log_content", description: "The failing CI job log (sliced to the failing step)." },
        ],
    },
    PromptDef {
        name: "issue",
        label: "Issue context",
        description: "How a Linear issue (description + comment thread) is rendered. Embedded by the Work, Commit and PR prompts as `ticket_content`.",
        kind: PromptKind::Block,
        default: include_str!("../prompts/issue.njk"),
        variables: ISSUE_VARS,
    },
];

fn def(name: &str) -> Option<&'static PromptDef> {
    PROMPT_DEFS.iter().find(|d| d.name == name)
}

// ── Custom shared blocks ─────────────────────────────────────────────────────

/// The user-created shared blocks (from the app-scope manifest). A missing or
/// corrupt manifest yields none.
async fn custom_blocks(db: &Db) -> Vec<CustomBlock> {
    settings::get(db, "app", BLOCKS_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// A prompt name is a single lowercase identifier — safe as both a template name
/// and a settings key suffix. Enforced on block creation.
fn is_valid_block_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Repo id embedded in a scope string (`"repo:<name>"` → `Some("<name>")`,
/// `"app"` → `None`), for resolving the effective sources at an editor scope.
fn scope_repo(scope: &str) -> Option<&str> {
    scope.strip_prefix("repo:")
}

/// The `settings` key a prompt's override is stored under.
fn setting_key(name: &str) -> String {
    format!("prompt.{name}")
}

// ── Source resolution & rendering ────────────────────────────────────────────

/// Resolve one prompt's effective source for a scope (repo override → app value →
/// `fallback`).
async fn resolve_one(db: &Db, repo: Option<&str>, name: &str, fallback: &str) -> Result<String> {
    let key = setting_key(name);
    let src = match repo {
        Some(r) => settings::resolve(db, r, &key).await?,
        None => settings::get(db, "app", &key).await?,
    };
    Ok(src.unwrap_or_else(|| fallback.to_string()))
}

/// Every prompt's effective source — built-ins (repo override → app override →
/// embedded default) **plus** every user-created block (repo override → app
/// definition → empty) — owned so the built [`Environment`] can borrow it.
/// `repo == None` resolves against the app scope only.
pub async fn resolve_sources(db: &Db, repo: Option<&str>) -> Result<Vec<(String, String)>> {
    let mut out = Vec::with_capacity(PROMPT_DEFS.len());
    for d in PROMPT_DEFS {
        out.push((d.name.to_string(), resolve_one(db, repo, d.name, d.default).await?));
    }
    for b in custom_blocks(db).await {
        out.push((b.name.clone(), resolve_one(db, repo, &b.name, "").await?));
    }
    Ok(out)
}

/// Extract the template names a source `{% include %}`s, e.g.
/// `{% include "issue" %}` → `["issue"]`. A minimal hand-scan (no regex dep):
/// finds each `{% … %}` tag whose first word is `include` and pulls the first
/// quoted string. Duplicates are de-duped, order preserved.
fn scan_includes(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(open) = source[i..].find("{%") {
        let start = i + open + 2;
        let Some(close_rel) = source[start..].find("%}") else {
            break;
        };
        let close = start + close_rel;
        let tag = source[start..close].trim();
        let tag = tag.strip_prefix('-').unwrap_or(tag).trim_start();
        if let Some(rest) = tag.strip_prefix("include") {
            // Require a word boundary so `includes`/`included` don't match.
            if rest.starts_with(|c: char| c.is_whitespace()) {
                if let Some(name) = first_quoted(rest) {
                    if !out.contains(&name) {
                        out.push(name);
                    }
                }
            }
        }
        i = close + 2;
    }
    out
}

/// The first single- or double-quoted string in `s`, unquoted.
fn first_quoted(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let q = bytes.iter().position(|&b| b == b'"' || b == b'\'')?;
    let quote = bytes[q];
    let rest = &s[q + 1..];
    let end = rest.bytes().position(|b| b == quote)?;
    Some(rest[..end].to_string())
}

/// The embedded defaults as a source set — the baseline the render path falls back
/// to when nothing is overridden.
#[cfg(test)]
fn default_sources() -> Vec<(String, String)> {
    PROMPT_DEFS
        .iter()
        .map(|d| (d.name.to_string(), d.default.to_string()))
        .collect()
}

/// Add an empty stand-in for every `{% include %}` target that isn't itself a
/// real template — so a deleted/renamed block (or a typo'd include) renders empty
/// instead of erroring at render time, and a flow is never broken by a missing
/// partial. Returns the sources plus those stubs.
fn with_include_stubs(sources: &[(String, String)]) -> Vec<(String, String)> {
    let known: HashSet<&str> = sources.iter().map(|(n, _)| n.as_str()).collect();
    let mut all = sources.to_vec();
    for (_, src) in sources {
        for inc in scan_includes(src) {
            if !known.contains(inc.as_str()) && !all.iter().any(|(n, _)| *n == inc) {
                all.push((inc, String::new()));
            }
        }
    }
    all
}

/// Build a render environment from sources (borrows them). Every source is parsed
/// here, so a syntactically-broken template surfaces as an error.
fn build_env(sources: &[(String, String)]) -> Result<Environment<'_>> {
    let mut env = Environment::new();
    for (name, src) in sources {
        env.add_template(name, src)
            .with_context(|| format!("compiling prompt template: {name}"))?;
    }
    Ok(env)
}

/// Render `name` from an already-resolved source set. Missing context keys render
/// empty (minijinja is lenient), matching the templates' `{% if %}` guards. Prefer
/// this when you already hold sources (e.g. inside `spawn_blocking`).
pub fn render_from<S: Serialize>(
    sources: &[(String, String)],
    name: &str,
    ctx: S,
) -> Result<String> {
    let augmented = with_include_stubs(sources);
    let env = build_env(&augmented)?;
    let tmpl = env
        .get_template(name)
        .with_context(|| format!("unknown prompt template: {name}"))?;
    tmpl.render(ctx)
        .with_context(|| format!("rendering prompt template: {name}"))
}

/// Sentinels the preview render wraps around every `{{ expr }}` interpolation, so
/// the editor can tint the issue-specific values in the output — making the unique
/// part of each rendered ticket obvious against the template's static prose.
/// Private-use code points that never occur in real ticket text; the frontend
/// turns each pair into a highlight span (and strips any stray sentinel).
pub const MARK_OPEN: &str = "\u{E000}";
pub const MARK_CLOSE: &str = "\u{E001}";

/// Like [`render_from`], but wraps each interpolated (`{{ … }}`) value in
/// [`MARK_OPEN`]/[`MARK_CLOSE`] via a custom formatter — used only by the editor
/// preview so it can colorize substituted content. Control-flow (`{% … %}`) and
/// literal text emit nothing through the formatter, so they stay unmarked.
fn render_marked<S: Serialize>(sources: &[(String, String)], name: &str, ctx: S) -> Result<String> {
    let augmented = with_include_stubs(sources);
    let mut env = build_env(&augmented)?;
    env.set_formatter(|out, state, value| {
        out.write_str(MARK_OPEN)?;
        minijinja::escape_formatter(out, state, value)?;
        out.write_str(MARK_CLOSE)?;
        Ok(())
    });
    let tmpl = env
        .get_template(name)
        .with_context(|| format!("unknown prompt template: {name}"))?;
    tmpl.render(ctx)
        .with_context(|| format!("rendering prompt template: {name}"))
}

/// Resolve the current sources (honoring overrides) and render `name`. Convenience
/// for async callers that don't already hold a source set.
pub async fn render<S: Serialize>(
    db: &Db,
    repo: Option<&str>,
    name: &str,
    ctx: S,
) -> Result<String> {
    let sources = resolve_sources(db, repo).await?;
    render_from(&sources, name, ctx)
}

/// The context an issue supplies to the `issue` prompt (and to any flow that
/// flattens it in for `{% include "issue" %}`). Mirrors the CLI's `renderTicket`.
pub fn issue_context(detail: &TriageDetail) -> Value {
    let priority_label = match detail.priority {
        Priority::Urgent => Some("Urgent"),
        Priority::High => Some("High"),
        Priority::Medium => Some("Medium"),
        Priority::Low => Some("Low"),
        Priority::None => None,
    };
    context! {
        tracker_name => "Linear",
        identifier => &detail.id,
        title => &detail.title,
        url => &detail.url,
        state => &detail.state,
        priority_label,
        labels => &detail.labels,
        description => &detail.description,
        comments => &detail.comments,
    }
}

/// Render a fetched issue into the markdown the Work/Commit/PR prompts embed as
/// `ticket_content`, from the (editable) `issue` template, using held sources.
pub fn render_ticket_from(sources: &[(String, String)], detail: &TriageDetail) -> Result<String> {
    render_from(sources, "issue", issue_context(detail))
}

// ── Editor surface: list / blocks / validate / preview ───────────────────────

fn to_vars(vars: &[VarDoc]) -> Vec<PromptVar> {
    vars.iter()
        .map(|v| PromptVar {
            name: v.name.to_string(),
            description: v.description.to_string(),
        })
        .collect()
}

/// The union of every documented variable — shown as the palette for a custom
/// block, which can be included anywhere and so may see any flow's context.
fn all_variables() -> Vec<PromptVar> {
    let mut out: Vec<PromptVar> = Vec::new();
    for d in PROMPT_DEFS {
        for v in d.variables {
            if !out.iter().any(|e| e.name == v.name) {
                out.push(PromptVar {
                    name: v.name.to_string(),
                    description: v.description.to_string(),
                });
            }
        }
    }
    out
}

/// Every editable prompt — built-in flows/blocks plus user-created blocks — with
/// the override stored at `scope` (`"app"` / `"repo:<name>"`), its variable
/// palette, and the live composition links (includes / used-by) scanned from the
/// effective sources at that scope.
pub async fn list(db: &Db, scope: &str) -> Result<Vec<PromptInfo>> {
    let sources = resolve_sources(db, scope_repo(scope)).await?;
    // includes: name → what it includes; used_by: name → who includes it.
    let mut used_by: HashMap<String, Vec<String>> = HashMap::new();
    let includes: HashMap<String, Vec<String>> = sources
        .iter()
        .map(|(n, s)| (n.clone(), scan_includes(s)))
        .collect();
    for (from, incs) in &includes {
        for inc in incs {
            used_by.entry(inc.clone()).or_default().push(from.clone());
        }
    }
    for v in used_by.values_mut() {
        v.sort();
    }
    let links = |name: &str| {
        (
            includes.get(name).cloned().unwrap_or_default(),
            used_by.get(name).cloned().unwrap_or_default(),
        )
    };

    let mut out = Vec::new();
    for d in PROMPT_DEFS {
        let (inc, used) = links(d.name);
        out.push(PromptInfo {
            name: d.name.to_string(),
            label: d.label.to_string(),
            description: d.description.to_string(),
            kind: d.kind,
            builtin: true,
            default: d.default.to_string(),
            override_source: settings::get(db, scope, &setting_key(d.name)).await?,
            variables: to_vars(d.variables),
            includes: inc,
            used_by: used,
        });
    }
    for b in custom_blocks(db).await {
        let (inc, used) = links(&b.name);
        out.push(PromptInfo {
            name: b.name.clone(),
            label: b.label.clone(),
            description: "A custom shared block. Include it in any prompt with {% include \"…\" %}.".into(),
            kind: PromptKind::Block,
            builtin: false,
            default: String::new(),
            override_source: settings::get(db, scope, &setting_key(&b.name)).await?,
            variables: all_variables(),
            includes: inc,
            used_by: used,
        });
    }
    Ok(out)
}

/// Whether `name` is a known prompt: a built-in or a user-created block.
async fn is_known(db: &Db, name: &str) -> bool {
    def(name).is_some() || custom_blocks(db).await.iter().any(|b| b.name == name)
}

/// Parse-check a single template's `content` (syntax only). Returns the minijinja
/// error message on failure — the guard that keeps a broken template from being
/// persisted or from reaching a real flow.
fn compile_check(name: &str, content: &str) -> Result<()> {
    let mut env = Environment::new();
    env.add_template(name, content)
        .map_err(|e| anyhow!("{e:#}"))?;
    Ok(())
}

/// Store (or clear, when `content` is `None`) a prompt's override for `scope`,
/// after validating that a non-empty override compiles.
pub async fn set_prompt(db: &Db, scope: &str, name: &str, content: Option<String>) -> Result<()> {
    if !is_known(db, name).await {
        return Err(anyhow!("unknown prompt: {name}"));
    }
    if let Some(c) = &content {
        compile_check(name, c)?;
    }
    settings::set(db, scope, &setting_key(name), content).await
}

/// Create a user-defined shared block: validate the name, record it in the
/// app-scope manifest, and seed a starter body so it renders immediately.
pub async fn create_block(db: &Db, name: &str, label: &str) -> Result<()> {
    let name = name.trim();
    if !is_valid_block_name(name) {
        return Err(anyhow!(
            "Block name must be lowercase letters, digits or dashes (e.g. \"house-style\")."
        ));
    }
    if def(name).is_some() {
        return Err(anyhow!("'{name}' is a built-in prompt name."));
    }
    let mut blocks = custom_blocks(db).await;
    if blocks.iter().any(|b| b.name == name) {
        return Err(anyhow!("A block named '{name}' already exists."));
    }
    let label = label.trim();
    blocks.push(CustomBlock {
        name: name.to_string(),
        label: if label.is_empty() { name.to_string() } else { label.to_string() },
    });
    settings::set(db, "app", BLOCKS_KEY, Some(serde_json::to_string(&blocks)?)).await?;
    settings::set(
        db,
        "app",
        &setting_key(name),
        Some("Write your shared block here. Reference any variable available where it's included, then embed it in a prompt.\n".to_string()),
    )
    .await
}

/// Delete a user-defined block: drop it from the manifest and clear its content
/// across every scope. Prompts that still `{% include %}` it simply render it as
/// empty (missing templates are lenient), so this never breaks a flow.
pub async fn delete_block(db: &Db, name: &str) -> Result<()> {
    let mut blocks = custom_blocks(db).await;
    let before = blocks.len();
    blocks.retain(|b| b.name != name);
    if blocks.len() == before {
        return Err(anyhow!("no custom block named '{name}'"));
    }
    settings::set(db, "app", BLOCKS_KEY, Some(serde_json::to_string(&blocks)?)).await?;
    settings::clear_all_scopes(db, &setting_key(name)).await
}

/// Render a *draft* `content` for `name` for the live editor preview. When the
/// caller passes a real `detail` (the issue the editor already holds in cache) the
/// preview renders against that ticket (description + comments); otherwise a
/// built-in sample. Rendering here is pure — no fetch — so the editor can re-render
/// on every keystroke. Git-derived vars (diff, log, …) stay sample. Compile/render
/// errors are returned in [`PromptPreview::error`] rather than as a hard failure.
/// Includes resolve against the effective sources at `repo`'s scope, draft
/// substituted in.
pub async fn preview(
    db: &Db,
    name: &str,
    content: &str,
    repo: Option<&str>,
    detail: Option<TriageDetail>,
) -> Result<PromptPreview> {
    if !is_known(db, name).await {
        return Err(anyhow!("unknown prompt: {name}"));
    }
    let mut sources = resolve_sources(db, repo).await?;
    for s in sources.iter_mut() {
        if s.0 == name {
            s.1 = content.to_string();
        }
    }

    // The caller-supplied ticket (already in the editor's cache) when present,
    // else the representative sample. No fetch on this path.
    let detail = detail.unwrap_or_else(sample_detail);
    // Pre-render the issue so `ticket_content` is populated; ignore its errors (an
    // invalid `issue` draft still surfaces via the main render below).
    let ticket_content = render_ticket_from(&sources, &detail).unwrap_or_default();
    let ctx = context! {
        ticket_id => &detail.id,
        title => &detail.title,
        ticket_content => ticket_content,
        custom_context => "Focus on the token-refresh path.",
        mode => "implement",
        branch_name => "santree/ak-123-login-throttling",
        base_branch => "main",
        diff_content => SAMPLE_DIFF,
        diff => SAMPLE_DIFF,
        diff_stat => " src/auth.rs | 12 ++++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)",
        commit_log => "abc1234 [AK-123] add login throttling",
        pr_template => "## Summary\n\n## Test plan",
        log_content => "FAILED test_login\n##[error]make test exited with code 1",
        ..issue_context(&detail),
    };

    // `render_marked` so the editor can tint substituted values. `ticket_content`
    // is pre-rendered unmarked above, so in a flow the whole embedded issue block
    // reads as one span, while the `issue` prompt itself gets per-field spans.
    match render_marked(&sources, name, ctx) {
        Ok(output) => Ok(PromptPreview { output, error: None }),
        Err(e) => Ok(PromptPreview {
            output: String::new(),
            error: Some(format!("{e:#}")),
        }),
    }
}

/// A representative issue for the preview — a description plus a threaded comment.
fn sample_detail() -> TriageDetail {
    TriageDetail {
        id: "AK-123".into(),
        title: "Add login throttling".into(),
        priority: Priority::High,
        state: "In Progress".into(),
        state_id: None,
        states: Vec::new(),
        url: "https://linear.app/acme/issue/AK-123".into(),
        author: "Ada Lovelace".into(),
        author_avatar_url: None,
        created_at_ms: 0.0,
        labels: vec!["bug".into(), "backend".into()],
        project: Some("Auth".into()),
        sla_breach_ms: None,
        snoozed_until_ms: None,
        description: "Repeated failed logins aren't throttled. Add a per-IP limiter and return 429 after N attempts.".into(),
        comments: vec![TriageComment {
            id: "c1".into(),
            author: "Grace Hopper".into(),
            avatar_url: None,
            created_at_ms: 0.0,
            body: "Should this also cover the password-reset endpoint?".into(),
            children: vec![TriageComment {
                id: "c2".into(),
                author: "Ada Lovelace".into(),
                avatar_url: None,
                created_at_ms: 0.0,
                body: "Yes — same limiter, separate bucket.".into(),
                children: Vec::new(),
            }],
        }],
    }
}

const SAMPLE_DIFF: &str = "diff --git a/src/auth.rs b/src/auth.rs\n@@\n-fn login() {}\n+fn login() { throttle(); }";

#[cfg(test)]
mod tests {
    use minijinja::context;

    use super::*;

    /// Render a prompt from the embedded defaults (no DB), the baseline the
    /// production render path falls back to when nothing is overridden.
    fn render_default<S: Serialize>(name: &str, ctx: S) -> Result<String> {
        render_from(&default_sources(), name, ctx)
    }

    #[test]
    fn fill_commit_includes_ticket_prefix_when_present() {
        let out = render_default(
            "fill-commit",
            context! { branch_name => "santree/ak-1-x", ticket_id => "AK-1", diff_content => "diff" },
        )
        .unwrap();
        assert!(out.contains("[AK-1]"), "should show the ticket prefix");
        assert!(out.contains("diff"), "should embed the diff");
    }

    #[test]
    fn fill_commit_omits_prefix_without_ticket() {
        let out = render_default(
            "fill-commit",
            context! { branch_name => "scratch", diff_content => "diff" },
        )
        .unwrap();
        // The rendered examples carry no `[TICKET] ` prefix when there's no id.
        assert!(
            out.contains("\nadd login throttling"),
            "example has no prefix"
        );
        assert!(!out.contains("] add login throttling"), "no ticket prefix");
    }

    #[test]
    fn fill_commit_omits_prefix_for_base_worktree() {
        // worktree::commit_message maps the BASE_ID sentinel to `None` (not the
        // literal "__base__" string) before rendering, exactly like this — a
        // truthy sentinel string would otherwise slip past `{% if ticket_id %}`
        // and prefix every AI-drafted base-branch commit with `[__base__] `.
        let out = render_default(
            "fill-commit",
            context! {
                branch_name => "main",
                ticket_id => Option::<&str>::None,
                diff_content => "diff",
            },
        )
        .unwrap();
        assert!(
            out.contains("\nadd login throttling"),
            "example has no prefix"
        );
        assert!(!out.contains("] add login throttling"), "no ticket prefix");
        assert!(!out.contains("Ticket:"), "no ticket context line");
        assert!(
            !out.contains("__base__"),
            "sentinel id must never leak into the prompt"
        );
        assert!(out.contains("diff"), "should still embed the diff");
    }

    #[test]
    fn work_plan_mode_withholds_implementation() {
        let out = render_default(
            "work",
            context! { ticket_id => "AK-2", title => "Do thing", mode => "plan" },
        )
        .unwrap();
        assert!(
            out.contains("Do NOT implement yet"),
            "plan mode is read-only"
        );
    }

    #[test]
    fn fix_ci_embeds_log_and_forbids_commit() {
        let out = render_default(
            "fix-ci",
            context! {
                ticket_id => "AK-9",
                title => "Add throttling",
                log_content => "FAILED test_login\n##[error]make test exited with code 1",
            },
        )
        .unwrap();
        assert!(out.contains("AK-9"), "shows the ticket id");
        assert!(out.contains("FAILED test_login"), "embeds the failing log");
        assert!(out.contains("Do NOT commit"), "forbids committing");
        assert!(out.contains("Do NOT push"), "forbids pushing");
    }

    #[test]
    fn work_embeds_ticket_content_over_mcp_fallback() {
        let ticket = render_ticket_from(&default_sources(), &sample_detail()).unwrap();
        assert!(ticket.contains("Linear Issue: AK-123"));
        assert!(ticket.contains("Priority: High"));
        assert!(ticket.contains("Labels: bug, backend"));
        assert!(ticket.contains("throttled"));

        let out = render_default(
            "work",
            context! { ticket_id => "AK-123", ticket_content => ticket, mode => "implement" },
        )
        .unwrap();
        assert!(out.contains("throttled"), "ticket body is embedded");
        assert!(
            !out.contains("could not be fetched"),
            "fallback hint is skipped when ticket_content is present"
        );
    }

    /// A real (temp-file-backed) SQLite pool, isolated per test.
    async fn test_db() -> Db {
        let dir = std::env::temp_dir().join(format!("santree-prompts-{}", uuid::Uuid::new_v4()));
        crate::db::init(dir.join("test.db")).await.unwrap()
    }

    #[tokio::test]
    async fn override_wins_over_app_over_default() {
        let db = test_db().await;
        let ctx = || context! { ticket_id => "AK-1", title => "t", mode => "implement" };

        // No override anywhere → the embedded default.
        let out = render(&db, Some("canary"), "work", ctx()).await.unwrap();
        assert!(out.contains("Review the codebase"), "default body");

        // App override applies to any repo.
        set_prompt(&db, "app", "work", Some("APP {{ ticket_id }}".into()))
            .await
            .unwrap();
        assert_eq!(
            render(&db, Some("canary"), "work", ctx()).await.unwrap(),
            "APP AK-1"
        );

        // A repo override wins over the app override.
        set_prompt(&db, "repo:canary", "work", Some("REPO {{ ticket_id }}".into()))
            .await
            .unwrap();
        assert_eq!(
            render(&db, Some("canary"), "work", ctx()).await.unwrap(),
            "REPO AK-1"
        );
        // Other repos still see the app override.
        assert_eq!(
            render(&db, Some("other"), "work", ctx()).await.unwrap(),
            "APP AK-1"
        );

        // Clearing the repo override falls back to the app override again.
        set_prompt(&db, "repo:canary", "work", None).await.unwrap();
        assert_eq!(
            render(&db, Some("canary"), "work", ctx()).await.unwrap(),
            "APP AK-1"
        );
    }

    #[tokio::test]
    async fn include_honors_overridden_issue_template() {
        let db = test_db().await;
        // Override both `work` (to include `issue`) and `issue` itself.
        set_prompt(&db, "app", "work", Some(r#"START {% include "issue" %} END"#.into()))
            .await
            .unwrap();
        set_prompt(&db, "app", "issue", Some("ISSUE:{{ identifier }}".into()))
            .await
            .unwrap();

        let sources = resolve_sources(&db, None).await.unwrap();
        let out = render_from(&sources, "work", issue_context(&sample_detail())).unwrap();
        assert_eq!(out, "START ISSUE:AK-123 END");
    }

    #[tokio::test]
    async fn set_prompt_rejects_invalid_jinja() {
        let db = test_db().await;
        let err = set_prompt(&db, "app", "work", Some("{% if %}".into()))
            .await
            .unwrap_err();
        assert!(
            settings::get(&db, "app", "prompt.work").await.unwrap().is_none(),
            "a broken template must not be persisted"
        );
        let _ = err;
    }

    #[tokio::test]
    async fn preview_renders_sample_data() {
        let db = test_db().await;
        let p = preview(
            &db,
            "work",
            "Task {{ ticket_id }}: {{ title }}\n{{ ticket_content }}",
            None,
            None,
        )
        .await
        .unwrap();
        assert!(p.error.is_none(), "valid draft renders");
        // The preview wraps each `{{ }}` value in marker sentinels; strip them to
        // assert on the readable text.
        let plain = p.output.replace(MARK_OPEN, "").replace(MARK_CLOSE, "");
        assert!(plain.contains("Task AK-123: Add login throttling"));
        assert!(plain.contains("throttled"), "sample ticket embedded");
        // The interpolated values are marked; the literal prose is not.
        assert!(p.output.contains(&format!("{MARK_OPEN}AK-123{MARK_CLOSE}")), "value marked");
        assert!(p.output.contains("Task "), "literal text stays unmarked");
    }

    #[tokio::test]
    async fn preview_reports_render_error() {
        let db = test_db().await;
        let p = preview(&db, "work", "{% for x in %}", None, None)
            .await
            .unwrap();
        assert!(p.error.is_some(), "broken draft surfaces an error");
        assert!(p.output.is_empty());
    }

    #[test]
    fn scan_includes_finds_names_and_ignores_lookalikes() {
        let src =
            r#"{% include "issue" %} text {%- include 'house-style' -%} {% if includes %}{% endif %}"#;
        assert_eq!(scan_includes(src), vec!["issue", "house-style"]);
        // De-dupes and skips the `if`/word-boundary lookalikes.
        assert_eq!(scan_includes(r#"{% include "a" %}{% include "a" %}"#), vec!["a"]);
        assert!(scan_includes("no tags here").is_empty());
    }

    #[tokio::test]
    async fn custom_block_is_created_included_and_deleted() {
        let db = test_db().await;
        // Create a block and give it real content.
        create_block(&db, "house-style", "House style").await.unwrap();
        set_prompt(&db, "app", "house-style", Some("HOUSE {{ ticket_id }}".into()))
            .await
            .unwrap();
        // A flow that includes it resolves the block's content.
        set_prompt(&db, "app", "work", Some(r#"W {% include "house-style" %}"#.into()))
            .await
            .unwrap();
        let out = render(&db, Some("canary"), "work", context! { ticket_id => "AK-7" })
            .await
            .unwrap();
        assert_eq!(out, "W HOUSE AK-7");

        // It shows up in the listing with the live composition links.
        let listed = list(&db, "app").await.unwrap();
        let block = listed.iter().find(|p| p.name == "house-style").unwrap();
        assert!(!block.builtin);
        assert_eq!(block.used_by, vec!["work"]);
        let work = listed.iter().find(|p| p.name == "work").unwrap();
        assert_eq!(work.includes, vec!["house-style"]);

        // Deleting drops it from the manifest and clears its content everywhere;
        // the still-including flow now renders it empty rather than breaking.
        delete_block(&db, "house-style").await.unwrap();
        assert!(!list(&db, "app").await.unwrap().iter().any(|p| p.name == "house-style"));
        let out = render(&db, Some("canary"), "work", context! { ticket_id => "AK-7" })
            .await
            .unwrap();
        assert_eq!(out, "W ");
    }

    #[tokio::test]
    async fn create_block_rejects_bad_and_colliding_names() {
        let db = test_db().await;
        assert!(create_block(&db, "Bad Name", "x").await.is_err(), "spaces/caps rejected");
        assert!(create_block(&db, "work", "x").await.is_err(), "built-in name rejected");
        create_block(&db, "dup", "Dup").await.unwrap();
        assert!(create_block(&db, "dup", "Dup").await.is_err(), "duplicate rejected");
    }
}
