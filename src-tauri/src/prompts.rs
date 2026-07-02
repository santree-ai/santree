//! AI prompt templates, rendered with minijinja.
//!
//! Mirrors the santree CLI's approach: each prompt is a readable `.njk` file
//! under `prompts/` (with `{% if %}` conditionals and examples) rather than an
//! inline Rust string. Templates are embedded at compile time, so there's no
//! runtime file lookup and the binary stays self-contained.

use std::sync::LazyLock;

use anyhow::{Context, Result};
use minijinja::{context, Environment};
use santree_core::domain::{Priority, TriageDetail};
use serde::Serialize;

/// The shared template environment, built once. Add new prompts here and to the
/// `prompts/` directory together.
static ENV: LazyLock<Environment<'static>> = LazyLock::new(|| {
    let mut env = Environment::new();
    env.add_template("fill-commit", include_str!("../prompts/fill-commit.njk"))
        .expect("fill-commit template");
    env.add_template("fill-pr", include_str!("../prompts/fill-pr.njk"))
        .expect("fill-pr template");
    env.add_template("work", include_str!("../prompts/work.njk"))
        .expect("work template");
    env.add_template("ticket", include_str!("../prompts/ticket.njk"))
        .expect("ticket template");
    env
});

/// Render the named prompt with `ctx` (any `Serialize` value — typically a
/// `minijinja::context!{}` map). Missing keys render empty, matching nunjucks.
pub fn render<S: Serialize>(name: &str, ctx: S) -> Result<String> {
    let tmpl = ENV
        .get_template(name)
        .with_context(|| format!("unknown prompt template: {name}"))?;
    tmpl.render(ctx)
        .with_context(|| format!("rendering prompt template: {name}"))
}

/// Render a fetched Linear issue into the markdown the work prompt embeds as
/// `ticket_content` — mirrors the CLI's `renderTicket`, so the agent starts
/// with the description and comment thread instead of being told to re-fetch.
pub fn render_ticket(detail: &TriageDetail) -> Result<String> {
    let priority_label = match detail.priority {
        Priority::Urgent => Some("Urgent"),
        Priority::High => Some("High"),
        Priority::Medium => Some("Medium"),
        Priority::Low => Some("Low"),
        Priority::None => None,
    };
    render(
        "ticket",
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
        },
    )
}

#[cfg(test)]
mod tests {
    use minijinja::context;

    use super::*;

    #[test]
    fn fill_commit_includes_ticket_prefix_when_present() {
        let out = render(
            "fill-commit",
            context! { branch_name => "santree/ak-1-x", ticket_id => "AK-1", diff_content => "diff" },
        )
        .unwrap();
        assert!(out.contains("[AK-1]"), "should show the ticket prefix");
        assert!(out.contains("diff"), "should embed the diff");
    }

    #[test]
    fn fill_commit_omits_prefix_without_ticket() {
        let out = render(
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
        let out = render(
            "fill-commit",
            context! {
                branch_name => "main",
                ticket_id => Option::<&str>::None,
                diff_content => "diff",
            },
        )
        .unwrap();
        // Same assertions as the no-ticket case above: the rendered examples and
        // the `Ticket:` context line are both skipped by `{% if ticket_id %}`.
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
        let out = render(
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
    fn work_embeds_ticket_content_over_mcp_fallback() {
        let ticket = render(
            "ticket",
            context! {
                tracker_name => "Linear",
                identifier => "AK-3",
                title => "Fix the thing",
                url => "https://linear.app/x/AK-3",
                state => "In Progress",
                priority_label => "High",
                labels => vec!["bug", "backend"],
                description => "Steps to reproduce…",
                comments => Vec::<minijinja::Value>::new(),
            },
        )
        .unwrap();
        assert!(ticket.contains("Linear Issue: AK-3"));
        assert!(ticket.contains("Priority: High"));
        assert!(ticket.contains("Labels: bug, backend"));
        assert!(ticket.contains("Steps to reproduce"));

        let out = render(
            "work",
            context! { ticket_id => "AK-3", ticket_content => ticket, mode => "implement" },
        )
        .unwrap();
        assert!(
            out.contains("Steps to reproduce"),
            "ticket body is embedded"
        );
        assert!(
            !out.contains("could not be fetched"),
            "fallback hint is skipped when ticket_content is present"
        );
    }
}
