//! Tauri application wiring: logging, the typed command bridge, and the builder.
//!
//! Keep this file about *registration* only. Command bodies live in
//! [`commands`], and the real logic lives in the `santree-core` crate.

mod accounts;
mod agent;
mod agent_procs;
mod awake;
mod browser;
mod bundled_bin;
mod claude_usage;
mod codex_cli;
mod codex_config;
mod codex_rollouts;
mod commands;
mod commit_draft;
// COMPLIANCE.md's rules, as tests. Nothing ships from it — it only reads the
// tree and asserts over what it finds.
#[cfg(test)]
mod compliance;
mod connection;
mod conversation;
mod daedalus;
mod db;
mod diagnostics;
mod english_tutor;
mod env;
mod error;
mod git;
mod git_watch;
mod github;
mod global_capture;
mod gql;
mod hook_bin;
mod hooks;
mod jira;
mod legacy;
mod linear;
mod linear_mcp;
mod notes;
mod oauth;
mod openers;
mod pr;
mod pricing;
mod proc_table;
mod prompts;
mod provider;
mod record_file;
mod repo;
mod resources;
mod review_ai;
mod review_drafts;
mod review_work_items;
mod reviewed;
mod reviews;
mod santree_dir;
mod server;
mod session;
mod session_signal;
pub mod sessions;
mod settings;
mod split_stack;
mod stream;
mod tabs;
mod terminal;
mod text_store;
mod ticktick;
mod tracker;
mod update;
mod usage;
mod worktree;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_specta::{collect_commands, collect_events, Builder};

/// The app's concrete `tauri-specta` builder type (Tauri's default `Wry` runtime).
type AppBuilder = Builder<tauri::Wry>;

/// Where the generated TypeScript client is written, relative to `src-tauri`
/// (the cwd for both `tauri dev` and `cargo test`). Only used by the
/// debug-only `export_bindings`, so it's gated to avoid a dead-code warning in
/// release builds.
#[cfg(debug_assertions)]
const BINDINGS_PATH: &str = "../src/bindings.ts";

/// Build the `tauri-specta` command bridge.
///
/// Centralised so the binary (`run`), the debug export, and the `gen:bindings`
/// test all use the exact same command set — there's no way for them to drift.
fn specta_builder() -> AppBuilder {
    Builder::<tauri::Wry>::new()
        .events(collect_events![
            browser::BrowserChanged,
            browser::BrowserClosed,
            browser::BrowserDownload,
            browser::BrowserFocus,
            browser::BrowserOpened,
            browser::BrowserPointerDown,
            browser::BrowserShortcut,
            conversation::ConversationChanged,
            daedalus::host::DaedalusLinkChanged,
            git_watch::WorktreeChanged,
            pr::WorktreeBasesChanged,
            server::commands::ServerStateChanged,
            session_signal::ClaudeRateLimitsChanged,
            session_signal::ReviewAiChanged,
            session_signal::SessionStateChanged,
            session_signal::SessionUsageChanged,
            session_signal::SessionLiveTextChanged,
            usage::UsageChanged,
            usage::UsageProgress,
            update::UpdateProgress
        ])
        .commands(collect_commands![
            commands::list_repos,
            commands::add_repo,
            commands::remove_repo,
            commands::list_agents,
            commands::codex_health,
            commands::codex_account,
            commands::codex_models,
            commands::codex_rate_limits,
            commands::agent_accounts,
            commands::agent_account_create,
            commands::agent_account_remove,
            commands::agent_account_login_command,
            commands::terminal_session_set_account,
            commands::codex_logout,
            commands::claude_usage,
            commands::agent_auth,
            commands::agent_version_status,
            commands::github_status,
            commands::github_api_budget,
            commands::worktrees,
            commands::base_worktree,
            commands::create_worktree,
            commands::move_changes_preview,
            commands::move_remaining_changes,
            commands::repo_branches,
            commands::remove_worktree,
            commands::run_worktree_setup_streamed,
            commands::cancel_worktree_setup,
            commands::resize_worktree_setup,
            commands::pull_worktree,
            commands::push_worktree,
            commands::pull_remote_worktree,
            commands::update_base_branch,
            commands::worktree_status,
            commands::worktree_file_diff,
            commands::worktree_file_source,
            commands::worktree_files,
            commands::worktree_branch_changes,
            commands::worktree_branch_file_diff,
            commands::worktree_sessions,
            commands::worktree_session_detail,
            commands::worktree_session_subagents,
            commands::conversation_read,
            commands::reveal_worktree_session_transcript,
            commands::resume_worktree_session,
            commands::check_tab_resume,
            commands::watch_worktrees,
            commands::stage_path,
            commands::unstage_path,
            commands::discard_path,
            commands::stage_all_paths,
            commands::unstage_all_paths,
            commands::commit_worktree,
            commands::commit_message,
            commands::commit_draft,
            commands::set_commit_draft,
            commands::set_worktree_title,
            commands::work_prompt,
            commands::investigate_prompt,
            commands::agent_session,
            commands::started_investigations,
            commands::session_providers,
            commands::list_worktree_tabs,
            commands::add_worktree_tab,
            commands::rename_worktree_tab,
            commands::remove_worktree_tab,
            browser::browser_supported,
            browser::browser_resolve,
            browser::browser_show,
            browser::browser_place,
            browser::browser_hide,
            browser::browser_load,
            browser::browser_nav,
            browser::browser_focus,
            browser::browser_release_focus,
            browser::browser_set_holes,
            browser::browser_snapshot,
            browser::browser_state,
            browser::browser_cookie_sources,
            browser::browser_cookie_sites,
            browser::browser_import_cookies,
            commands::worktree_tab_launch,
            commands::pr_draft,
            commands::worktree_has_transcripts,
            commands::create_pull_request,
            commands::pr_reviewers,
            commands::worktree_prs,
            commands::reviews,
            commands::pr_tickets,
            commands::review_workspace,
            commands::review_checkout,
            commands::remove_review_workspace,
            commands::promote_review_worktree,
            commands::close_review_session,
            commands::close_investigation_session,
            commands::pr_review_brief,
            commands::ai_review_launch,
            commands::review_fix_launch,
            commands::review_drafts,
            commands::review_work_items,
            commands::add_review_work_item,
            commands::update_review_work_item,
            commands::delete_review_work_item,
            commands::update_review_draft,
            commands::delete_review_draft,
            commands::clear_review_drafts,
            commands::publish_review_drafts,
            commands::merge_queue,
            commands::pr_detail,
            commands::pr_summary,
            commands::pr_repo_labels,
            commands::set_pr_labels,
            commands::add_pr_inline_comment,
            commands::github_viewer_login,
            commands::reply_to_pr_thread,
            commands::set_pr_thread_resolved,
            commands::submit_pr_review,
            commands::discard_pr_review,
            commands::add_pr_comment,
            commands::pr_check_log,
            commands::pr_file_source,
            commands::reviewed_files,
            commands::set_file_reviewed,
            commands::worktree_init_script,
            commands::set_worktree_init_script,
            commands::make_init_script_executable,
            commands::list_openers,
            commands::open_in_app,
            commands::list_triage_tickets,
            commands::triage_detail,
            commands::triage_set_state,
            commands::triage_snooze,
            commands::triage_add_comment,
            commands::binary_status,
            commands::set_binary_path,
            commands::claude_hook_settings,
            commands::codex_hook_flags,
            commands::claude_hook_settings_no_git,
            commands::english_log,
            commands::english_analysis,
            commands::run_english_analysis,
            commands::session_states,
            commands::session_usage_live,
            commands::session_live_text,
            commands::claude_rate_limits,
            commands::claude_fetch_usage,
            commands::claude_global_capture_status,
            commands::set_claude_global_capture,
            commands::resource_usage,
            commands::agent_processes,
            commands::triage_schedule,
            commands::linear_teams,
            commands::get_settings,
            commands::set_settings,
            commands::quit_app,
            commands::task_note,
            commands::set_task_note,
            commands::claude_models,
            commands::get_setting,
            commands::set_setting,
            commands::set_experimental,
            commands::resolve_setting,
            commands::list_prompts,
            commands::set_prompt,
            commands::preview_prompt,
            commands::set_project_prompt,
            commands::create_prompt_block,
            commands::delete_prompt_block,
            commands::env_file_vars,
            commands::export_logs,
            commands::linear_auth_status,
            commands::linear_orgs,
            commands::linear_api_budget,
            commands::set_repo_connection,
            commands::linear_list_issues,
            commands::linear_invalidate_caches,
            commands::linear_connect,
            commands::linear_mcp_connect,
            commands::jira_auth_status,
            commands::jira_sites,
            commands::jira_connect,
            commands::ticktick_status,
            commands::ticktick_connect,
            commands::ticktick_connect_token,
            commands::ticktick_disconnect,
            commands::ticktick_lists,
            commands::daedalus_status,
            commands::daedalus_health,
            commands::daedalus_settings,
            commands::daedalus_set_setting,
            commands::daedalus_workspaces,
            commands::daedalus_icon,
            commands::add_daedalus_repo,
            commands::daedalus_agent_hooks,
            commands::daedalus_agent_clis,
            commands::legacy_cli_probe,
            commands::legacy_cli_migrate,
            commands::check_for_update,
            commands::install_update,
            commands::reveal_logs,
            commands::keep_awake_status,
            commands::set_keep_awake,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_seed,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_attach,
            terminal::terminal_detach,
            terminal::terminal_adopt,
            terminal::terminal_inventory,
            terminal::quit_summary,
            server::commands::server_status,
            server::commands::server_start,
            server::commands::server_restart,
            server::commands::server_stop,
            server::commands::server_end_draining,
        ])
}

/// Write `src/bindings.ts` from the current command set.
///
/// Called from `run()` in debug builds and from the `export_bindings` test
/// (which is what `pnpm gen:bindings` drives).
#[cfg(debug_assertions)]
fn export_bindings(builder: &AppBuilder) -> anyhow::Result<()> {
    builder.export(
        specta_typescript::Typescript::default()
            .header("// @generated by tauri-specta. Do not edit by hand.\n"),
        BINDINGS_PATH,
    )?;
    Ok(())
}

/// File + stdout logger. Rust (`log` facade) and forwarded JS-`console` logs land
/// in ONE attachable file at the OS log dir — on macOS
/// `~/Library/Logs/com.santree.desktop/santree.log` — each line carrying a local
/// timestamp, level, and source target (`[santree::linear]` for Rust,
/// `[webview]` for JS) so it's clear when, where, and what. Bounded to ~20 MB
/// (one 10 MB file + one rotated backup) so it can't grow without limit, and
/// stays small enough to attach to a bug report. `sqlx` is pinned to warn so
/// query chatter doesn't drown the file.
fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};
    Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some("santree".into()),
            }),
        ])
        .level(log::LevelFilter::Info)
        .level_for("sqlx", log::LevelFilter::Warn)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(10_000_000)
        .rotation_strategy(RotationStrategy::KeepOne)
        .build()
}

/// One-time migration after the bundle id rename (`com.santree.app` →
/// `com.santree.desktop`): the app data dir is keyed by the identifier, so move
/// the existing SQLite DB (and its WAL sidecars) from the old dir into the new one
/// so local state — repos, settings, Linear tokens, worktree links, terminal
/// sessions — survives the rename. No-op once the new DB exists, or if there's no
/// legacy DB to carry over. Logs are intentionally left behind (disposable).
fn migrate_legacy_data_dir(new_dir: &std::path::Path) {
    const LEGACY_ID: &str = "com.santree.app";
    if new_dir.join("santree.db").exists() {
        return; // already migrated (or a fresh install on the new id)
    }
    let Some(legacy_dir) = new_dir.parent().map(|p| p.join(LEGACY_ID)) else {
        return;
    };
    if !legacy_dir.join("santree.db").exists() {
        return; // nothing to migrate
    }
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        log::warn!("data migration: couldn't create {}: {e}", new_dir.display());
        return;
    }
    // Move the DB and its WAL/SHM sidecars together (the app isn't using them yet).
    for name in ["santree.db", "santree.db-wal", "santree.db-shm"] {
        let from = legacy_dir.join(name);
        if from.exists() {
            if let Err(e) = std::fs::rename(&from, new_dir.join(name)) {
                log::warn!("data migration: couldn't move {name}: {e}");
            }
        }
    }
    log::info!(
        "migrated app data from {} to {}",
        legacy_dir.display(),
        new_dir.display()
    );
}

/// Merge a login-shell PATH into the current one: login entries first (the source
/// of truth for where the user's tools live), then any current-only entries we
/// shouldn't drop. Order-preserving and de-duplicated. Pure, for testability.
fn merge_paths(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login
        .split(':')
        .chain(current.split(':'))
        .filter(|p| !p.is_empty() && seen.insert(*p))
        .collect::<Vec<_>>()
        .join(":")
}

/// Recover the user's real PATH at startup. A Finder-launched macOS bundle gets a
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew, `direnv`,
/// version managers, etc. Every subprocess we spawn inherits this PATH — `git`
/// (and the repo's commit hooks, which routinely shell out to `direnv` and friends),
/// `.santree` setup scripts, the agent CLIs, openers — so without this they fail to
/// find tools that work fine in a terminal (e.g. the `direnv: command not found` a
/// pre-commit hook hits, which then breaks the hook's lint step). We merge the login
/// shell's PATH into the process PATH exactly once, before anything spawns, so all
/// children inherit it. No-op when launched from a terminal (login PATH already
/// covers the current one). Unix only.
///
/// The probe spawns a real login shell, which the doc used to describe as
/// "~tens of ms" — true for a bare shell, but users with nvm/rbenv/direnv-laden rc
/// files routinely see 500ms-2s, all blocking first-window paint. So this is
/// cached across launches in [`path_cache_file`]: a hit applies the last-known PATH
/// immediately (no shell spawn) and kicks off a background re-probe to keep the
/// cache fresh for *next* launch; only a genuine first run (or a cleared cache)
/// pays the full synchronous cost. Deliberately not the app's SQLite settings store
/// — reading that needs a `Db`, which needs an `AppHandle` and sqlx's tokio runtime,
/// neither of which exist yet this early, and starting the runtime here would spawn
/// worker threads before we're done mutating `PATH` (see the safety note below).
fn hydrate_path() {
    let probe_and_seed = |cache: Option<&std::path::Path>| {
        if let Some(login) = settings::login_shell_path() {
            apply_login_path(&login);
            if let Some(cache) = cache {
                let _ = write_private(cache, &login);
            }
        }
    };

    let Some(cache) = path_cache_file() else {
        return probe_and_seed(None); // no private dir → always pay the probe
    };
    if let Some(cached) = std::fs::read_to_string(&cache)
        .ok()
        .as_deref()
        .and_then(sanitize_path_list)
    {
        apply_login_path(&cached);
        // Refresh for next launch — the user's shell rc / installed tools can
        // change between runs. Doesn't touch `PATH` itself, so it's safe to run
        // concurrently with whatever threads Tauri spawns next. Its own `log::info!`
        // reliably lands: this thread almost always outlives the log plugin's setup.
        std::thread::spawn(move || refresh_path_cache(&cache));
        return;
    }
    // No cache yet: probe synchronously so PATH is correct for this run's own
    // children, and seed the cache so the next launch skips the shell spawn.
    probe_and_seed(Some(&cache));
}

/// Merge a resolved login-shell PATH into the process's current PATH and apply it.
fn apply_login_path(login: &str) {
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(login, &current);
    if !merged.is_empty() && merged != current {
        // Safe: `hydrate_path` calls this synchronously before spawning the
        // background refresh thread or starting the Tauri/async runtime, so
        // nothing else can be concurrently reading/writing the environment yet.
        std::env::set_var("PATH", &merged);
    }
}

/// santree's private directory for files that must never live in a shared,
/// world-writable `/tmp`: `$XDG_CACHE_HOME/santree`, else `~/.cache/santree`. Created
/// `0700`, and re-asserted on every call, so no other local user can read what we put
/// there — or, worse, pre-plant a file we later read back (the cached PATH is
/// *prepended* to `PATH`, so a planted one is arbitrary code execution as us). Not the
/// Tauri app-data dir: this has to work before an `AppHandle` exists. `None` when
/// there's no home to anchor it to or the dir can't be created.
fn private_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".cache")))?;
    let dir = base.join("santree");
    std::fs::create_dir_all(&dir).ok()?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

/// Write `contents` to `path` with owner-only (0600) permissions, replacing whatever
/// was there.
fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())
}

/// Where the last resolved login-shell PATH is cached between launches. In santree's
/// own [`private_dir`] rather than app data: it needs no app identifier (so it can't
/// drift out of sync with `migrate_legacy_data_dir`'s bundle-id handling) and no async
/// runtime to read. Losing it just costs one slow launch to reseed.
fn path_cache_file() -> Option<std::path::PathBuf> {
    Some(private_dir()?.join("login-path"))
}

/// Keep only the absolute entries of a cached PATH string; `None` when nothing usable
/// survives. This is what we prepend to `PATH` before any subprocess spawns, so a
/// relative entry would resolve `git`/`claude`/hooks against whatever cwd a child
/// happens to run in — defence in depth behind the 0700 cache dir. Pure, for testability.
fn sanitize_path_list(raw: &str) -> Option<String> {
    let kept: Vec<&str> = raw
        .trim()
        .split(':')
        .filter(|p| std::path::Path::new(p).is_absolute())
        .collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// Re-probe the login shell's PATH and rewrite the cache for the next launch.
/// Runs on a background thread so it never delays startup.
fn refresh_path_cache(cache: &std::path::Path) {
    let started = std::time::Instant::now();
    if let Some(login) = settings::login_shell_path() {
        let _ = write_private(cache, &login);
        log::info!(
            "refreshed cached login PATH in {}ms (applies on next launch)",
            started.elapsed().as_millis()
        );
    }
}

/// Show a blocking native error dialog and exit — for setup failures (corrupt DB,
/// unreadable data dir) that would otherwise panic with only a stderr message and
/// no explanation for a packaged app's user. Never returns.
fn fatal_startup_error(app: &tauri::App, message: &str) -> ! {
    log::error!("fatal startup error: {message}");
    app.dialog()
        .message(message)
        .title("santree can't start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1)
}

/// Route panics into the log file, where they're otherwise invisible: the crate
/// builds with `panic = "abort"`, so a panic on any thread kills the app with no
/// in-app error and nothing but a stderr line no packaged user ever sees. Chains onto
/// (rather than replaces) the default hook, so that stderr line is unchanged.
///
/// Before the log plugin is attached (in `.setup()`), `log::error!` is a silent no-op,
/// so this is installed as early as possible while still covering the long-lived app:
/// the only window it can't record is startup itself, which still gets the default
/// hook's stderr output.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown location>".into());
        let thread = std::thread::current();
        log::error!(
            "panic on thread '{}' at {location}: {msg}\n{}",
            thread.name().unwrap_or("<unnamed>"),
            std::backtrace::Backtrace::force_capture()
        );
        default_hook(info);
    }));
}

pub fn run() {
    // Installed first so it also covers `hydrate_path`'s shell-out below.
    install_panic_hook();

    // Before anything reads the environment or starts a thread: santree may
    // have been launched from one of its own account tabs.
    accounts::forget_inherited_account();

    // Must run before any subprocess is spawned (git, hooks, setup scripts, agents).
    hydrate_path();

    let builder = specta_builder();

    // In debug builds, (re)generate `src/bindings.ts` on every run so the typed
    // client tracks the Rust commands during development. Release builds skip
    // this — the committed bindings are used as-is.
    #[cfg(debug_assertions)]
    export_bindings(&builder).expect("failed to export typescript bindings");

    let tauri_builder = tauri::Builder::default()
        // Two independent instances (`open -n`, or running the binary directly)
        // would run separate PTY managers and fs watchers
        // against the same santree.db, with `set_settings` last-writer-wins
        // clobbering whichever instance saved second. Must be registered first —
        // the plugin only "runs before other plugins can interfere" in that slot.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // decorum's only job here is the traffic-light inset applied in `.setup()`, which
    // is macOS-only — and on Linux the crate drags in an unsound memmap2 (see the
    // cfg'd dependency in Cargo.toml). So it isn't even linked on other platforms.
    #[cfg(target_os = "macos")]
    let tauri_builder = tauri_builder.plugin(tauri_plugin_decorum::init());

    tauri_builder
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                browser::hide_all(webview.app_handle());
            }
            // The smoke run's success condition: the window's document loaded, so
            // the frontend bundle shipped and the webview came up.
            let loaded = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
            if server::smoke_enabled() && loaded {
                log::info!("smoke: the window finished loading; exiting 0");
                webview.app_handle().exit(0);
            }
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            // Our custom Quit item (replacing the predefined one, which calls the
            // native terminate and can't be intercepted). Route ⌘Q through the same
            // confirmation as the window close button.
            if event.id() == QUIT_MENU_ID {
                if confirm_on_quit(app) {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.emit("quit-requested", ());
                    }
                } else {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            // Wire specta-registered events (WorktreeChanged, SessionStateChanged)
            // into the app.
            builder.mount_events(app);

            // Open the app database and make the pool available to commands. The
            // bundle id was renamed (com.santree.app → com.santree.desktop); the
            // data dir is keyed by it, so carry the existing DB over first.
            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => fatal_startup_error(app, &format!("Couldn't resolve the app data directory: {e:#}")),
            };
            migrate_legacy_data_dir(&data_dir);
            let db = match tauri::async_runtime::block_on(db::init(data_dir.join("santree.db"))) {
                Ok(db) => db,
                Err(e) => fatal_startup_error(
                    app,
                    &format!(
                        "Couldn't open the database: {e:#}\n\nIf santree.db is corrupted, quit and move or delete it from:\n{}",
                        data_dir.display()
                    ),
                ),
            };
            // Agents' hooks name `santree-hook` by an absolute path, and the updater
            // renames the bundle that ships it away: put a copy at a path that
            // survives an update, before any command that writes one. After the
            // migrations on purpose — the copy must never run ahead of a schema
            // the previous hook binary still expects (hook_bin.rs).
            hook_bin::prepare(app.handle());
            if let Err(e) = tauri::async_runtime::block_on(settings::migrate_helper_agents(&db)) {
                log::warn!("helper-agent migration failed: {e:#}");
            }
            // Mirror any user-set binary paths into the process before anything
            // resolves a CLI. Synchronous on purpose: `discover_binary` is sync and
            // reachable from the first frame, so an override loaded a tick late
            // would silently lose to discovery on the very lookups it exists to fix.
            if let Err(e) = tauri::async_runtime::block_on(settings::refresh_binary_overrides(&db)) {
                log::warn!("loading binary path overrides failed: {e:#}");
            }

            // Garbage-collect the tables nothing else ever deletes from:
            //  · `terminal_sessions` — no code path drops a Triage investigation's row,
            //    so it would grow by one per ticket ever investigated;
            //  · `reviewed_files` — no code path drops a merged/closed PR's marks, so it
            //    would grow with the whole org's PR history;
            //  · `review_worktrees` — a checkout whose PR has merged is hidden from
            //    Trees and unreachable in Reviews, so nothing could delete it.
            //    Released, not deleted: the worktree comes back as an ordinary row.
            // (`session_state` / `session_usage_live` are pruned on their own poll, in
            // hooks.rs.) Best-effort and off the startup path — a failed sweep must never
            // block the app from opening.
            {
                let db = db.clone();
                tauri::async_runtime::spawn(async move {
                    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
                    match session::reap_stale(&db, home.as_deref()).await {
                        Ok(0) => {}
                        Ok(n) => log::info!("reaped {n} unresumable terminal session(s)"),
                        Err(e) => log::warn!("terminal-session reap failed: {e:#}"),
                    }
                    match reviewed::prune_stale(&db).await {
                        Ok(0) => {}
                        Ok(n) => log::info!("pruned {n} reviewed-file mark(s) from stale PRs"),
                        Err(e) => log::warn!("reviewed-file prune failed: {e:#}"),
                    }
                    if let Err(e) = review_ai::gc(&db).await {
                        log::warn!("review-brief sweep failed: {e:#}");
                    }
                    match review_drafts::gc(&db).await {
                        Ok(0) => {}
                        Ok(n) => log::info!("dropped {n} AI review draft(s) from stale PRs"),
                        Err(e) => log::warn!("review-draft sweep failed: {e:#}"),
                    }
                    // The detached checkouts earlier versions parked under
                    // `.santree/reviews/`. Their rows went with migration 0031;
                    // this unregisters the git worktrees and reclaims the disk.
                    reviews::sweep_legacy_checkouts(&db).await;
                    // A reviewed PR that has since merged leaves a checkout no
                    // surface can reach: Trees hides it, and Reviews resolves
                    // PRs out of an inbox filtered to open ones. This hands it
                    // back to Trees; it deletes nothing.
                    match reviews::release_closed_checkouts(&db).await {
                        Ok(0) => {}
                        Ok(n) => log::info!("released {n} review checkout(s) whose PR is closed"),
                        Err(e) => log::warn!("review-checkout release failed: {e:#}"),
                    }
                });
            }

            // Owns the `caffeinate` child while the keep-awake hold is on (see
            // `awake` — macOS only). The hold is remembered across launches, so
            // re-apply it here. Synchronous, and before `db` is moved into managed
            // state: settled a tick late, the chrome's toggle would paint "off"
            // and then flip under the user on the first refetch.
            // With a local server, the hold is the server's (it must outlive the
            // app, which `caffeinate -w <app pid>` cannot); the app only
            // remembers the setting and tells the server.
            let keep_awake = if sessions::server_mode() == sessions::Mode::Off {
                awake::KeepAwake::default()
            } else {
                awake::KeepAwake::delegated_to_server()
            };
            tauri::async_runtime::block_on(awake::restore(&db, &keep_awake));
            app.manage(keep_awake);

            // The link to Daedalus through the Daedalus agent on this machine,
            // and the relay that applies the hooks agents fire there. Only
            // while Settings → Experimental → Daedalus is on: then it starts
            // here, resuming the hook queue where the last run acked it, and
            // without an agent it just reads AgentMissing. Off, nothing
            // connects and the state reads Off. Settled before the first frame
            // can ask, so neither is ever read as the other.
            let daedalus_link = daedalus::host::DaedalusHost::default();
            daedalus_link.start(
                app.handle(),
                db.clone(),
                data_dir.join("santree.db").to_string_lossy().into_owned(),
            );
            tauri::async_runtime::block_on(async {
                let daedalus = santree_core::domain::ExperimentalFeature::Daedalus;
                let on = settings::experimental(&db, daedalus).await;
                daedalus_link.apply(&db, on).await;
            });
            app.manage(daedalus_link);
            // Daedalus projects' app icons, kept beside the database.
            app.manage(daedalus::icons::Icons::new(data_dir.join("daedalus-icons")));
            // The agent's own socket, for this Mac's settings (Settings › Daedalus).
            app.manage(santree_remote_client::AgentControl::new());

            app.manage(db);

            // Holds the `Update` handle a check produced, for the install that
            // follows it (see `update`).
            app.manage(update::PendingUpdate::default());

            // Where terminals live. `server_mode()` is decided once: on a signed
            // build (or `SANTREE_SERVER=1`) local panes run on a detached
            // santree-server and outlive the app; otherwise they are PTYs in this
            // process, exactly as before. `Terminals` is the one handle every
            // command holds; the supervisor is managed either way (its status
            // reads `Off` when there is no server), so `server_status` always has
            // its state.
            let mode = sessions::server_mode();
            let bundled_server = bundled_server_bin(app.handle());
            let servers = {
                let (daedalus_ids, db) = (
                    app.state::<daedalus::host::DaedalusHost>().ids().clone(),
                    app.state::<db::Db>().inner().clone(),
                );
                let (emit_to, awake_of, held_by) = (
                    app.handle().clone(),
                    app.handle().clone(),
                    app.handle().clone(),
                );
                server::LocalServers::new(server::ServerConfig {
                    app_data_dir: data_dir.clone(),
                    log_dir: app.path().app_log_dir().ok(),
                    bundled_binary: bundled_server.clone(),
                    mode,
                    ids: daedalus_ids,
                    retire: terminal::retire_exited(db),
                    // Every state change reaches the frontend, which also re-runs
                    // `terminal_adopt` on the move into `Running`: an adopt that
                    // met a server still coming up returned without its panes.
                    emit: Arc::new(move |status| {
                        use tauri_specta::Event as _;
                        let _ = server::commands::ServerStateChanged(status).emit(&emit_to);
                    }),
                    keep_awake: Arc::new(move || awake_of.state::<awake::KeepAwake>().wanted()),
                    keep_awake_held: Arc::new(move |held| {
                        held_by.state::<awake::KeepAwake>().confirm(held)
                    }),
                })
            };
            terminal::manage(app.handle(), mode, &servers);
            app.manage(servers.clone());

            // Owns the worktree filesystem watcher; `watch_worktrees` points it at
            // the active repo so the Trees views refresh live on disk changes.
            app.manage(git_watch::WorktreeWatcher::default());

            // Watch ~/.claude/projects so the Settings → Usage panel refreshes live
            // as Claude sessions grow, without polling. Best-effort; started once at
            // a fixed path (unlike the per-repo worktree watcher). Kept in managed
            // state so its watcher thread lives for the whole app.
            let usage_watcher = usage::UsageWatcher::default();
            usage_watcher.start(app.handle());
            app.manage(usage_watcher);

            // The Conversation view's reader: its warm parses, and the watch
            // that keeps an open conversation live (started by the first read).
            app.manage(conversation::Conversations::new(app.handle()));

            // Listen on a Unix socket that the `santree-hook` binary nudges after
            // each session-state write, so the frontend refreshes in realtime.
            // Best-effort — a bind failure just means the UI falls back to its
            // on-mount / on-focus fetch.
            if let Err(e) = session_signal::start(app.handle(), &data_dir.join("santree-signal.sock"))
            {
                log::warn!("session-state signal socket failed to bind: {e:#}; live state updates disabled");
            }

            // Vertically centre the macOS traffic lights in our 46px top bar so
            // they line up with the chrome icons (the `trafficLightPosition`
            // config field is ignored under titleBarStyle: Overlay). decorum
            // does it natively and re-applies on resize.
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                if let Some(main) = app.get_webview_window("main") {
                    // decorum centers the buttons at `y/2 + 4 + button_height/2`
                    // from the window top. The chrome icons sit at the 46px bar's
                    // center (~23px), so y=22 lines the traffic lights up with them.
                    let _ = main.set_traffic_lights_inset(19.0, 22.0);
                }
            }

            log::info!("santree started");

            // CI's packaged-app probe (see `server::smoke_enabled`). The hook resource is
            // asserted *through* `resource_dir()` rather than with a `test -x` on
            // the bundle, because resolving it that way is what the app itself
            // does — a bundle can carry the file at a path the runtime can't find.
            if server::smoke_enabled() {
                match hook_bin::bundled(app.handle()) {
                    Some(p) => log::info!("smoke: resolved the bundled hook at {}", p.display()),
                    None => {
                        eprintln!("smoke: FAILED — the bundled santree-hook did not resolve");
                        std::process::exit(2);
                    }
                }
                // The bundled server must resolve and be the revision this app
                // was built against. Asked of the binary (`version --json`), never
                // by starting one: the run launches nothing that outlives it.
                if mode != sessions::Mode::Off {
                    let verdict = bundled_server
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("the bundled santree-server did not resolve"))
                        .and_then(server::smoke_assert);
                    match verdict {
                        Ok(()) => log::info!("smoke: the bundled santree-server matches this app"),
                        Err(e) => {
                            eprintln!("smoke: FAILED — {e:#}");
                            std::process::exit(2);
                        }
                    }
                }
                start_smoke_watchdog();
            } else if mode != sessions::Mode::Off {
                // Connect to this build's server, launching it if none runs, and
                // find the older ones still holding sessions. Never under the
                // smoke run (`ensure` refuses there too: the two share one
                // predicate).
                let servers = servers.clone();
                tauri::async_runtime::spawn(async move { servers.ensure().await });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // By the time an exit is actually requested it's already been confirmed
            // (QuitGuard asks only when quitting ends in-app terminals): ⌘Q goes
            // through the custom menu item, the close button / ⌘W through the
            // window's `onCloseRequested`, and both finish via `quit_app`/`destroy()`.
            // So just let go of the terminals here.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // In-app terminals end with the app — setup scripts are panes like
                // the rest — and a local server's are let go and keep running.
                terminal::release(app);
            }
        });
}

/// The menu id of our custom Quit item. It replaces `PredefinedMenuItem::quit`,
/// whose native terminate can't be intercepted, so ⌘Q can be routed through the
/// quit-confirmation dialog.
const QUIT_MENU_ID: &str = "santree-quit";

/// Build the application menu. This mirrors Tauri's default menu (so the standard
/// Edit/Window/etc. shortcuts keep working) but swaps the predefined Quit for a
/// custom `MenuItem` we can catch in `on_menu_event`.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit santree", true, Some("CmdOrCtrl+Q"))?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// Whether the "confirm before quitting" setting is on. Defaults ON: a missing
/// value still confirms, and only an explicit `"false"` opts out (mirrors the
/// frontend in `QuitGuard.tsx`). Reads the DB synchronously — acceptable since it
/// only runs on a quit attempt.
fn confirm_on_quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(db) = app.try_state::<db::Db>() else {
        return false; // DB not ready → don't block shutdown
    };
    let value = tauri::async_runtime::block_on(settings::get(&db, "app", "confirm_on_quit"))
        .ok()
        .flatten();
    value.as_deref() != Some("false")
}

/// The bundled `santree-server`: the resource dir in a bundled build. A debug
/// build also takes a sibling of the running executable (`cargo build` lands
/// both in `target/debug`), the way `hook_bin` finds `santree-hook`; a release
/// never does — it would exec whatever sits in `Contents/MacOS`, and the server
/// must be the one the bundle was signed with. `None` if neither exists —
/// `Mode::Off` never asks.
fn bundled_server_bin(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    pick_server_bin(
        app.path().resource_dir().ok().as_deref(),
        std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(std::path::Path::parent),
        cfg!(debug_assertions),
    )
}

/// [`bundled_server_bin`]'s choice over the two places it looks, and whether the
/// second is allowed at all.
fn pick_server_bin(
    resources: Option<&std::path::Path>,
    beside_exe: Option<&std::path::Path>,
    allow_beside_exe: bool,
) -> Option<std::path::PathBuf> {
    let found = |dir: &std::path::Path| {
        let p = dir.join("santree-server");
        p.exists().then_some(p)
    };
    resources
        .and_then(found)
        .or_else(|| beside_exe.filter(|_| allow_beside_exe).and_then(found))
}

/// CI's "does the packaged app actually start?" probe, enabled with
/// `SANTREE_SMOKE=1` (read by [`server::smoke_enabled`], the one predicate the
/// local server's launcher shares): the app exits 0 once its window has loaded
/// (`on_page_load`), and this watchdog fails the run if that never happens.
///
/// Everything else in the release pipeline inspects the *bundle* — codesign,
/// notarization, the stapled ticket, the hook resource being present. Nothing
/// runs it. So a panic in `setup`, a `frontendDist` that didn't ship, or a
/// resource the bundle lists but the runtime can't resolve would all reach users
/// through a green pipeline. This is deliberately start-and-quit rather than
/// end-to-end: `tauri-driver` can't drive WKWebView, so "the window loaded" is
/// the strongest signal available on macOS.
///
/// Without the watchdog a hang would sit
/// until the CI job's own timeout, reported as an infrastructure flake rather
/// than as the app failing to start.
fn start_smoke_watchdog() {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(90);
    std::thread::spawn(move || {
        std::thread::sleep(LIMIT);
        eprintln!(
            "smoke: FAILED — the window did not finish loading within {}s",
            LIMIT.as_secs()
        );
        std::process::exit(3);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regenerates `src/bindings.ts`. Run on its own via `pnpm gen:bindings`,
    /// and also guards that the command set always produces valid bindings.
    #[test]
    fn export_bindings_succeeds() {
        export_bindings(&specta_builder()).expect("bindings export should succeed");
    }

    /// A release resolves the server from the bundle's resources alone: a
    /// `santree-server` beside the executable is only ever a dev build's.
    #[test]
    fn a_release_never_takes_a_server_from_beside_its_executable() {
        let dir = tempfile::tempdir().unwrap();
        let (resources, beside) = (dir.path().join("Resources"), dir.path().join("MacOS"));
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::write(beside.join("santree-server"), b"planted").unwrap();

        assert_eq!(
            pick_server_bin(Some(&resources), Some(&beside), false),
            None
        );
        assert_eq!(
            pick_server_bin(Some(&resources), Some(&beside), true),
            Some(beside.join("santree-server")),
            "a debug build's cargo output sits beside it"
        );
        // The bundle's own copy wins in both.
        std::fs::write(resources.join("santree-server"), b"bundled").unwrap();
        for allow in [false, true] {
            assert_eq!(
                pick_server_bin(Some(&resources), Some(&beside), allow),
                Some(resources.join("santree-server"))
            );
        }
        assert_eq!(pick_server_bin(None, None, true), None);
    }

    #[test]
    fn merge_paths_puts_login_first_and_drops_dupes_and_empties() {
        // Login PATH wins ordering; current-only entries are appended.
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin:/bin", "/usr/bin:/bin:/sbin"),
            "/opt/homebrew/bin:/usr/bin:/bin:/sbin"
        );
        assert_eq!(merge_paths("/usr/bin::", ":/bin:"), "/usr/bin:/bin");
    }

    /// A panic on *any* thread must reach the log file with enough to debug it —
    /// `panic = "abort"` means this line is the only trace a crash leaves behind.
    #[test]
    fn panic_hook_logs_payload_location_thread_and_backtrace() {
        static CAPTURED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
        struct Capture;
        impl log::Log for Capture {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, record: &log::Record) {
                CAPTURED.lock().unwrap().push(record.args().to_string());
            }
            fn flush(&self) {}
        }
        log::set_logger(&Capture).expect("no other logger is installed under test");
        log::set_max_level(log::LevelFilter::Error);

        install_panic_hook();
        let _ = std::thread::Builder::new()
            .name("panicky".into())
            .spawn(|| panic!("boom"))
            .unwrap()
            .join();

        let logged = CAPTURED.lock().unwrap().join("\n");
        assert!(logged.contains("panic on thread 'panicky'"), "{logged}");
        assert!(logged.contains("boom"), "{logged}");
        assert!(logged.contains("lib.rs:"), "location: {logged}");
        assert!(
            logged.lines().count() > 3,
            "a backtrace should follow: {logged}"
        );
    }

    /// Everything we put there (the PATH cache, headless prompt files) is either read
    /// back into `PATH` or carries repo content, so the dir must not be traversable by
    /// another local user — the reason it isn't a shared `/tmp` path any more.
    #[test]
    fn private_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_dir().expect("a home dir to anchor the cache");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn sanitize_path_list_drops_relative_entries() {
        assert_eq!(
            sanitize_path_list("/opt/homebrew/bin:.:bin:/usr/bin:\n"),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        assert_eq!(sanitize_path_list(""), None);
        assert_eq!(sanitize_path_list(".:relative"), None);
    }
}
