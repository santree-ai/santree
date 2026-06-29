//! AI prompt templates, rendered with minijinja.
//!
//! Mirrors the santree CLI's approach: each prompt is a readable `.njk` file
//! under `prompts/` (with `{% if %}` conditionals and examples) rather than an
//! inline Rust string. Templates are embedded at compile time, so there's no
//! runtime file lookup and the binary stays self-contained.

use std::sync::LazyLock;

use anyhow::{Context, Result};
use minijinja::Environment;
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
        assert!(out.contains("\nadd login throttling"), "example has no prefix");
        assert!(!out.contains("] add login throttling"), "no ticket prefix");
    }

    #[test]
    fn work_plan_mode_withholds_implementation() {
        let out = render(
            "work",
            context! { ticket_id => "AK-2", title => "Do thing", mode => "plan" },
        )
        .unwrap();
        assert!(out.contains("Do NOT implement yet"), "plan mode is read-only");
    }
}
