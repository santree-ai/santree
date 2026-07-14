//! Tauri application wiring: logging, the typed command bridge, and the builder.
//!
//! Keep this file about *registration* only. Command bodies live in
//! [`commands`], and the real logic lives in the `santree-core` crate.

mod agent;
mod commands;
mod commit_draft;
mod db;
mod env;
mod error;
mod git;
mod git_watch;
mod github;
mod gql;
mod hooks;
mod linear;
mod notes;
mod openers;
mod pr;
mod pricing;
mod prompts;
mod repo;
mod reviewed;
mod reviews;
mod session;
mod session_signal;
mod settings;
mod tabs;
mod terminal;
mod text_store;
mod usage;
mod worktree;

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
            git_watch::WorktreeChanged,
            session_signal::SessionStateChanged,
            session_signal::SessionUsageChanged,
            usage::UsageChanged,
            usage::UsageProgress
        ])
        .commands(collect_commands![
            commands::list_repos,
            commands::add_repo,
            commands::list_agents,
            commands::claude_usage,
            commands::agent_auth,
            commands::github_status,
            commands::worktrees,
            commands::base_worktree,
            commands::create_worktree,
            commands::remove_worktree,
            commands::run_worktree_setup_streamed,
            commands::cancel_worktree_setup,
            commands::pull_worktree,
            commands::push_worktree,
            commands::pull_remote_worktree,
            commands::update_base_branch,
            commands::worktree_status,
            commands::worktree_file_diff,
            commands::worktree_file_source,
            commands::worktree_files,
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
            commands::fix_ci_prompt,
            commands::create_worktree_for_pr,
            commands::agent_session,
            commands::started_investigations,
            commands::list_worktree_tabs,
            commands::add_worktree_tab,
            commands::rename_worktree_tab,
            commands::remove_worktree_tab,
            commands::pr_draft,
            commands::create_pull_request,
            commands::pr_reviewers,
            commands::worktree_prs,
            commands::reviews,
            commands::merge_queue,
            commands::pr_detail,
            commands::pr_repo_labels,
            commands::set_pr_labels,
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
            commands::triage_add_comment,
            commands::claude_hook_settings,
            commands::claude_hook_settings_no_git,
            commands::session_states,
            commands::session_usage_live,
            commands::triage_schedule,
            commands::get_settings,
            commands::set_settings,
            commands::quit_app,
            commands::task_note,
            commands::set_task_note,
            commands::list_claude_commands,
            commands::read_claude_command,
            commands::write_claude_command,
            commands::claude_models,
            commands::get_setting,
            commands::set_setting,
            commands::resolve_setting,
            commands::list_prompts,
            commands::set_prompt,
            commands::preview_prompt,
            commands::create_prompt_block,
            commands::delete_prompt_block,
            commands::env_file_vars,
            commands::linear_auth_status,
            commands::linear_orgs,
            commands::set_repo_linear_org,
            commands::linear_list_issues,
            commands::linear_connect,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
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
#[cfg(unix)]
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
#[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
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
#[cfg(unix)]
fn path_cache_file() -> Option<std::path::PathBuf> {
    Some(private_dir()?.join("login-path"))
}

/// Keep only the absolute entries of a cached PATH string; `None` when nothing usable
/// survives. This is what we prepend to `PATH` before any subprocess spawns, so a
/// relative entry would resolve `git`/`claude`/hooks against whatever cwd a child
/// happens to run in — defence in depth behind the 0700 cache dir. Pure, for testability.
#[cfg(unix)]
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
#[cfg(unix)]
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

    // Must run before any subprocess is spawned (git, hooks, setup scripts, agents).
    #[cfg(unix)]
    hydrate_path();

    let builder = specta_builder();

    // In debug builds, (re)generate `src/bindings.ts` on every run so the typed
    // client tracks the Rust commands during development. Release builds skip
    // this — the committed bindings are used as-is.
    #[cfg(debug_assertions)]
    export_bindings(&builder).expect("failed to export typescript bindings");

    let tauri_builder = tauri::Builder::default()
        // Two independent instances (nothing stops this on Linux, unlike macOS's
        // Dock/LaunchServices) would run separate PTY managers and fs watchers
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
        .plugin(tauri_plugin_dialog::init());

    // decorum's only job here is the traffic-light inset applied in `.setup()`, which
    // is macOS-only — and on Linux the crate drags in an unsound memmap2 (see the
    // cfg'd dependency in Cargo.toml). So it isn't even linked on other platforms.
    #[cfg(target_os = "macos")]
    let tauri_builder = tauri_builder.plugin(tauri_plugin_decorum::init());

    tauri_builder
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
            // Garbage-collect the tables nothing else ever deletes from:
            //  · `terminal_sessions` — no code path drops a Triage investigation's row,
            //    so it would grow by one per ticket ever investigated;
            //  · `reviewed_files` — no code path drops a merged/closed PR's marks, so it
            //    would grow with the whole org's PR history.
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
                });
            }
            app.manage(db);

            // Owns all live terminal sessions; commands read it from state.
            app.manage(santree_pty::PtyManager::new());

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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // By the time an exit is actually requested it's already been confirmed:
            // ⌘Q goes through the custom menu item → QuitGuard, the close button /
            // ⌘W goes through the window's `onCloseRequested` → QuitGuard, and both
            // finish via `quit_app`/`destroy()`. So just reap terminal children here.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(pty) = app.try_state::<santree_pty::PtyManager>() {
                    pty.close_all();
                }
                // Setup scripts run their own PTY, outside PtyManager — quitting
                // mid-setup would otherwise orphan `init.sh` and everything it spawned.
                worktree::SETUP_RUNS.kill_all();
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
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
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

    #[cfg(not(target_os = "macos"))]
    {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[&PredefinedMenuItem::close_window(app, None)?, &quit],
        )?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[&PredefinedMenuItem::about(app, None, Some(about))?],
        )?;
        Menu::with_items(app, &[&file, &edit, &window, &help])
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regenerates `src/bindings.ts`. Run on its own via `pnpm gen:bindings`,
    /// and also guards that the command set always produces valid bindings.
    #[test]
    fn export_bindings_succeeds() {
        export_bindings(&specta_builder()).expect("bindings export should succeed");
    }

    #[test]
    fn merge_paths_prepends_login_and_dedups() {
        // Login PATH wins ordering; current-only entries are appended; dupes dropped.
        let login = "/opt/homebrew/bin:/usr/bin:/bin";
        let current = "/usr/bin:/bin:/sbin";
        assert_eq!(
            merge_paths(login, current),
            "/opt/homebrew/bin:/usr/bin:/bin:/sbin"
        );
    }

    #[test]
    fn merge_paths_is_noop_when_login_covers_current() {
        let path = "/opt/homebrew/bin:/usr/bin:/bin";
        assert_eq!(merge_paths(path, path), path);
    }

    #[test]
    fn merge_paths_skips_empty_segments() {
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
    #[cfg(unix)]
    #[test]
    fn private_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_dir().expect("a home dir to anchor the cache");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
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
