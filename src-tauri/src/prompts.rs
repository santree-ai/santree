//! AI prompt templates, rendered with minijinja.
//!
//! Each prompt ships with a readable `.njk` **default** embedded at compile time,
//! but the *effective* source is resolved at render time from four layers, most
//! specific first: the user's override for the repo, the repo's committed
//! `.santree/prompts/<name>.njk`, the user's app-wide override (both overrides
//! live in the `settings` table under `prompt.<name>`), then the embedded
//! default. Users edit the two overrides from Settings → Prompts; the project
//! file is the one a team commits, so a better prompt lands for everyone on the
//! next pull. The binary stays self-contained and always has a working fallback.
//!
//! A layer can **extend** the one below it instead of replacing it, with
//! standard Jinja inheritance: the render environment registers every prompt
//! three times — `santree/<name>` (the embedded default), `project/<name>` (what
//! the repo uses before the user's own repo override) and `<name>` (the
//! effective one) — so `{% extends "santree/triage" %}` plus a `{% block %}` is
//! the whole recipe. The defaults declare empty blocks (**slots**) where
//! project-specific knowledge belongs, which the editor offers as fields; a
//! layer that fills only those keeps receiving every other improvement to the
//! default.
//!
//! Composition is by name: a prompt can embed another with `{% include "issue" %}`
//! (includes honor the same layering), or receive a pre-rendered sub-prompt as a
//! variable — the `work` and `fill-pr` defaults take the `issue` prompt rendered
//! into `ticket_content`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use minijinja::{context, Environment, Value};
use santree_core::domain::{
    Priority, PromptInfo, PromptKind, PromptLayer, PromptPreview, PromptPreviewKind, PromptSlot,
    PromptVar, PromptWorkItemSample, ReviewWorkItemSource, TriageComment, TriageDetail,
};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::{repo, santree_dir, settings};

/// One documented variable a prompt receives (name + human blurb for the editor).
struct VarDoc {
    name: &'static str,
    description: &'static str,
}

/// One extension point a default declares: an empty `{% block <name> %}` where
/// project-specific knowledge belongs. The name is part of the prompt's contract
/// — a layer fills it by name — so `every_slot_is_an_empty_block_in_its_default`
/// pins each one to its template.
struct SlotDoc {
    name: &'static str,
    label: &'static str,
    hint: &'static str,
}

/// The one slot every editable flow ends with: whatever fits nowhere more
/// specific, appended after the default's own instructions.
const EXTRA_SLOT: SlotDoc = SlotDoc {
    name: "extra",
    label: "Anything else",
    hint: "Project-specific guidance that fits nowhere above.",
};

/// Static definition of one built-in prompt: identity, embedded default, and the
/// variable catalog surfaced to the editor. (Include links are computed live from
/// the source, not declared here, so they track user edits.)
struct PromptDef {
    name: &'static str,
    label: &'static str,
    description: &'static str,
    kind: PromptKind,
    /// False when the wording is part of a contract santree configures around the
    /// prompt — the English tutor's hook and its `Edit` grant — so the editor
    /// shows it and `set_prompt` refuses an override.
    editable: bool,
    preview: PromptPreviewKind,
    default: &'static str,
    /// The empty blocks the default declares, in document order.
    slots: &'static [SlotDoc],
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
    VarDoc { name: "tracker_name", description: "The issue tracker the ticket came from: \"Linear\" or \"Jira\"." },
    VarDoc { name: "identifier", description: "Issue identifier, e.g. \"AK-165\"." },
    VarDoc { name: "title", description: "Issue title." },
    VarDoc { name: "url", description: "Canonical issue URL (may be empty)." },
    VarDoc { name: "state", description: "Workflow state name, e.g. \"In Progress\"." },
    VarDoc { name: "priority_label", description: "Urgent/High/Medium/Low — empty when unset." },
    VarDoc { name: "labels", description: "List of label names — use `{{ labels | join(\", \") }}`." },
    VarDoc { name: "description", description: "Markdown description. Inline images are replaced with a placeholder, and the ticket text is capped (see `comments`)." },
    VarDoc {
        name: "comments",
        description: "Threaded comments. Loop with `{% for c in comments %}`; each has `author`, `created` (UTC date), `body`, and `children` (replies). Description + comments share a byte budget; anything past it is truncated.",
    },
];

/// The built-in prompts, grouped in editor display order. Add a prompt here and
/// drop its default `.njk` in `prompts/` together.
static PROMPT_DEFS: &[PromptDef] = &[
    PromptDef {
        name: "triage",
        label: "Triage investigation",
        description: "The agent's opening prompt when you Investigate a Triage issue. Unlike the other flows, the ticket's screenshots are kept (saved as local files the agent can Read), not stripped.",
        kind: PromptKind::Flow,
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/triage.njk"),
        slots: &[
            SlotDoc {
                name: "sources",
                label: "Live-data sources",
                hint: "Your observability and data tools, how to pick between them, and how to scope a query to the affected customer or tenant.",
            },
            SlotDoc {
                name: "conventions",
                label: "Ownership conventions",
                hint: "Ticket prefixes and the teams they map to, routing rules, CODEOWNERS quirks, and who to name as a reviewer.",
            },
            SlotDoc {
                name: "pitfalls",
                label: "Known pitfalls",
                hint: "What has burned an investigation before: tool quirks, deprecated systems, ids that look alike.",
            },
            EXTRA_SLOT,
        ],
        variables: &[
            VarDoc { name: "ticket_id", description: "The issue id, e.g. \"AK-165\"." },
            VarDoc { name: "title", description: "The issue title." },
            VarDoc {
                name: "ticket_content",
                description: "The rendered Issue block (description + comment thread). Its screenshots are rewritten to local file paths the agent can Read.",
            },
        ],
    },
    PromptDef {
        name: "work",
        label: "Work / start task",
        description: "The agent's opening prompt when you start a task on a worktree.",
        kind: PromptKind::Flow,
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/work.njk"),
        slots: &[EXTRA_SLOT],
        variables: &[
            VarDoc { name: "ticket_id", description: "The issue id, e.g. \"AK-165\"." },
            VarDoc { name: "title", description: "The worktree/issue title." },
            VarDoc {
                name: "ticket_content",
                description: "The rendered Issue block (description + comment thread). Empty when the issue couldn't be fetched.",
            },
            VarDoc {
                name: "tracker_name",
                description: "The repo's issue tracker, \"Linear\" or \"Jira\" — set even when the issue couldn't be fetched; empty when no tracker is connected.",
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
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/fill-commit.njk"),
        slots: &[EXTRA_SLOT],
        variables: &[
            VarDoc { name: "branch_name", description: "The worktree's git branch." },
            VarDoc { name: "ticket_id", description: "The issue id, empty for the base worktree." },
            VarDoc { name: "diff_content", description: "The staged diff (capped at ~12k chars)." },
        ],
    },
    PromptDef {
        name: "fill-pr",
        label: "PR description",
        description: "Fills the repo's PR template from the branch diff + commits (headless).",
        kind: PromptKind::Flow,
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/fill-pr.njk"),
        slots: &[EXTRA_SLOT],
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
        name: "pr-review",
        label: "AI review",
        description: "The agent's opening prompt for an AI review — the session that writes the brief and the draft comments through santree's own tools. Its hard-rules block is what keeps everything it produces inside santree until you publish it.",
        kind: PromptKind::Flow,
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/pr-review.njk"),
        slots: &[EXTRA_SLOT],
        variables: &[
            VarDoc { name: "pr_repo", description: "The pull request's repository, as `owner/name`." },
            VarDoc { name: "pr_number", description: "The pull request number." },
            VarDoc { name: "pr_title", description: "The pull request title." },
            VarDoc { name: "pr_body", description: "The pull request description (markdown)." },
            VarDoc { name: "pr_author", description: "The author's GitHub login." },
            VarDoc { name: "base_ref", description: "The PR's base branch." },
            VarDoc { name: "head_ref", description: "The PR's head branch." },
            VarDoc { name: "head_sha", description: "The PR's head commit SHA." },
            VarDoc { name: "diff_stat", description: "One-line summary of the changed files." },
            VarDoc { name: "diff", description: "The PR's full diff (capped; see `truncated`)." },
            VarDoc { name: "conversation", description: "The PR's existing comments and review threads." },
            VarDoc { name: "ticket_content", description: "The rendered Issue block for the PR's linked ticket. Empty when it has none." },
            VarDoc {
                name: "workspace",
                description: "True when a checkout of the PR's head exists for the agent to read. False for a PR in a repo santree has no local clone of — the prompt then tells the agent it only has the diff.",
            },
            VarDoc { name: "truncated", description: "True when the diff was cut to fit the budget." },
            VarDoc {
                name: "existing_drafts",
                description: "Drafts already saved for this PR (`path`, `line`, `body`), so a resumed review doesn't repeat itself.",
            },
        ],
    },
    PromptDef {
        name: "pr-fix",
        label: "Work on queue items",
        description: "The agent's opening prompt when you press Start work on a pull request's queue: every open item in it — a review thread, an AI draft, a failing check, a note of your own — with the live state of whatever raised it. The default explains each kind of item the queue holds, then lays the items out one by one inside a fence of untrusted data. Keep the fence.",
        kind: PromptKind::Flow,
        editable: true,
        preview: PromptPreviewKind::Queue,
        default: include_str!("../prompts/pr-fix.njk"),
        slots: &[EXTRA_SLOT],
        variables: &[
            VarDoc {
                name: "work_items",
                description: "The open items, structured — loop with `{% for item in work_items %}`, branch on `item.source` (`check`, `githubThread`, `aiDraft` or `manual`). Each has `id`, `description`, `path`, `line`, `startLine`, `latestSourceDiscussion` (the thread's comments as they read now — `author`, `body` — or the AI draft) and `latestCheckRun` (a failing check's `name`, `status`, `app`, `url`, `failingSteps`, `annotations`; `null` once it no longer runs). Every string in it has `<`, `>` and `&` escaped as `\\u003c`, `\\u003e`, `\\u0026`, so writing any field inside the `<untrusted-review-data>` fence is safe.",
            },
            VarDoc {
                name: "work_items_json",
                description: "The same items as one pretty-printed JSON blob, escaped the same way — for a template that would rather embed the queue whole.",
            },
            VarDoc { name: "pr_repo", description: "The pull request's repository, as `owner/name`." },
            VarDoc { name: "pr_number", description: "The pull request number." },
            VarDoc { name: "pr_title", description: "The pull request title." },
            VarDoc { name: "pr_body", description: "The pull request description (markdown)." },
            VarDoc { name: "pr_author", description: "The author's GitHub login." },
            VarDoc { name: "base_ref", description: "The PR's base branch." },
            VarDoc { name: "head_ref", description: "The PR's head branch." },
            VarDoc { name: "head_sha", description: "The PR's head commit SHA." },
            VarDoc { name: "diff_stat", description: "One-line summary of the changed files." },
            VarDoc { name: "diff", description: "The PR's full diff (capped; see `truncated`)." },
            VarDoc { name: "conversation", description: "The PR's existing comments and review threads." },
            VarDoc { name: "ticket_content", description: "The rendered Issue block for the PR's linked ticket. Empty when it has none." },
            VarDoc { name: "truncated", description: "True when the diff was cut to fit the budget." },
        ],
    },
    PromptDef {
        name: "english-tutor",
        label: "English tutor",
        description: "Injected into every Claude session santree launches while the English tutor is on (Settings → English tutor). It tells the agent to open with any corrections and append them to the practice log itself. Read-only: its wording is tied to the hook and the Edit grant santree configures around it, so a change here would break the append.",
        kind: PromptKind::Flow,
        editable: false,
        preview: PromptPreviewKind::Sample,
        default: include_str!("../prompts/english-tutor.njk"),
        slots: &[],
        variables: &[VarDoc {
            name: "log_path",
            description: "Absolute path of the practice log the agent appends corrections to. It has a matching `Edit` grant — point this somewhere else and the append will stop on a permission prompt.",
        }],
    },
    PromptDef {
        name: "english-analysis",
        label: "English analysis",
        description: "Turns the practice log into a priority list of habits to work on (headless). Runs only when you press Analyze in Settings → English tutor. Read-only: that pane shows the result in the shape this prompt asks for.",
        kind: PromptKind::Flow,
        editable: false,
        preview: PromptPreviewKind::Sample,
        default: include_str!("../prompts/english-analysis.njk"),
        slots: &[],
        variables: &[
            VarDoc { name: "log", description: "The practice log, newest entries last (capped at ~400 KB, oldest cut first)." },
            VarDoc { name: "entry_count", description: "How many corrections the log holds." },
        ],
    },
    PromptDef {
        name: "issue",
        label: "Issue context",
        description: "How a Linear or Jira issue (description + comment thread) is rendered. Embedded by the Work, Commit and PR prompts as `ticket_content`.",
        kind: PromptKind::Block,
        editable: true,
        preview: PromptPreviewKind::Ticket,
        default: include_str!("../prompts/issue.njk"),
        slots: &[],
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

/// A prompt name is a single lowercase identifier — safe as a template name, a
/// settings key suffix, and (as `<name>.njk`) one normal path component under
/// `.santree/prompts/`. Enforced on block creation and on every project write.
fn is_valid_block_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
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

/// Template-name prefix of a prompt's embedded default in the render
/// environment: `{% extends "santree/triage" %}` inherits the shipped prompt.
pub const DEFAULT_NS: &str = "santree/";
/// Template-name prefix of what the repo uses before the user's own repo
/// override — its committed file when it has one, else the layer below.
pub const PROJECT_NS: &str = "project/";

/// The layers one prompt resolves through, most specific first. Any of the
/// three overrides may be absent; only a built-in has a default.
struct Layers<'a> {
    personal_repo: Option<String>,
    project: Option<String>,
    personal_app: Option<String>,
    default: Option<&'a str>,
}

impl Layers<'_> {
    /// The three templates the environment registers for this prompt:
    /// `santree/<name>`, `project/<name>` and the effective `<name>`. A layer
    /// that is absent resolves to the one below it, so an `{% extends %}` of
    /// either namespace always finds a template.
    fn sources(self, name: &str) -> [(String, String); 3] {
        let default = self.default.unwrap_or("").to_string();
        let below_project = self.personal_app.unwrap_or_else(|| default.clone());
        let project = self.project.unwrap_or_else(|| below_project.clone());
        let effective = self.personal_repo.unwrap_or_else(|| project.clone());
        [
            (format!("{DEFAULT_NS}{name}"), default),
            (format!("{PROJECT_NS}{name}"), project),
            (name.to_string(), effective),
        ]
    }
}

/// A draft the editor wants rendered in place of one stored layer.
struct Draft<'a> {
    layer: PromptLayer,
    name: &'a str,
    content: &'a str,
}

/// Every prompt's sources, all three names each (see [`Layers::sources`]) —
/// built-ins, user-created blocks, and any block the repo's `.santree/prompts/`
/// defines on its own — owned so the built [`Environment`] can borrow it.
/// `repo == None` resolves against the app scope only.
pub async fn resolve_sources(db: &Db, repo: Option<&str>) -> Result<Vec<(String, String)>> {
    resolve_sources_with(db, repo, None).await
}

/// [`resolve_sources`] with one layer of one prompt replaced by `draft`.
async fn resolve_sources_with(
    db: &Db,
    repo: Option<&str>,
    draft: Option<Draft<'_>>,
) -> Result<Vec<(String, String)>> {
    let project_files = match repo {
        Some(r) => project_prompts(db, r).await,
        None => HashMap::new(),
    };
    let mut names: Vec<(String, Option<&'static str>)> = PROMPT_DEFS
        .iter()
        .map(|d| (d.name.to_string(), Some(d.default)))
        .collect();
    for b in custom_blocks(db).await {
        if !names.iter().any(|(n, _)| *n == b.name) {
            names.push((b.name, None));
        }
    }
    let mut project_only: Vec<&String> = project_files
        .keys()
        .filter(|k| !names.iter().any(|(n, _)| n == *k))
        .collect();
    project_only.sort();
    for k in project_only {
        names.push((k.clone(), None));
    }

    let mut out = Vec::with_capacity(names.len() * 3);
    for (name, default) in names {
        let key = setting_key(&name);
        let (personal_repo, personal_app) = match repo {
            Some(r) => settings::resolve_both(db, r, &key).await?,
            None => (None, settings::get(db, "app", &key).await?),
        };
        // A read-only prompt's wording is part of a hook contract; both write
        // paths refuse it, and the read path must not admit it from a file.
        let editable = def(&name).is_none_or(|d| d.editable);
        let mut layers = Layers {
            personal_repo,
            project: editable
                .then(|| project_files.get(&name).cloned())
                .flatten(),
            personal_app,
            default,
        };
        if let Some(d) = &draft {
            if d.name == name {
                match d.layer {
                    PromptLayer::Personal => match repo {
                        Some(_) => layers.personal_repo = Some(d.content.to_string()),
                        None => layers.personal_app = Some(d.content.to_string()),
                    },
                    PromptLayer::Project => layers.project = Some(d.content.to_string()),
                }
            }
        }
        out.extend(layers.sources(&name));
    }
    Ok(out)
}

// ── The repo's committed layer: .santree/prompts/<name>.njk ─────────────────

/// A project prompt larger than this is ignored rather than handed to an agent:
/// a prompt is prose, and anything past it is a file that landed there by
/// mistake.
const PROJECT_FILE_MAX: u64 = 256 * 1024;

/// Where `name`'s project file lives under `repo_root`. `name` is validated as
/// one path component, the join is checked once more at the sink, and neither
/// the directory nor an existing file may be a symlink: a clone can commit one
/// (git keeps them), and what it points at must never be read as a prompt or
/// written over as one.
fn project_file(repo_root: &Path, name: &str) -> Result<PathBuf> {
    if !is_valid_block_name(name) {
        bail!("prompt name must be lowercase letters, digits or dashes");
    }
    let dir = santree_dir::prompts_dir(repo_root);
    if !dir_is_within(&dir, repo_root) {
        bail!(".santree/prompts is a link outside the repo");
    }
    let path = crate::git::safe_path(&dir, &format!("{name}.njk"))?;
    if is_symlink(&path) {
        bail!("{} is a symlink", path.display());
    }
    Ok(path)
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Whether `dir`, once every link in it is resolved, still sits under `root`.
/// A directory that doesn't exist yet is within (it will be created there).
fn dir_is_within(dir: &Path, root: &Path) -> bool {
    match (std::fs::canonicalize(dir), std::fs::canonicalize(root)) {
        (Ok(real), Ok(real_root)) => real.starts_with(real_root),
        (Err(e), _) if e.kind() == std::io::ErrorKind::NotFound => true,
        _ => false,
    }
}

/// The repo's committed prompt layers, keyed by name — every `<name>.njk` in
/// `.santree/prompts/` of its **main checkout** whose stem is a valid prompt
/// name. Read fresh on every resolve (a `git pull` is live on the next launch),
/// and best-effort: a repo without a path, a missing directory or an unreadable
/// file is simply not a layer.
async fn project_prompts(db: &Db, repo: &str) -> HashMap<String, String> {
    let Ok(Some(root)) = repo::path(db, repo).await else {
        return HashMap::new();
    };
    tokio::task::spawn_blocking(move || read_project_prompts(Path::new(&root)))
        .await
        .unwrap_or_default()
}

fn read_project_prompts(repo_root: &Path) -> HashMap<String, String> {
    let dir = santree_dir::prompts_dir(repo_root);
    if !dir_is_within(&dir, repo_root) {
        log::warn!("ignoring {}: a link outside the repo", dir.display());
        return HashMap::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("njk") {
            continue;
        }
        // Only a real file: a symlink's target is whatever a commit chose.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            log::warn!("ignoring {}: not a regular file", path.display());
            continue;
        }
        let Some(name) = path.file_stem().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_valid_block_name(name) {
            log::warn!("ignoring {}: not a valid prompt name", path.display());
            continue;
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > PROJECT_FILE_MAX {
            log::warn!(
                "ignoring {}: larger than {PROJECT_FILE_MAX} bytes",
                path.display()
            );
            continue;
        }
        if let Ok(src) = std::fs::read_to_string(&path) {
            out.insert(name.to_string(), src);
        }
    }
    out
}

/// Write (or, with `None`, delete) `name`'s project file for `repo`, after the
/// same checks a stored override gets. Creates `.santree/` and its ignore file
/// on the way, so the file is committable the moment it exists.
pub async fn set_project_prompt(
    db: &Db,
    repo: &str,
    name: &str,
    content: Option<String>,
) -> Result<()> {
    if let Some(d) = def(name).filter(|d| !d.editable) {
        return Err(anyhow!("'{}' is read-only", d.label));
    }
    let root = repo::path(db, repo)
        .await?
        .ok_or_else(|| anyhow!("repo '{repo}' has no local path"))?;
    let path = project_file(Path::new(&root), name)?;
    if let Some(c) = &content {
        compile_check(name, c)?;
        check_extends(&[name, &format!("{PROJECT_NS}{name}")], c)?;
    }
    tokio::task::spawn_blocking(move || -> Result<()> {
        match content {
            Some(c) => {
                santree_dir::ensure(Path::new(&root))?;
                std::fs::create_dir_all(path.parent().expect("file has a parent"))?;
                std::fs::write(&path, c)?;
            }
            None => match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
        }
        Ok(())
    })
    .await?
}

/// The template a source `{% extends %}`, if any — the same hand-scan as
/// [`scan_includes`], for the one tag a file may carry once.
fn scan_extends(source: &str) -> Option<String> {
    let mut i = 0;
    while let Some(open) = source[i..].find("{%") {
        let start = i + open + 2;
        let close_rel = source[start..].find("%}")?;
        let close = start + close_rel;
        let tag = source[start..close].trim();
        let tag = tag.strip_prefix('-').unwrap_or(tag).trim_start();
        if let Some(rest) = tag.strip_prefix("extends") {
            if rest.starts_with(|c: char| c.is_whitespace()) {
                return first_quoted(rest);
            }
        }
        i = close + 2;
    }
    None
}

/// Refuse a layer that extends itself or anything above it in its own chain
/// (`forbidden`: the effective name is the top of every chain, and the project
/// name is the project file's own). minijinja would recurse until its depth
/// limit and fail the launch with a message about nesting; the write is where
/// the mistake is cheap to name.
fn check_extends(forbidden: &[&str], content: &str) -> Result<()> {
    match scan_extends(content) {
        Some(target) if forbidden.contains(&target.as_str()) => Err(anyhow!(
            "a prompt can't extend itself — extend \"{DEFAULT_NS}…\" or \"{PROJECT_NS}…\" instead"
        )),
        _ => Ok(()),
    }
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
pub(crate) fn default_sources() -> Vec<(String, String)> {
    PROMPT_DEFS
        .iter()
        .flat_map(|d| {
            Layers {
                personal_repo: None,
                project: None,
                personal_app: None,
                default: Some(d.default),
            }
            .sources(d.name)
        })
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

// ── Ticket context: sanitizing untrusted markdown for a prompt ───────────────

/// Byte budget for everything a ticket contributes to a prompt (its description
/// plus every comment body, images already stripped). The prompts that embed a
/// ticket also carry a diff — itself capped at 12k chars — so the ticket gets a
/// comparable slice: enough for any real thread, not enough for a runaway one to
/// crowd out the diff or blow the model's context.
const TICKET_BUDGET: usize = 16 * 1024;

/// Stands in for an image the prompt drops. Sits where the URL was, so
/// `![login screen](data:image/png;base64,…)` still reads as
/// `![login screen](image omitted)` — an agent can see there *was* an image.
const IMAGE_PLACEHOLDER: &str = "image omitted";

/// Marks where the budget ran out, so an agent can tell a short ticket from a cut one.
const TRUNCATED: &str = "\n\n…[truncated]";

/// Replace inlined `data:` URI payloads with [`IMAGE_PLACEHOLDER`].
///
/// `linear.rs` fetches a ticket's images and splices them into the markdown as
/// base64 data URIs (up to ~8 MB each) so the **UI** can render them inline. A
/// prompt must never carry those: the model can't see them, and one screenshot is
/// megabytes of base64 that would blow the budget below — and, before this, the
/// whole call. The alt text is deliberately kept.
fn strip_data_uris(md: &str) -> String {
    // A URI runs to the first character that can't appear in one — the same
    // boundary set `linear.rs` uses to find the URL it splices over.
    const DELIMS: &[char] = &[')', ' ', '\n', '\t', '"', ']', '>', '<'];
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(at) = rest.find("data:") {
        let (before, uri) = rest.split_at(at);
        let end = uri.find(DELIMS).unwrap_or(uri.len());
        out.push_str(before);
        // Every real data URI has the `,` separating its metadata from the payload.
        // Prose ("data: see the table below") has none and must survive intact.
        out.push_str(if uri[..end].contains(',') {
            IMAGE_PLACEHOLDER
        } else {
            &uri[..end]
        });
        rest = &uri[end..];
    }
    out.push_str(rest);
    out
}

/// The largest char-boundary offset in `s` at or below `max` bytes.
///
/// Every prompt budget in the app is counted in bytes while the text is UTF-8, so
/// slicing at a raw budget offset panics the moment a multi-byte character
/// straddles it. Anything trimming untrusted text to a byte budget goes through
/// here (see also `review_ai::truncate_at_line`).
pub fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// [`TICKET_BUDGET`], spent in render order across the ticket's markdown fields.
struct Budget(usize);

impl Budget {
    /// Sanitize one untrusted markdown field for a prompt — images out, then
    /// trimmed to whatever budget is left — and charge what it kept.
    fn take(&mut self, md: &str) -> String {
        let stripped = strip_data_uris(md);
        let kept = floor_char_boundary(&stripped, self.0);
        self.0 -= kept;
        if kept == stripped.len() {
            stripped
        } else {
            format!("{}{TRUNCATED}", &stripped[..kept])
        }
    }

    fn is_spent(&self) -> bool {
        self.0 == 0
    }
}

/// The comment shape a prompt sees: the domain comment, its body sanitized and
/// budgeted, plus the human-readable `created` the template renders (the domain
/// type carries only raw epoch ms, which the *frontend* formats live).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptComment {
    id: String,
    author: String,
    avatar_url: Option<String>,
    created_at_ms: f64,
    created: String,
    body: String,
    children: Vec<PromptComment>,
}

/// A comment's timestamp as a readable UTC date, or empty when it hasn't got one.
/// The template guards on it, so an absent date never leaves a dangling separator.
fn created_label(ms: f64) -> String {
    if ms <= 0.0 {
        return String::new();
    }
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default()
}

/// The comment thread in render order, each body charged against `budget`. Once
/// it's spent the remaining comments are dropped rather than rendered as headers
/// with no body.
fn prompt_comments(comments: &[TriageComment], budget: &mut Budget) -> Vec<PromptComment> {
    let mut out = Vec::new();
    for c in comments {
        if budget.is_spent() {
            break;
        }
        out.push(PromptComment {
            id: c.id.clone(),
            author: c.author.clone(),
            avatar_url: c.avatar_url.clone(),
            created_at_ms: c.created_at_ms,
            created: created_label(c.created_at_ms),
            body: budget.take(&c.body),
            children: prompt_comments(&c.children, budget),
        });
    }
    out
}

/// The context an issue supplies to the `issue` prompt (and to any flow that
/// flattens it in for `{% include "issue" %}`). Mirrors the CLI's `renderTicket`.
///
/// This is the single choke point where a ticket becomes prompt text — every call
/// site (work, fill-pr, the editor preview) goes through it — so it's where the
/// ticket's untrusted markdown is made safe to embed: inlined images out, one
/// shared byte budget across description and comments.
pub fn issue_context(detail: &TriageDetail) -> Value {
    let priority_label = match detail.priority {
        Priority::Urgent => Some("Urgent"),
        Priority::High => Some("High"),
        Priority::Medium => Some("Medium"),
        Priority::Low => Some("Low"),
        Priority::None => None,
    };
    let mut budget = Budget(TICKET_BUDGET);
    let description = budget.take(&detail.description);
    let comments = prompt_comments(&detail.comments, &mut budget);
    context! {
        tracker_name => &detail.tracker_name,
        identifier => &detail.id,
        title => &detail.title,
        url => &detail.url,
        state => &detail.state,
        priority_label,
        labels => &detail.labels,
        description,
        comments,
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
    let repo = scope_repo(scope);
    let sources = resolve_sources(db, repo).await?;
    let (project_files, project_root) = match repo {
        Some(r) => (
            project_prompts(db, r).await,
            repo::path(db, r).await?.map(PathBuf::from),
        ),
        None => (HashMap::new(), None),
    };
    let project_path = |name: &str| {
        project_root
            .as_deref()
            .and_then(|root| project_file(root, name).ok())
            .map(|p| p.to_string_lossy().into_owned())
    };
    // includes: name → what it includes; used_by: name → who includes it —
    // over the effective sources only, so the links read as the editor's rail.
    let mut used_by: HashMap<String, Vec<String>> = HashMap::new();
    let includes: HashMap<String, Vec<String>> = sources
        .iter()
        .filter(|(n, _)| !n.starts_with(DEFAULT_NS) && !n.starts_with(PROJECT_NS))
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
            editable: d.editable,
            preview: d.preview,
            default: d.default.to_string(),
            override_source: settings::get(db, scope, &setting_key(d.name)).await?,
            project_source: project_files.get(d.name).cloned(),
            project_path: project_path(d.name),
            slots: if d.editable {
                to_slots(d.slots)
            } else {
                Vec::new()
            },
            variables: to_vars(d.variables),
            includes: inc,
            used_by: used,
        });
    }
    let blocks = custom_blocks(db).await;
    for b in &blocks {
        let (inc, used) = links(&b.name);
        out.push(PromptInfo {
            name: b.name.clone(),
            label: b.label.clone(),
            description:
                "A custom shared block. Include it in any prompt with {% include \"…\" %}.".into(),
            kind: PromptKind::Block,
            builtin: false,
            editable: true,
            preview: PromptPreviewKind::Ticket,
            default: String::new(),
            override_source: settings::get(db, scope, &setting_key(&b.name)).await?,
            project_source: project_files.get(&b.name).cloned(),
            project_path: project_path(&b.name),
            slots: Vec::new(),
            variables: all_variables(),
            includes: inc,
            used_by: used,
        });
    }
    // Blocks the repo defines on its own — a file with no manifest entry — so
    // the rail shows what a checked-out `.santree/prompts/` really carries.
    let mut project_only: Vec<&String> = project_files
        .keys()
        .filter(|k| def(k).is_none() && !blocks.iter().any(|b| b.name == **k))
        .collect();
    project_only.sort();
    for name in project_only {
        let (inc, used) = links(name);
        out.push(PromptInfo {
            name: name.clone(),
            label: name.clone(),
            description: "A shared block from this project's .santree/prompts/. Include it in any prompt with {% include \"…\" %}.".into(),
            kind: PromptKind::Block,
            builtin: false,
            editable: true,
            preview: PromptPreviewKind::Ticket,
            default: String::new(),
            override_source: settings::get(db, scope, &setting_key(name)).await?,
            project_source: project_files.get(name).cloned(),
            project_path: project_path(name),
            slots: Vec::new(),
            variables: all_variables(),
            includes: inc,
            used_by: used,
        });
    }
    Ok(out)
}

fn to_slots(slots: &[SlotDoc]) -> Vec<PromptSlot> {
    slots
        .iter()
        .map(|s| PromptSlot {
            name: s.name.to_string(),
            label: s.label.to_string(),
            hint: s.hint.to_string(),
        })
        .collect()
}

/// Whether `name` is a known prompt: a built-in, a user-created block, or (at a
/// repo's scope) a block that repo's `.santree/prompts/` defines.
async fn is_known(db: &Db, repo: Option<&str>, name: &str) -> bool {
    if def(name).is_some() || custom_blocks(db).await.iter().any(|b| b.name == name) {
        return true;
    }
    match repo {
        Some(r) => project_prompts(db, r).await.contains_key(name),
        None => false,
    }
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
    if !is_known(db, scope_repo(scope), name).await {
        return Err(anyhow!("unknown prompt: {name}"));
    }
    // The editor doesn't offer it, and the command line behind the editor
    // mustn't either: the tutor's wording is part of the hook contract.
    if let Some(d) = def(name).filter(|d| !d.editable) {
        return Err(anyhow!("'{}' is read-only", d.label));
    }
    if let Some(c) = &content {
        compile_check(name, c)?;
        check_extends(&[name], c)?;
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
        label: if label.is_empty() {
            name.to_string()
        } else {
            label.to_string()
        },
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
/// built-in sample. `work_items` is the editor's sample queue for the `pr-fix`
/// prompt — built in the UI, item by item — or a built-in one when it hasn't made
/// one. Rendering here is pure — no fetch — so the editor can re-render on every
/// keystroke. Git-derived vars (diff, log, …) stay sample. Compile/render errors
/// are returned in [`PromptPreview::error`] rather than as a hard failure.
/// Includes resolve against the effective sources at `repo`'s scope, with the
/// draft standing in for the stored `layer` — so a project-file draft previews
/// under the user's own override, exactly as it would render.
pub async fn preview(
    db: &Db,
    name: &str,
    content: &str,
    repo: Option<&str>,
    layer: PromptLayer,
    detail: Option<TriageDetail>,
    work_items: Option<Vec<PromptWorkItemSample>>,
) -> Result<PromptPreview> {
    if !is_known(db, repo, name).await && !is_valid_block_name(name) {
        return Err(anyhow!("unknown prompt: {name}"));
    }
    let draft = Draft {
        layer,
        name,
        content,
    };
    let sources = resolve_sources_with(db, repo, Some(draft)).await?;

    // The caller-supplied ticket (already in the editor's cache) when present,
    // else the representative sample. No fetch on this path.
    let detail = detail.unwrap_or_else(sample_detail);
    // Pre-render the issue so `ticket_content` is populated; ignore its errors (an
    // invalid `issue` draft still surfaces via the main render below).
    let ticket_content = render_ticket_from(&sources, &detail).unwrap_or_default();
    // The sample queue goes through the same builder as a real one, so the
    // preview shows the JSON the agent gets and not an approximation of it.
    let work_items = work_items.unwrap_or_else(sample_work_items);
    let tasks = crate::review_ai::sample_fix_tasks(&work_items);
    // `context!` takes one `..` spread beside keys, so the two merged blocks —
    // the queue and the issue fields — are folded first.
    let shared = context! {
        ..crate::review_ai::fix_context(&tasks)?,
        ..issue_context(&detail),
    };
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
        log_path => "~/.config/santree/english-practice-log.md",
        log => SAMPLE_PRACTICE_LOG,
        entry_count => 3,
        pr_repo => "acme/project",
        pr_number => 128,
        pr_title => "Throttle failed logins",
        pr_body => "Adds a per-account backoff after five failed attempts.",
        pr_author => "octocat",
        base_ref => "main",
        head_ref => "santree/ak-123-login-throttling",
        head_sha => "abc1234def5678",
        conversation => "**octocat**:\nReady for another look.",
        workspace => true,
        truncated => false,
        existing_drafts => Vec::<minijinja::Value>::new(),
        ..shared,
    };

    // `render_marked` so the editor can tint substituted values. `ticket_content`
    // is pre-rendered unmarked above, so in a flow the whole embedded issue block
    // reads as one span, while the `issue` prompt itself gets per-field spans.
    match render_marked(&sources, name, ctx) {
        Ok(output) => Ok(PromptPreview {
            output,
            error: None,
        }),
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
        tracker_name: "Linear".into(),
        state: "In Progress".into(),
        state_id: None,
        states: Vec::new(),
        url: "https://linear.app/acme/issue/AK-123".into(),
        author: "Ada Lovelace".into(),
        author_avatar_url: None,
        created_at_ms: 0.0,
        labels: vec!["bug".into(), "backend".into()],
        project: Some("Auth".into()),
        project_milestone: None,
        assignee: Some("Ada Lovelace".into()),
        assignee_avatar_url: None,
        estimate: Some(3.0),
        cycle: None,
        due_date: None,
        sla_breach_ms: None,
        snoozed_until_ms: None,
        description: "Repeated failed logins aren't throttled. Add a per-IP limiter and return 429 after N attempts.".into(),
        comments: vec![TriageComment {
            id: "c1".into(),
            author: "Grace Hopper".into(),
            avatar_url: None,
            created_at_ms: 1_752_000_000_000.0,
            body: "Should this also cover the password-reset endpoint?".into(),
            children: vec![TriageComment {
                id: "c2".into(),
                author: "Ada Lovelace".into(),
                avatar_url: None,
                created_at_ms: 1_752_003_600_000.0,
                body: "Yes — same limiter, separate bucket.".into(),
                children: Vec::new(),
            }],
        }],
    }
}

const SAMPLE_DIFF: &str =
    "diff --git a/src/auth.rs b/src/auth.rs\n@@\n-fn login() {}\n+fn login() { throttle(); }";

/// A practice log the English analysis preview renders over: two days, three
/// corrections, in the format the tutor appends.
const SAMPLE_PRACTICE_LOG: &str = "## 2026-08-30\n\n- how we can do this -> how can we do this (question inversion)\n- the datas are -> the data is (uncountable noun)\n\n## 2026-09-01\n\n- I will explain you -> I will explain to you (explain takes \"to\")\n";

/// The preview's stand-in work queue when the editor hasn't built one: one item
/// of each kind, so every branch of the `pr-fix` template has something to show.
fn sample_work_items() -> Vec<PromptWorkItemSample> {
    let item =
        |source, description: &str, line: Option<u32>, author: Option<&str>, body: Option<&str>| {
            PromptWorkItemSample {
                source,
                description: description.into(),
                path: line.map(|_| "src/auth.rs".into()),
                line,
                author: author.map(Into::into),
                body: body.map(Into::into),
            }
        };
    vec![
        item(
            ReviewWorkItemSource::Check,
            "Fix failing check: test (ubuntu-latest)",
            Some(42),
            Some("test (ubuntu-latest)"),
            Some("assertion failed: attempts <= 5"),
        ),
        item(
            ReviewWorkItemSource::GithubThread,
            "Reset the counter after a successful login",
            Some(31),
            Some("octocat"),
            Some("The counter never resets after a success, so a slow typist locks themselves out."),
        ),
        item(
            ReviewWorkItemSource::AiDraft,
            "The limiter keys on a client-controlled header",
            Some(18),
            None,
            Some("`X-Forwarded-For` is client-controlled; key on the peer address unless the app sits behind a trusted proxy."),
        ),
        item(
            ReviewWorkItemSource::Manual,
            "Add a test for the 429 response body",
            None,
            None,
            None,
        ),
    ]
}

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
    fn triage_embeds_the_ticket_and_names_screenshots() {
        let ticket = render_ticket_from(&default_sources(), &sample_detail()).unwrap();
        let out = render_default(
            "triage",
            context! { ticket_id => "AK-123", title => "Add login throttling", ticket_content => ticket },
        )
        .unwrap();
        assert!(out.contains("AK-123"), "names the ticket");
        assert!(out.contains("throttled"), "embeds the ticket body");
        // The investigation-specific instruction: screenshots are local files to Read.
        assert!(out.contains("Read"), "tells the agent to Read");
        assert!(
            out.to_lowercase().contains("screenshot"),
            "calls out the screenshots"
        );
    }

    /// After the investigation flow extracts a ticket's images to files, their
    /// markdown links are plain file paths — `strip_data_uris` must leave those
    /// intact (only `data:` URIs are stripped), so the agent sees the path to Read
    /// instead of an `image omitted` placeholder.
    #[test]
    fn extracted_file_path_images_survive_the_ticket_render() {
        let mut detail = sample_detail();
        detail.description =
            "Repro:\n\n![login screen](/tmp/santree/AK-123.images/0.png)\n\nSee above.".into();
        let out = render_ticket_from(&default_sources(), &detail).unwrap();
        assert!(
            out.contains("![login screen](/tmp/santree/AK-123.images/0.png)"),
            "the file-path image link is kept, got:\n{out}"
        );
        assert!(
            !out.contains("image omitted"),
            "a file path is not stripped"
        );
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
    fn fill_commit_does_not_reference_ticket_content() {
        // The commit-message caller supplies no ticket (only branch + staged diff),
        // so the template must not have a slot for one: the editor preview would
        // fill it and production never would.
        let out = render_default(
            "fill-commit",
            context! {
                branch_name => "santree/ak-1-x",
                ticket_id => "AK-1",
                diff_content => "diff",
                ticket_content => "TICKET BODY THAT NO CALLER PASSES",
            },
        )
        .unwrap();
        assert!(!out.contains("TICKET BODY THAT NO CALLER PASSES"));
    }

    #[test]
    fn pr_review_names_its_tools_and_forbids_every_other_write() {
        let out = render_default(
            "pr-review",
            context! {
                pr_number => 7,
                pr_title => "Add throttling",
                diff => "@@ -1,2 +1,2 @@",
                diff_stat => "src/auth.rs (modified, +8 -4)",
                workspace => true,
            },
        )
        .unwrap();
        // The tools are the only output path, so the prompt has to name them.
        assert!(out.contains("set_review_brief"));
        assert!(out.contains("add_review_comment"));
        assert!(out.contains("list_review_comments"));
        assert!(out.contains("Notion, Linear, Jira, whatever is connected"));
        // And the rule that makes the whole feature safe to leave running.
        assert!(out.contains("Never write through any other tool"));
        assert!(out.contains("<pull-request>"), "fences the untrusted diff");
    }

    /// The title and author are attacker-controlled — anyone who can open a PR
    /// picks them — so they must appear only *inside* the `<pull-request>` fence
    /// that tells the model to treat what follows as data. They used to be
    /// interpolated into the opening line of the system preamble, dozens of lines
    /// above that disclaimer, where a title carrying its own markdown headings
    /// reads as further instructions. It matters more now that the review can run
    /// in the user's own worktree rather than a throwaway checkout.
    #[test]
    fn pr_review_keeps_untrusted_title_and_author_inside_the_fence() {
        let out = render_default(
            "pr-review",
            context! {
                pr_number => 7,
                pr_title => "INJECTED_TITLE",
                pr_author => "INJECTED_AUTHOR",
                diff => "@@ -1,2 +1,2 @@",
                workspace => true,
            },
        )
        .unwrap();
        let fence = out.find("<pull-request>").expect("the diff is fenced");
        let preamble = &out[..fence];
        assert!(
            !preamble.contains("INJECTED_TITLE"),
            "the PR title must not reach the preamble:\n{preamble}"
        );
        assert!(
            !preamble.contains("INJECTED_AUTHOR"),
            "the PR author must not reach the preamble:\n{preamble}"
        );
        // Still shown — moved, not dropped.
        assert!(out.contains("INJECTED_TITLE"));
        assert!(out.contains("INJECTED_AUTHOR"));
        // The number is ours (a u32), so it can still identify the PR up front.
        assert!(preamble.contains("#7"));
    }

    #[test]
    fn english_tutor_plain_text_is_not_json_shaped() {
        let out = render_default(
            "english-tutor",
            context! { log_path => "/tmp/english-practice.md" },
        )
        .unwrap();
        assert!(!out.starts_with(['[', '{']));
    }

    #[test]
    fn builtins_have_one_review_prompt_and_follow_workflow_order() {
        let names: Vec<_> = PROMPT_DEFS.iter().map(|prompt| prompt.name).collect();
        assert_eq!(
            names,
            [
                "triage",
                "work",
                "fill-commit",
                "fill-pr",
                "pr-review",
                "pr-fix",
                "english-tutor",
                "english-analysis",
                "issue",
            ]
        );
        assert!(
            !names.contains(&"review"),
            "the retired Ask AI prompt stays deleted"
        );
    }

    #[test]
    fn pr_review_says_when_there_is_no_checkout_to_read() {
        // A PR in a repo santree has no clone of: the agent has the diff and
        // nothing else, and guessing at the surrounding code is the failure mode.
        let out = render_default(
            "pr-review",
            context! { pr_number => 7, pr_title => "x", workspace => false },
        )
        .unwrap();
        assert!(out.contains("reason from the diff"), "{out}");
        assert!(!out.contains("your working directory is a checkout"));
    }

    /// R11: the template used to print a `created` field that the context never
    /// carried (the domain type only has `createdAtMs`), so every comment rendered
    /// with a dangling `**author** — `.
    #[test]
    fn issue_renders_comment_dates_with_no_dangling_separator() {
        let out = render_ticket_from(&default_sources(), &sample_detail()).unwrap();
        assert!(
            out.contains("**Grace Hopper** — 2025-07-08 18:40 UTC"),
            "comment carries a readable date, got:\n{out}"
        );
        assert!(
            out.contains("**Ada Lovelace** — 2025-07-08 19:40 UTC"),
            "so does a threaded reply"
        );
        assert!(!out.contains("— \n"), "no separator without a date");
    }

    /// A comment with no usable timestamp drops the separator rather than trailing it.
    #[test]
    fn issue_omits_the_separator_when_a_comment_has_no_date() {
        let mut detail = sample_detail();
        detail.comments[0].created_at_ms = 0.0;
        detail.comments[0].children.clear();
        let out = render_ticket_from(&default_sources(), &detail).unwrap();
        assert!(
            out.contains("**Grace Hopper**\n"),
            "author, then straight to the body"
        );
        assert!(!out.contains("Grace Hopper** —"));
    }

    /// A ticket carrying a screenshot: Linear images are inlined as base64 data URIs
    /// for the UI, and one is megabytes. The prompt must get a placeholder instead —
    /// this is what silently broke fill-PR on any ticket with a screenshot.
    #[test]
    fn ticket_images_never_reach_the_prompt() {
        let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
        let mut detail = sample_detail();
        detail.description = format!("Repro:\n\n![login screen]({image})\n\nSee above.");
        detail.comments[0].body = format!("Same here ![trace]({image})");

        let out = render_ticket_from(&default_sources(), &detail).unwrap();
        assert!(!out.contains("base64"), "no payload survives");
        assert!(out.len() < 4_096, "megabytes must not reach the prompt");
        assert!(
            out.contains("![login screen](image omitted)"),
            "a stripped image leaves a readable placeholder, got:\n{out}"
        );
        assert!(out.contains("![trace](image omitted)"), "comments too");
        assert!(out.contains("See above."), "surrounding prose is intact");
    }

    /// Text (not just images) is bounded too, so one runaway thread can't crowd the
    /// diff out of the prompt — and the cut is marked, so the agent knows it's partial.
    #[test]
    fn ticket_text_is_capped_and_the_cut_is_marked() {
        let mut detail = sample_detail();
        detail.description = "x".repeat(TICKET_BUDGET * 4);
        let out = render_ticket_from(&default_sources(), &detail).unwrap();
        assert!(out.contains(TRUNCATED), "the truncation is visible");
        assert!(out.len() < TICKET_BUDGET + 1_024, "bounded by the budget");
        // The budget is shared, so a description that eats it drops the comments
        // rather than appending them past the cap.
        assert!(!out.contains("password-reset endpoint"));
    }

    /// The budget spans description *and* comments — a thread of many small comments
    /// is bounded the same way one huge field is.
    #[test]
    fn the_budget_is_shared_across_the_whole_thread() {
        let mut detail = sample_detail();
        detail.description = String::new();
        detail.comments = (0..500)
            .map(|i| TriageComment {
                id: format!("c{i}"),
                author: "Bot".into(),
                avatar_url: None,
                created_at_ms: 1_752_000_000_000.0,
                body: "y".repeat(1_024),
                children: Vec::new(),
            })
            .collect();
        let out = render_ticket_from(&default_sources(), &detail).unwrap();
        assert!(
            out.len() < TICKET_BUDGET * 2,
            "500 × 1 KB is bounded, got {}",
            out.len()
        );
    }

    #[test]
    fn strip_data_uris_spares_prose_that_merely_says_data() {
        assert_eq!(
            strip_data_uris("The data: see below, and data:image/png;base64,AAAA here."),
            "The data: see below, and image omitted here."
        );
        // No data URI at all → byte-for-byte identical.
        let plain = "Just a normal ticket body with a [link](https://example.com).";
        assert_eq!(strip_data_uris(plain), plain);
    }

    /// Truncation lands on a char boundary — a multi-byte character must not be cut
    /// in half (that would panic the slice, not just garble the text).
    #[test]
    fn truncation_respects_char_boundaries() {
        let mut budget = Budget(5);
        // "héllo" — the 'é' straddles bytes 1..3.
        let out = budget.take("héllo");
        assert!(out.starts_with("héll"), "cut on a boundary, got {out:?}");
        assert!(out.ends_with(TRUNCATED));
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

    /// With no ticket body the agent is told to fetch it itself, through the
    /// repo's own tracker — and never pointed at a tracker the repo doesn't use.
    #[test]
    fn work_fallback_names_the_repos_tracker() {
        let fallback = |tracker: &str| {
            render_default(
                "work",
                context! { ticket_id => "SAN-4", tracker_name => tracker, mode => "implement" },
            )
            .unwrap()
        };
        let jira = fallback("Jira");
        assert!(jira.contains("If a Jira MCP server is available"));
        assert!(!jira.contains("Linear"));

        let none = fallback("");
        assert!(none.contains("If an issue-tracker MCP server is available"));
        assert!(!none.contains("Linear"));
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
        set_prompt(
            &db,
            "repo:canary",
            "work",
            Some("REPO {{ ticket_id }}".into()),
        )
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
        set_prompt(
            &db,
            "app",
            "work",
            Some(r#"START {% include "issue" %} END"#.into()),
        )
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
            settings::get(&db, "app", "prompt.work")
                .await
                .unwrap()
                .is_none(),
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
            PromptLayer::Personal,
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
        assert!(
            p.output.contains(&format!("{MARK_OPEN}AK-123{MARK_CLOSE}")),
            "value marked"
        );
        assert!(p.output.contains("Task "), "literal text stays unmarked");
    }

    /// The tutor's wording is part of a contract (the hook, the `Edit` grant) and
    /// the analysis's output shape is what its pane renders, so both are listed
    /// read-only and an override is refused at the door.
    #[tokio::test]
    async fn a_read_only_prompt_refuses_an_override() {
        let db = test_db().await;
        let err = set_prompt(&db, "app", "english-tutor", Some("x".into()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");
        let rows = list(&db, "app").await.unwrap();
        let tutor = rows.iter().find(|p| p.name == "english-tutor").unwrap();
        assert!(!tutor.editable);
        assert_eq!(tutor.preview, PromptPreviewKind::Sample);
        let analysis = rows.iter().find(|p| p.name == "english-analysis").unwrap();
        assert!(!analysis.editable);
        assert_eq!(analysis.preview, PromptPreviewKind::Sample);
        assert!(rows
            .iter()
            .filter(|p| !p.name.starts_with("english-"))
            .all(|p| p.editable));
    }

    #[tokio::test]
    async fn preview_reports_render_error() {
        let db = test_db().await;
        let p = preview(
            &db,
            "work",
            "{% for x in %}",
            None,
            PromptLayer::Personal,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(p.error.is_some(), "broken draft surfaces an error");
        assert!(p.output.is_empty());
    }

    #[test]
    fn scan_includes_finds_names_and_ignores_lookalikes() {
        let src = r#"{% include "issue" %} text {%- include 'house-style' -%} {% if includes %}{% endif %}"#;
        assert_eq!(scan_includes(src), vec!["issue", "house-style"]);
        // De-dupes and skips the `if`/word-boundary lookalikes.
        assert_eq!(
            scan_includes(r#"{% include "a" %}{% include "a" %}"#),
            vec!["a"]
        );
        assert!(scan_includes("no tags here").is_empty());
    }

    #[tokio::test]
    async fn custom_block_is_created_included_and_deleted() {
        let db = test_db().await;
        // Create a block and give it real content.
        create_block(&db, "house-style", "House style")
            .await
            .unwrap();
        set_prompt(
            &db,
            "app",
            "house-style",
            Some("HOUSE {{ ticket_id }}".into()),
        )
        .await
        .unwrap();
        // A flow that includes it resolves the block's content.
        set_prompt(
            &db,
            "app",
            "work",
            Some(r#"W {% include "house-style" %}"#.into()),
        )
        .await
        .unwrap();
        let out = render(
            &db,
            Some("canary"),
            "work",
            context! { ticket_id => "AK-7" },
        )
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
        assert!(!list(&db, "app")
            .await
            .unwrap()
            .iter()
            .any(|p| p.name == "house-style"));
        let out = render(
            &db,
            Some("canary"),
            "work",
            context! { ticket_id => "AK-7" },
        )
        .await
        .unwrap();
        assert_eq!(out, "W ");
    }

    #[tokio::test]
    async fn create_block_rejects_bad_and_colliding_names() {
        let db = test_db().await;
        assert!(
            create_block(&db, "Bad Name", "x").await.is_err(),
            "spaces/caps rejected"
        );
        assert!(
            create_block(&db, "work", "x").await.is_err(),
            "built-in name rejected"
        );
        create_block(&db, "dup", "Dup").await.unwrap();
        assert!(
            create_block(&db, "dup", "Dup").await.is_err(),
            "duplicate rejected"
        );
    }

    // ── Layers: the project file and Jinja inheritance ─────────────────────

    /// The slot contract: every declared slot is an *empty* block in its
    /// default, so filling one never replaces a word of ours — and every
    /// editable flow ends with the `extra` slot.
    #[test]
    fn every_slot_is_an_empty_block_in_its_default() {
        for d in PROMPT_DEFS {
            for slot in d.slots {
                let tag = format!("{{% block {} %}}{{% endblock %}}", slot.name);
                assert!(
                    d.default.contains(&tag),
                    "{}: slot `{}` is not an empty block in its default",
                    d.name,
                    slot.name
                );
            }
            if d.editable && d.kind == PromptKind::Flow {
                assert!(
                    d.slots.iter().any(|s| s.name == EXTRA_SLOT.name),
                    "{}: every editable flow ends with the extra slot",
                    d.name
                );
            }
        }
    }

    /// A DB with one registered repo whose root is a fresh temp dir.
    async fn db_with_repo() -> (Db, PathBuf) {
        let db = test_db().await;
        let root =
            std::env::temp_dir().join(format!("santree-prompts-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES ('acme','Local git',?)")
            .bind(root.to_string_lossy().into_owned())
            .execute(&db)
            .await
            .unwrap();
        (db, root)
    }

    fn write_project(root: &Path, name: &str, content: &str) {
        let dir = santree_dir::prompts_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{name}.njk")), content).unwrap();
    }

    fn ctx() -> Value {
        context! { ticket_id => "AK-1", title => "t", mode => "implement" }
    }

    #[tokio::test]
    async fn project_file_sits_between_the_repo_override_and_the_app_override() {
        let (db, root) = db_with_repo().await;
        set_prompt(&db, "app", "work", Some("APP".into()))
            .await
            .unwrap();
        assert_eq!(
            render(&db, Some("acme"), "work", ctx()).await.unwrap(),
            "APP"
        );

        // The committed file beats the user's app-wide override…
        write_project(&root, "work", "PROJECT");
        assert_eq!(
            render(&db, Some("acme"), "work", ctx()).await.unwrap(),
            "PROJECT"
        );
        // …and stays out of other repos and the app scope.
        assert_eq!(render(&db, None, "work", ctx()).await.unwrap(), "APP");

        // …but the user's override for this repo beats the file.
        set_prompt(&db, "repo:acme", "work", Some("MINE".into()))
            .await
            .unwrap();
        assert_eq!(
            render(&db, Some("acme"), "work", ctx()).await.unwrap(),
            "MINE"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_layer_extends_the_default_by_filling_a_slot_and_keeps_the_rest() {
        let (db, root) = db_with_repo().await;
        write_project(
            &root,
            "work",
            "{% extends \"santree/work\" %}{% block extra %}RUN pnpm test{% endblock %}",
        );
        let out = render(&db, Some("acme"), "work", ctx()).await.unwrap();
        assert!(
            out.trim_end().ends_with("RUN pnpm test"),
            "slot filled at its position: {out:?}"
        );
        assert!(
            out.contains("Create an implementation plan, then implement the changes."),
            "the default's own text survives"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_named_section_can_be_overridden_or_appended_to_with_super() {
        let (db, root) = db_with_repo().await;
        let ctx = || context! { ticket_id => "AK-1", title => "t", ticket_content => "T" };
        write_project(
            &root,
            "triage",
            "{% extends \"santree/triage\" %}{% block rules %}ONLY RULE{% endblock %}\
             {% block gotchas %}{{ super() }}ALSO: ids are base36{% endblock %}",
        );
        let out = render(&db, Some("acme"), "triage", ctx()).await.unwrap();
        assert!(out.contains("ONLY RULE"));
        assert!(
            !out.contains("## Critical rules"),
            "the section was replaced"
        );
        assert!(
            out.contains("## Execution notes & gotchas"),
            "super() kept the section"
        );
        assert!(out.contains("ALSO: ids are base36"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_personal_override_extends_the_project_layer_and_survives_its_absence() {
        let (db, root) = db_with_repo().await;
        write_project(
            &root,
            "work",
            "{% extends \"santree/work\" %}{% block extra %}TEAM{% endblock %}",
        );
        set_prompt(
            &db,
            "repo:acme",
            "work",
            Some(
                "{% extends \"project/work\" %}{% block extra %}{{ super() }} + ME{% endblock %}"
                    .into(),
            ),
        )
        .await
        .unwrap();
        let out = render(&db, Some("acme"), "work", ctx()).await.unwrap();
        assert!(out.trim_end().ends_with("TEAM + ME"), "{out:?}");

        // The file goes away (a teammate deleted it): `project/work` now names
        // the layer below, so the override still renders instead of failing.
        std::fs::remove_file(santree_dir::prompts_dir(&root).join("work.njk")).unwrap();
        let out = render(&db, Some("acme"), "work", ctx()).await.unwrap();
        assert!(out.trim_end().ends_with(" + ME"), "{out:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_self_extending_layer_is_refused_at_write() {
        let (db, root) = db_with_repo().await;
        let err = set_project_prompt(
            &db,
            "acme",
            "work",
            Some("{% extends \"project/work\" %}".into()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("can't extend itself"), "{err}");
        let err = set_prompt(&db, "app", "work", Some("{%- extends 'work' -%}".into()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("can't extend itself"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn set_project_prompt_writes_the_file_and_the_ignore_then_deletes_it() {
        let (db, root) = db_with_repo().await;
        set_project_prompt(&db, "acme", "work", Some("P".into()))
            .await
            .unwrap();
        let file = santree_dir::prompts_dir(&root).join("work.njk");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "P");
        assert!(root.join(".santree").join(".gitignore").exists());
        assert_eq!(render(&db, Some("acme"), "work", ctx()).await.unwrap(), "P");

        // A block the repo defines on its own is listed and includable.
        set_project_prompt(&db, "acme", "house-style", Some("HS".into()))
            .await
            .unwrap();
        set_project_prompt(
            &db,
            "acme",
            "work",
            Some("{% include \"house-style\" %}!".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            render(&db, Some("acme"), "work", ctx()).await.unwrap(),
            "HS!"
        );
        let listed = list(&db, "repo:acme").await.unwrap();
        let hs = listed.iter().find(|p| p.name == "house-style").unwrap();
        assert!(!hs.builtin);
        assert_eq!(hs.project_source.as_deref(), Some("HS"));
        assert!(hs
            .project_path
            .as_deref()
            .unwrap()
            .ends_with("house-style.njk"));
        let work = listed.iter().find(|p| p.name == "work").unwrap();
        assert_eq!(work.slots.len(), 1);
        assert_eq!(work.slots[0].name, "extra");

        set_project_prompt(&db, "acme", "work", None).await.unwrap();
        assert!(!file.exists());
        // Deleting what isn't there is fine.
        set_project_prompt(&db, "acme", "work", None).await.unwrap();

        for bad in ["../x", "Work", "a/b", "", "english-tutor"] {
            assert!(
                set_project_prompt(&db, "acme", bad, Some("x".into()))
                    .await
                    .is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(
            set_project_prompt(&db, "acme", "work", Some("{% if %}".into()))
                .await
                .is_err(),
            "a broken template never reaches the file"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_project_draft_previews_under_the_personal_override() {
        let (db, root) = db_with_repo().await;
        set_prompt(
            &db,
            "repo:acme",
            "work",
            Some(
                "{% extends \"project/work\" %}{% block extra %}{{ super() }}|ME{% endblock %}"
                    .into(),
            ),
        )
        .await
        .unwrap();
        let draft = "{% extends \"santree/work\" %}{% block extra %}DRAFT{% endblock %}";
        let out = preview(
            &db,
            "work",
            draft,
            Some("acme"),
            PromptLayer::Project,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
        assert!(
            out.output.trim_end().ends_with("DRAFT|ME"),
            "the draft stands in for the file, under the override: {:?}",
            out.output
        );
        // A personal draft replaces the override instead.
        let out = preview(
            &db,
            "work",
            "JUST ME",
            Some("acme"),
            PromptLayer::Personal,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.output, "JUST ME");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_project_file_may_not_extend_the_effective_name() {
        let (db, root) = db_with_repo().await;
        // `work` is the top of the chain, so a file extending it would loop
        // through any override that extends `project/work`.
        let err = set_project_prompt(&db, "acme", "work", Some("{% extends \"work\" %}".into()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("can't extend itself"), "{err}");
        set_project_prompt(
            &db,
            "acme",
            "work",
            Some("{% extends \"santree/work\" %}".into()),
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_read_only_prompt_has_no_project_layer() {
        let (db, root) = db_with_repo().await;
        write_project(&root, "english-tutor", "NOT THE HOOK'S WORDING");
        let sources = resolve_sources(&db, Some("acme")).await.unwrap();
        let (_, effective) = sources.iter().find(|(n, _)| n == "english-tutor").unwrap();
        assert_eq!(effective, def("english-tutor").unwrap().default);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_project_files_are_neither_read_nor_written() {
        use std::os::unix::fs::symlink;
        let (db, root) = db_with_repo().await;
        // A file outside the repo, reachable only through a committed link.
        let outside = std::env::temp_dir().join(format!("santree-secret-{}", uuid::Uuid::new_v4()));
        std::fs::write(&outside, "SECRET").unwrap();
        let dir = santree_dir::prompts_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        symlink(&outside, dir.join("work.njk")).unwrap();

        // Not a layer…
        let out = render(&db, Some("acme"), "work", ctx()).await.unwrap();
        assert!(!out.contains("SECRET"), "{out:?}");
        // …and not a write target.
        let err = set_project_prompt(&db, "acme", "work", Some("P".into()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "SECRET");

        // A linked prompts directory is refused whole.
        std::fs::remove_file(dir.join("work.njk")).unwrap();
        std::fs::remove_dir(&dir).unwrap();
        let elsewhere =
            std::env::temp_dir().join(format!("santree-elsewhere-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("work.njk"), "ELSEWHERE").unwrap();
        symlink(&elsewhere, &dir).unwrap();
        let out = render(&db, Some("acme"), "work", ctx()).await.unwrap();
        assert!(!out.contains("ELSEWHERE"), "{out:?}");
        assert!(set_project_prompt(&db, "acme", "work", Some("P".into()))
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn scan_extends_finds_the_target_and_ignores_lookalikes() {
        assert_eq!(
            scan_extends("{%- extends 'santree/work' -%} x").as_deref(),
            Some("santree/work")
        );
        assert_eq!(scan_extends("{% extendsx \"a\" %}"), None);
        assert_eq!(scan_extends("{% include \"a\" %}"), None);
        assert_eq!(scan_extends("prose"), None);
    }
}
