//! The host process table, read once and shared.
//!
//! Two features ask the same question of the OS — the Resource Manager ("what is
//! each terminal's process tree costing") and agent detection ("which CLI owns
//! this pane's foreground") — and `ps` is a process spawn. So there is one
//! listing, one parser and one parent→child index here, cached for [`TTL`] so a
//! burst of callers inside one UI tick costs a single `ps` rather than one each.
//!
//! Read-only and input-free: the argv is a constant, no IPC value reaches it,
//! and nothing is signalled, written to, or inspected beyond the six columns
//! `ps` prints.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

/// The one process-table read.
///
/// `-ax` is every process (ours are children of the app, but a `ps` restricted
/// to the session would miss a terminal's daemonised children); `rss` is KiB on
/// both macOS and Linux; `stat` carries the zombie and foreground-process-group
/// flags; `command` is the full argv and goes last because it contains spaces.
///
/// `command` rather than `ucomm` (the accounting name) because `ucomm` lies
/// about exactly the processes this has to identify: measured on macOS, a
/// running `claude` reports `ucomm` `claude.exe`, and a `ugrep` it spawned
/// reported `claude.exe` too. `argv[0]` reported `/opt/homebrew/bin/claude` and
/// `ugrep`, which is the truth in both rows.
///
/// The cost is that the listing transits every host process's full argv, which
/// can carry a secret somebody put on a command line. [`parse_line`] therefore
/// keeps **only `argv[0]`'s basename** and drops the rest before any caller sees
/// a row — nothing here logs, stores, or forwards a command line. See
/// COMPLIANCE.md, "Reading the OS process table is observation, not a loop".
const PS_ARGS: &[&str] = &["-axo", "pid=,ppid=,pcpu=,rss=,stat=,command="];

/// How long one listing is reused. Orca's process-table snapshot uses the same
/// 500ms, for the same reason: several callers can want "what is running right
/// now" inside one UI tick. Short enough that no reader is ever more than half a
/// second behind the kernel.
const TTL: Duration = Duration::from_millis(500);

/// How long one whole read — the `ps` and the parse behind it — may take before
/// it is abandoned. A listing that hangs has to degrade to "we don't know",
/// never to a query that never answers or a lock nobody gets back.
const TIMEOUT: Duration = Duration::from_secs(3);

/// One row of the process table.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// Percent of one core, as `ps` reports it.
    pub cpu_pct: f64,
    pub rss_bytes: f64,
    pub zombie: bool,
    /// `ps`'s `+` flag: this process is in the foreground process group of its
    /// controlling terminal — it is what the pane's keystrokes actually reach.
    pub foreground: bool,
    /// `argv[0]`'s basename: `claude`, `zsh`, `santree`. The whole command line
    /// is deliberately not retained — nothing needs it, and an agent's argv can
    /// run to kilobytes of prompt.
    pub name: String,
}

/// Parse the `ps` listing. A line that doesn't fit is skipped, never fatal: a
/// kernel thread with a blank field or a name `ps` couldn't read must not hide
/// every other process.
pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<Proc> {
    let mut rest = line;
    let pid = field(&mut rest)?.parse().ok()?;
    let ppid = field(&mut rest)?.parse().ok()?;
    let cpu_pct: f64 = field(&mut rest)?.parse().ok()?;
    let rss_kib: f64 = field(&mut rest)?.parse().ok()?;
    let stat = field(&mut rest)?;
    // The command line's first token is argv[0]. A program path containing a
    // space is therefore split — `ps` joins argv with spaces and offers no way
    // to tell one apart — which costs such a process its name and nothing else.
    let name = basename(field(&mut rest)?);
    if name.is_empty() || !cpu_pct.is_finite() || !rss_kib.is_finite() {
        return None;
    }
    Some(Proc {
        pid,
        ppid,
        cpu_pct: cpu_pct.max(0.0),
        rss_bytes: rss_kib.max(0.0) * 1024.0,
        zombie: stat.starts_with('Z'),
        foreground: stat.contains('+'),
        name,
    })
}

/// Take the next whitespace-delimited token off `rest`, leaving the remainder.
fn field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let trimmed = rest.trim_start();
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (token, remainder) = trimmed.split_at(end);
    *rest = remainder;
    (!token.is_empty()).then_some(token)
}

/// Last path component of an executable path.
fn basename(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((_, tail)) => tail.to_string(),
        None => path.to_string(),
    }
}

/// The process table as a parent→children index.
pub struct ProcTree {
    procs: HashMap<u32, Proc>,
    children: HashMap<u32, Vec<u32>>,
}

impl ProcTree {
    pub fn new(procs: Vec<Proc>) -> Self {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for p in &procs {
            // A pid that is its own parent (pid 0 on macOS) would otherwise be an
            // infinite descent.
            if p.ppid != p.pid {
                children.entry(p.ppid).or_default().push(p.pid);
            }
        }
        let procs = procs.into_iter().map(|p| (p.pid, p)).collect();
        Self { procs, children }
    }

    /// One process by pid, if the listing had it.
    pub fn get(&self, pid: u32) -> Option<&Proc> {
        self.procs.get(&pid)
    }

    /// Whether `pid` exists and isn't a zombie.
    pub fn live(&self, pid: u32) -> bool {
        self.procs.get(&pid).is_some_and(|p| !p.zombie)
    }

    /// `root` and every descendant, breadth-first, each paired with its depth
    /// below `root` (0 for `root` itself) — so a caller that wants the process
    /// *closest* to the root can simply take the first match.
    ///
    /// `stop` prunes pids whose subtrees are accounted for elsewhere. A
    /// `visited` set guards the walk against a parent cycle in the snapshot,
    /// which a reused pid can produce between two lines of one listing.
    pub fn descend(&self, root: u32, stop: &HashSet<u32>) -> Vec<(usize, &Proc)> {
        let mut out = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = std::collections::VecDeque::from([(0usize, root)]);
        while let Some((depth, pid)) = queue.pop_front() {
            if !visited.insert(pid) {
                continue;
            }
            let Some(p) = self.procs.get(&pid) else {
                continue;
            };
            out.push((depth, p));
            if let Some(kids) = self.children.get(&pid) {
                queue.extend(
                    kids.iter()
                        .filter(|kid| !stop.contains(kid))
                        .map(|kid| (depth + 1, *kid)),
                );
            }
        }
        out
    }
}

struct Cached {
    at: Instant,
    /// `None` when that read *failed*. Failures are cached too, so a `ps` that
    /// is persistently slow or broken costs one timeout per [`TTL`] rather than
    /// one per caller — otherwise every caller in turn queues behind a fresh
    /// three-second wait for an answer already known to be unavailable.
    tree: Option<Arc<ProcTree>>,
}

fn cache() -> &'static tokio::sync::Mutex<Option<Cached>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The current process table, at most [`TTL`] old.
///
/// The lock is deliberately held across the read: a second caller arriving
/// mid-listing waits for that one and gets its result, rather than starting a
/// competing spawn. That is the whole point of the cache — one `ps` per burst,
/// not one per caller.
///
/// Which makes the [`TIMEOUT`] load-bearing, and it wraps the *whole* read
/// rather than only the `ps`. The parse runs on the blocking pool, which santree
/// shares with PTY writes — and a PTY write can genuinely wedge on a stuck
/// child. An unbounded await inside the critical section would then hold this
/// lock forever, and every later process-table read, the Resource Manager's
/// included, would wait on it forever too. Bounding the section guarantees the
/// lock comes back.
pub async fn snapshot() -> Result<Arc<ProcTree>> {
    let mut cached = cache().lock().await;
    if let Some(hit) = cached.as_ref().filter(|c| c.at.elapsed() < TTL) {
        return hit
            .tree
            .clone()
            .ok_or_else(|| anyhow::anyhow!("the last process table read failed"));
    }
    let read = tokio::time::timeout(TIMEOUT, read_tree())
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("ps did not answer within {TIMEOUT:?}")));
    *cached = Some(Cached {
        at: Instant::now(),
        tree: read.as_ref().ok().cloned(),
    });
    read
}

async fn read_tree() -> Result<Arc<ProcTree>> {
    let out = tokio::process::Command::new("ps")
        .args(PS_ARGS)
        .kill_on_drop(true)
        .output()
        .await
        .context("running ps")?;
    if !out.status.success() {
        bail!("ps exited with {}", out.status);
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    // The parse and the index build are CPU work over every process on the host;
    // they don't belong on the async runtime.
    Ok(Arc::new(
        tokio::task::spawn_blocking(move || ProcTree::new(parse_ps(&text))).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `ps` columns, including an argv with spaces, a foreground shell,
    /// a zombie, and rows the parser must skip rather than choke on.
    const LISTING: &str = "\
    1     0   0.0  24688 Ss   /sbin/launchd
  100     1   1.5  50000 S    /Applications/santree.app/Contents/MacOS/santree
  200   100   0.0   4000 Ss   /bin/zsh -l
  201   200  12.5 300000 R+   /opt/homebrew/bin/claude --settings /tmp/h.json
  202   201   0.5  20000 S    /usr/bin/git status
  210   100   0.0   3000 Z    (zsh)
  300     1   0.0   5000 S    /Applications/Claude.app/Contents/MacOS/Claude Helper --type=utility
  400   100   2.0  10000 S    /opt/homebrew/bin/codex
    x     y   0.0      0 S    junk
  500   100   abc    100 S    /bin/bad-cpu
  600   100   0.0
";

    #[test]
    fn parse_ps_reads_the_columns_and_skips_malformed_lines() {
        let procs = parse_ps(LISTING);
        let pids: Vec<u32> = procs.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![1, 100, 200, 201, 202, 210, 300, 400]);

        let claude = procs.iter().find(|p| p.pid == 201).unwrap();
        assert_eq!(claude.ppid, 200);
        assert_eq!(claude.cpu_pct, 12.5);
        assert_eq!(
            claude.rss_bytes,
            300_000.0 * 1024.0,
            "rss is KiB on the wire"
        );
        assert!(!claude.zombie);
        assert_eq!(
            claude.name, "claude",
            "the name is argv[0]'s basename, not the whole command line"
        );

        let helper = procs.iter().find(|p| p.pid == 300).unwrap();
        assert_eq!(
            helper.name, "Claude",
            "a path with a space loses its tail — ps offers no way to tell one from an argument"
        );

        assert!(procs.iter().find(|p| p.pid == 210).unwrap().zombie);
        assert!(parse_ps("").is_empty());
        assert!(parse_ps("\n\n   \n").is_empty());
    }

    /// COMPLIANCE.md, "Reading the OS process table": the listing transits every
    /// host process's full argv, and only `argv[0]`'s basename may survive the
    /// parse. A `Proc` that kept a command line would pull whatever somebody
    /// else put on theirs — a password, a token — into santree's own reporting.
    /// Asserted over the whole `Debug` rendering, so a new field cannot quietly
    /// start carrying one.
    #[test]
    fn nothing_but_argv_zeros_basename_survives_the_parse() {
        let procs = parse_ps("  700 100 0.0 4000 S /usr/bin/mysql --password=hunter2 --host=db\n");
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "mysql");
        let rendered = format!("{:?}", procs[0]);
        assert!(
            !rendered.contains("hunter2") && !rendered.contains("password"),
            "an argument reached a Proc: {rendered}"
        );
    }

    /// The `+` flag is the whole foreground signal, and it has to survive the
    /// other letters in `stat`.
    #[test]
    fn the_foreground_flag_is_read_off_stat() {
        let procs = parse_ps(LISTING);
        let foreground: Vec<u32> = procs
            .iter()
            .filter(|p| p.foreground)
            .map(|p| p.pid)
            .collect();
        assert_eq!(foreground, vec![201], "only the pane's foreground process");
        assert!(!parse_ps("1 0 0.0 100 Ss /bin/zsh")[0].foreground);
        assert!(parse_ps("1 0 0.0 100 SNs+ /bin/zsh")[0].foreground);
    }

    /// Depth-ordered, prunable, and it terminates on a cyclic listing.
    #[test]
    fn descend_walks_the_subtree_nearest_first() {
        let tree = ProcTree::new(parse_ps(LISTING));
        let none = HashSet::new();

        let walk: Vec<(usize, u32)> = tree
            .descend(200, &none)
            .into_iter()
            .map(|(depth, p)| (depth, p.pid))
            .collect();
        assert_eq!(walk, vec![(0, 200), (1, 201), (2, 202)]);

        let pruned: Vec<u32> = tree
            .descend(100, &HashSet::from([200]))
            .into_iter()
            .map(|(_, p)| p.pid)
            .collect();
        assert_eq!(pruned, vec![100, 210, 400], "the pruned subtree is skipped");

        assert!(tree.live(200));
        assert!(!tree.live(210), "a zombie is not live");
        assert!(!tree.live(999), "a vanished pid is not live");
        assert!(tree.descend(999, &none).is_empty());
        assert_eq!(tree.get(400).map(|p| p.name.as_str()), Some("codex"));
    }

    /// A parent cycle in one listing (pid reuse mid-read) must terminate.
    #[test]
    fn descend_survives_a_parent_cycle() {
        let tree = ProcTree::new(parse_ps("1 2 0.0 4 S /a\n2 1 0.0 4 S /b\n"));
        assert_eq!(tree.descend(1, &HashSet::new()).len(), 2);
    }

    /// The real `ps`: it runs, this process is in the listing, and a second read
    /// inside the TTL is served from the same snapshot.
    #[tokio::test]
    async fn snapshot_lists_this_process_and_is_reused_within_the_ttl() {
        let first = snapshot().await.expect("ps runs");
        let me = std::process::id();
        assert!(
            first.get(me).is_some_and(|p| !p.name.is_empty()),
            "pid {me} should be in the listing"
        );
        let second = snapshot().await.expect("ps runs");
        assert!(
            Arc::ptr_eq(&first, &second),
            "a second read inside the TTL must not spawn another ps"
        );
    }
}
