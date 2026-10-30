//! The Conversation view's reader: the record an agent CLI keeps of a session
//! (Claude's transcript, Codex's rollout), parsed into the provider-neutral
//! journal of [`santree_core::conversation`] while the real CLI keeps running
//! in its terminal. Display-only (COMPLIANCE.md, "Transcript reads"): what is
//! read here reaches a view and nothing else — no model, prompt or PTY.
//!
//! A read names a session, never a file. The file is derived here, from
//! santree's own records: a tab's `terminal_sessions` row, or a worktree's
//! session listing re-derived exactly as Session history derives it. A
//! subagent is matched against its session's `subagents/` listing by name.
//!
//! Only Claude's record is read for now. A Codex session answers `NotFound`
//! with its agent and thread id, so a view can say why it has nothing to show.

mod cache;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use santree_core::conversation::claude::{is_subagent_id, TranscriptKind};
use santree_core::conversation::{
    ConversationAvailability, ConversationCursor, ConversationMeta, ConversationRead,
    ConversationTarget,
};
use santree_core::domain::AgentKind;

use crate::db::Db;
use crate::{record_file, repo, session, worktree};

/// "A record a Conversation view reads changed on disk". The view whose
/// session this names reads again from its cursor.
#[derive(Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ConversationChanged {
    /// The Claude session id or Codex thread id whose record changed.
    pub session_id: String,
}

/// How long a listed session's located transcript is trusted before the
/// listing is derived again. Deriving it parses every session of the worktree
/// (cached, but not free), and a live view reads several times a second.
const LISTED_TTL: Duration = Duration::from_secs(30);
const MAX_LISTED: usize = 256;

/// A worktree's listed session: `(repo, issue_id, session_id)`.
type ListedKey = (String, String, String);

/// The reader's state, managed by the app: the warm parses, the listed
/// sessions already located, and the watch that keeps open views live.
pub struct Conversations {
    shared: Arc<Shared>,
}

struct Shared {
    parses: Mutex<cache::Parses>,
    /// Each listed session's transcript, as last located, and when.
    listed: Mutex<HashMap<ListedKey, (PathBuf, Instant)>>,
    watch: watch::Watch,
}

impl Conversations {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            shared: Arc::new(Shared {
                parses: Mutex::default(),
                listed: Mutex::default(),
                watch: watch::Watch::new(app),
            }),
        }
    }
}

/// Where a target's conversation is.
#[derive(Debug, PartialEq)]
enum Located {
    /// A Claude transcript on this Mac.
    Claude { session_id: String, main: PathBuf },
    /// Nothing to read here. `follow` is a Claude session whose record may
    /// still appear, which a view should hear about when it does.
    Elsewhere {
        availability: ConversationAvailability,
        agent: Option<AgentKind>,
        session_id: Option<String>,
        follow: bool,
    },
}

impl Located {
    fn elsewhere(
        availability: ConversationAvailability,
        agent: Option<AgentKind>,
        session_id: Option<String>,
    ) -> Self {
        Located::Elsewhere {
            availability,
            agent,
            session_id,
            follow: false,
        }
    }

    /// A session of an agent whose record isn't read live yet: Codex, until
    /// its own reader lands.
    fn unread_agent(agent: AgentKind, session_id: String) -> Self {
        Located::elsewhere(
            ConversationAvailability::NotFound,
            Some(agent),
            Some(session_id),
        )
    }

    /// A Claude session whose transcript is not (or not yet) on disk.
    fn claude_missing(session_id: String) -> Self {
        Located::Elsewhere {
            availability: ConversationAvailability::NotFound,
            agent: Some(AgentKind::Claude),
            session_id: Some(session_id),
            follow: true,
        }
    }
}

/// The conversation `target` names — or, with `agent_id`, one of its
/// subagents' — from `cursor` on.
pub async fn read(
    conversations: &Conversations,
    db: &Db,
    target: ConversationTarget,
    agent_id: Option<String>,
    cursor: Option<ConversationCursor>,
) -> anyhow::Result<ConversationRead> {
    if let Some(id) = &agent_id {
        anyhow::ensure!(is_subagent_id(id), "invalid subagent id");
    }
    let located = match &target {
        ConversationTarget::Tab { repo, term_key } => locate_tab(db, repo, term_key).await?,
        ConversationTarget::Session {
            repo,
            issue_id,
            session_id,
        } => {
            conversations
                .shared
                .locate_listed(db, repo, issue_id, session_id)
                .await?
        }
    };
    let shared = conversations.shared.clone();
    tokio::task::spawn_blocking(move || shared.read(located, agent_id, cursor)).await?
}

/// The session a tab's terminal is bound to now: its `terminal_sessions` row.
/// One surface can hold a session per provider; this reader reads Claude's, so
/// a Claude row wins when there are several (and a Codex tab, which has only
/// its own, gets the Codex answer).
async fn locate_tab(db: &Db, repo: &str, term_key: &str) -> anyhow::Result<Located> {
    crate::tabs::validate_term_key(term_key).map_err(|e| anyhow!(e))?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT session_id, cwd, agent_kind FROM terminal_sessions
         WHERE repo = ? AND term_key = ? ORDER BY created_at DESC",
    )
    .bind(repo)
    .bind(term_key)
    .fetch_all(db)
    .await?;
    let claude = AgentKind::Claude.as_str();
    let Some((session_id, cwd, agent)) = rows
        .iter()
        .find(|row| row.2 == claude)
        .or_else(|| rows.first())
        .cloned()
    else {
        return Ok(Located::elsewhere(
            ConversationAvailability::NoSession,
            None,
            None,
        ));
    };
    let agent: AgentKind = agent.parse()?;
    if repo::is_daedalus(db, repo).await? {
        return Ok(Located::elsewhere(
            ConversationAvailability::Remote,
            Some(agent),
            Some(session_id),
        ));
    }
    if agent != AgentKind::Claude {
        return Ok(Located::unread_agent(agent, session_id));
    }
    // The id is joined into a path below, so only the shape santree mints for
    // `--session-id` gets that far.
    if !session::is_session_id(&session_id) {
        return Ok(Located::elsewhere(
            ConversationAvailability::NotFound,
            Some(AgentKind::Claude),
            Some(session_id),
        ));
    }
    let id = session_id.clone();
    let main = tokio::task::spawn_blocking(move || {
        claude_transcript(&crate::usage::projects_roots(), &cwd, &id)
    })
    .await?;
    Ok(match main {
        Some(main) => Located::Claude { session_id, main },
        None => Located::claude_missing(session_id),
    })
}

/// Where Claude keeps `session_id`'s transcript for a session run in `cwd`:
/// `<root>/<cwd slug>/<session_id>.jsonl` ([`session::transcript_file`], which
/// refuses an id of any other shape) under the first transcript root that has
/// it.
fn claude_transcript(roots: &[PathBuf], cwd: &str, session_id: &str) -> Option<PathBuf> {
    roots
        .iter()
        .filter_map(|root| session::transcript_file(root, cwd, session_id))
        .find(|path| path.is_file())
}

/// The subagent transcript among `listing` (the session's own
/// `subagents/` listing) whose name is `agent_id`'s. The id is only ever
/// compared against the names the listing found, never joined onto a path.
fn subagent_transcript(listing: Vec<PathBuf>, agent_id: &str) -> Option<PathBuf> {
    if !is_subagent_id(agent_id) {
        return None;
    }
    let name = format!("agent-{agent_id}.jsonl");
    listing
        .into_iter()
        .find(|path| path.file_name().and_then(|n| n.to_str()) == Some(name.as_str()))
}

impl Shared {
    /// A session from a worktree's history list, re-derived from that list
    /// exactly as the history row's detail is (`worktree::session_detail`):
    /// the id must name one of the worktree's own sessions, and its
    /// transcript is the one the listing located.
    async fn locate_listed(
        &self,
        db: &Db,
        repo: &str,
        issue_id: &str,
        session_id: &str,
    ) -> anyhow::Result<Located> {
        worktree::validate_issue_id(issue_id)?;
        if repo::is_daedalus(db, repo).await? {
            return Ok(Located::elsewhere(
                ConversationAvailability::Remote,
                None,
                None,
            ));
        }
        let key = (
            repo.to_string(),
            issue_id.to_string(),
            session_id.to_string(),
        );
        if let Some((main, _)) = lock(&self.listed)
            .get(&key)
            .filter(|(_, at)| at.elapsed() < LISTED_TTL)
        {
            return Ok(Located::Claude {
                session_id: session_id.to_string(),
                main: main.clone(),
            });
        }
        let dir = worktree::local_worktree(db, repo, issue_id).await?;
        let listed = session::history(db, repo, issue_id, &dir).await?;
        let Some(entry) = listed.iter().find(|s| s.session_id == session_id) else {
            bail!("no session '{session_id}' has run in this worktree");
        };
        if entry.agent_kind != AgentKind::Claude {
            return Ok(Located::unread_agent(
                entry.agent_kind,
                session_id.to_string(),
            ));
        }
        let Some(main) =
            session::listed_transcript(db, repo, issue_id, &dir, &listed, session_id).await?
        else {
            return Ok(Located::claude_missing(session_id.to_string()));
        };
        let mut listed = lock(&self.listed);
        listed.retain(|_, (_, at)| at.elapsed() < LISTED_TTL);
        if listed.len() < MAX_LISTED {
            listed.insert(key, (main.clone(), Instant::now()));
        }
        Ok(Located::Claude {
            session_id: session_id.to_string(),
            main,
        })
    }

    /// Read a located conversation from `cursor` on. Blocking.
    fn read(
        &self,
        located: Located,
        agent_id: Option<String>,
        cursor: Option<ConversationCursor>,
    ) -> anyhow::Result<ConversationRead> {
        let (session_id, main) = match located {
            Located::Claude { session_id, main } => (session_id, main),
            Located::Elsewhere {
                availability,
                agent,
                session_id,
                follow,
            } => {
                if let Some(id) = session_id.as_deref().filter(|_| follow) {
                    self.watch.reading(id);
                }
                return Ok(nothing(availability, agent, session_id));
            }
        };
        self.watch.reading(&session_id);
        let missing = |session_id: String| {
            nothing(
                ConversationAvailability::NotFound,
                Some(AgentKind::Claude),
                Some(session_id),
            )
        };
        let main = match std::fs::canonicalize(&main) {
            Ok(main) => main,
            Err(e) if session::is_absence(&e) => {
                self.forget_listed(&main);
                return Ok(missing(session_id));
            }
            Err(e) => return Err(e).with_context(|| format!("reading {}", main.display())),
        };
        // The located file, links resolved, must still be one of Claude's: a
        // row or a listing can name a path, and a link can point anywhere. The
        // parse checks it again on the handle it reads, which is the check a
        // swap after this one cannot get past.
        let roots = record_file::canonical(&crate::usage::projects_roots());
        anyhow::ensure!(
            record_file::within(&roots, &main),
            "this session's transcript is outside Claude's projects directory"
        );
        let (path, kind) = match agent_id {
            None => (main.clone(), TranscriptKind::Main),
            Some(id) => match subagent_transcript(crate::usage::subagent_files(&main), &id) {
                Some(path) => (path, TranscriptKind::Subagent),
                None => return Ok(missing(session_id)),
            },
        };
        let slot = lock(&self.parses).slot(&path, kind);
        let (read, bytes) = {
            let mut parse = lock(&slot.parse);
            let read = parse.read(&path, &roots, cursor.as_ref(), || {
                crate::usage::subagent_files(&main)
            });
            (read, parse.approx_bytes())
        };
        slot.measured(bytes);
        // A parse grows as its session runs: the budget is kept after every
        // read, not only when a new parse joins. The one just read is held
        // (`slot`), so it is never what goes.
        lock(&self.parses).fit();
        drop(slot);
        let snapshot = match read {
            Ok(snapshot) => snapshot,
            Err(e) if session::is_absence(&e) => return Ok(missing(session_id)),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        Ok(ConversationRead {
            availability: ConversationAvailability::Ready,
            agent: Some(AgentKind::Claude),
            session_id: Some(session_id),
            cursor: snapshot.cursor,
            reset: snapshot.reset,
            items: snapshot.items,
            meta: snapshot.meta,
        })
    }

    /// A located transcript that has since gone: locate it afresh next time.
    fn forget_listed(&self, main: &Path) {
        lock(&self.listed).retain(|_, (path, _)| path != main);
    }
}

/// A read with nothing to draw — the view says why, in place.
fn nothing(
    availability: ConversationAvailability,
    agent: Option<AgentKind>,
    session_id: Option<String>,
) -> ConversationRead {
    ConversationRead {
        availability,
        agent,
        session_id,
        cursor: ConversationCursor {
            epoch: String::new(),
            rev: 0,
        },
        reset: true,
        items: Vec::new(),
        meta: ConversationMeta::default(),
    }
}

/// A poisoned lock still guards consistent data here: every critical section
/// is a map update.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A read takes a terminal key and a subagent id over IPC. Neither may
    /// reach the filesystem as anything but a lookup key or a name compared
    /// against santree's own listings — and a session id santree stored is
    /// joined into a path only when it has the shape santree mints.
    #[tokio::test]
    async fn a_hostile_agent_id_or_term_key_never_becomes_a_path() {
        let listing = vec![
            PathBuf::from("/s/subagents/agent-a1.jsonl"),
            PathBuf::from("/s/subagents/agent-a2.jsonl"),
        ];
        let long = "a".repeat(65);
        for id in [
            "",
            "..",
            "../agent-a1",
            "a1/..",
            "a\\1",
            "a1.jsonl",
            "a 1",
            "a\0",
            &long,
        ] {
            assert!(!is_subagent_id(id), "{id:?}");
            assert_eq!(subagent_transcript(listing.clone(), id), None, "{id:?}");
        }
        assert_eq!(
            subagent_transcript(listing.clone(), "a2"),
            Some(listing[1].clone())
        );
        assert_eq!(subagent_transcript(listing, "a3"), None);

        let base =
            std::env::temp_dir().join(format!("santree-conversation-ids-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        sqlx::query(
            "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id)
             VALUES ('repo', 'tree:AK-1', '/tmp', '../../../../etc/passwd')",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(
            locate_tab(&db, "repo", "tree:AK-1").await.unwrap(),
            Located::elsewhere(
                ConversationAvailability::NotFound,
                Some(AgentKind::Claude),
                Some("../../../../etc/passwd".into()),
            ),
            "a stored id with a path's shape is never joined into one"
        );
        assert_eq!(
            locate_tab(&db, "repo", "tree:../../etc").await.unwrap(),
            Located::elsewhere(ConversationAvailability::NoSession, None, None),
            "a key is only ever a lookup key"
        );
        for key in ["", "tree:AK-1\n", "tree:AK-1;rm"] {
            assert!(locate_tab(&db, "repo", key).await.is_err(), "{key:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
