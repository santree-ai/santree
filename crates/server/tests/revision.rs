//! `REVISION` drift: the server's code and the crates it links, hashed,
//! against the committed `revision.lock`. Like the bindings check, it fails
//! until the developer acknowledges the change by bumping `REVISION` — an app
//! that ships changed server code under an old revision would adopt the old,
//! still-running server and never run the new code.
//!
//! What is hashed, byte for byte (only CRLF is folded to LF, so a checkout's
//! line endings don't count; any other change does, comments and whitespace
//! included — deliberately simple):
//!
//! - every `.rs` under `src/` but test files (`tests.rs`, `*_tests.rs`, a
//!   `tests/` dir: they don't ship), and the `Cargo.toml` of each workspace
//!   crate the server links ([`CRATES`]), path included;
//! - the `[profile.release]` and `[profile.server]` keys of the root manifest
//!   (comments and blank lines dropped): `panic` and `opt-level` change the
//!   binary as much as code does;
//! - the root manifest's `[workspace.dependencies]` entries those crates
//!   inherit (a feature added there is not in `Cargo.lock`), and its
//!   `[workspace.package]` keys but `version`;
//! - each registry package reachable from `santree-server` in `Cargo.lock`:
//!   name, version, source and checksum. Workspace packages are reached
//!   through their manifests' non-optional normal and build dependencies, so
//!   no dev-dependency and no off-by-default feature (agent-kind's specta)
//!   counts; they contribute their name alone, since their version is the
//!   workspace's and moves with every app release.
//!
//! A revision no release has shipped yet can take more changes without a
//! bump: set `revision` in `revision.lock` one below `REVISION` and run the
//! update (`UPDATE_REVISION_LOCK=1 cargo test -p santree-server revision`).
//! Once a release carries revision N, its code is N for good — bump instead.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use santree_server::REVISION;

/// The workspace crates in the server binary, by package name.
const CRATES: &[(&str, &str)] = &[
    ("santree-server", "crates/server"),
    ("santree-host", "crates/host"),
    ("santree-pty", "crates/pty"),
    ("santree-remote-proto", "crates/remote-proto"),
    ("santree-agent-kind", "crates/agent-kind"),
];

const UPDATE_ENV: &str = "UPDATE_REVISION_LOCK";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// FNV-1a, 64-bit: stable across Rust releases, which std's `DefaultHasher`
/// is not promised to be.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    /// Length-prefixed, so two fields can't run into each other.
    fn field(&mut self, bytes: &[u8]) {
        self.bytes(&(bytes.len() as u64).to_le_bytes());
        self.bytes(bytes);
    }
}

fn read(path: &Path) -> Vec<u8> {
    let raw = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut out = Vec::with_capacity(raw.len());
    for (i, b) in raw.iter().enumerate() {
        if *b == b'\r' && raw.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if path.is_dir() {
            if name != "tests" {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
            out.push(path);
        }
    }
}

/// `[profile.release]` and `[profile.server]`, as key lines.
fn profiles(manifest: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[profile.release]" || line == "[profile.server]";
            if inside {
                out.push_str(line);
                out.push('\n');
            }
        } else if inside && !line.is_empty() && !line.starts_with('#') {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// What the server's crates take from the root manifest: the
/// `[workspace.dependencies]` entries they name (with the features set
/// there) and `[workspace.package]` without `version`, which moves with
/// every app release and is not in the binary's behaviour.
fn inherited(root: &Path, manifest: &str) -> String {
    let manifest: toml::Table = manifest.parse().expect("Cargo.toml parses");
    let workspace = manifest["workspace"].as_table().unwrap();
    let mut names = BTreeSet::new();
    for (_, dir) in CRATES {
        let own: toml::Table = String::from_utf8(read(&root.join(dir).join("Cargo.toml")))
            .unwrap()
            .parse()
            .unwrap();
        names.extend(linked_deps(&own));
    }
    let mut out = String::new();
    if let Some(deps) = workspace.get("dependencies").and_then(|d| d.as_table()) {
        for name in &names {
            if let Some(spec) = deps.get(name) {
                out.push_str(&format!("{name} = {spec}\n"));
            }
        }
    }
    if let Some(package) = workspace.get("package").and_then(|p| p.as_table()) {
        for (key, value) in package.iter().filter(|(k, _)| *k != "version") {
            out.push_str(&format!("package.{key} = {value}\n"));
        }
    }
    out
}

/// A workspace manifest's non-optional normal and build dependencies, by
/// package name.
fn linked_deps(manifest: &toml::Table) -> BTreeSet<String> {
    let mut tables: Vec<&toml::Table> = Vec::new();
    for key in ["dependencies", "build-dependencies"] {
        if let Some(t) = manifest.get(key).and_then(|v| v.as_table()) {
            tables.push(t);
        }
    }
    if let Some(targets) = manifest.get("target").and_then(|v| v.as_table()) {
        for target in targets.values().filter_map(|v| v.as_table()) {
            for key in ["dependencies", "build-dependencies"] {
                if let Some(t) = target.get(key).and_then(|v| v.as_table()) {
                    tables.push(t);
                }
            }
        }
    }
    let mut out = BTreeSet::new();
    for table in tables {
        for (name, spec) in table {
            let spec = spec.as_table();
            if spec
                .and_then(|s| s.get("optional"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                continue;
            }
            let package = spec
                .and_then(|s| s.get("package"))
                .and_then(|v| v.as_str())
                .unwrap_or(name);
            out.insert(package.to_string());
        }
    }
    out
}

struct LockPackage {
    name: String,
    version: String,
    source: Option<String>,
    checksum: Option<String>,
    deps: Vec<String>,
}

fn lock_packages(lock: &str) -> Vec<LockPackage> {
    let lock: toml::Table = lock.parse().expect("Cargo.lock parses");
    let str_of = |t: &toml::Table, k: &str| t.get(k).and_then(|v| v.as_str()).map(String::from);
    lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let p = p.as_table().unwrap();
            LockPackage {
                name: str_of(p, "name").unwrap(),
                version: str_of(p, "version").unwrap(),
                source: str_of(p, "source"),
                checksum: str_of(p, "checksum"),
                deps: p
                    .get("dependencies")
                    .and_then(|d| d.as_array())
                    .map(|d| d.iter().map(|v| v.as_str().unwrap().to_string()).collect())
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// The package a lock `dependencies` entry names: `name`, `name version` or
/// `name version (source)`.
fn resolve<'a>(packages: &'a [LockPackage], entry: &str) -> &'a LockPackage {
    let mut parts = entry.split_whitespace();
    let name = parts.next().unwrap();
    let version = parts.next();
    let found: Vec<&LockPackage> = packages
        .iter()
        .filter(|p| p.name == name && version.is_none_or(|v| p.version == v))
        .collect();
    assert_eq!(found.len(), 1, "Cargo.lock: can't resolve {entry:?}");
    found[0]
}

/// The registry packages the server links, and the workspace ones it reached.
fn reachable(root: &Path) -> (Vec<String>, BTreeSet<String>) {
    let packages = lock_packages(&String::from_utf8(read(&root.join("Cargo.lock"))).unwrap());
    let dirs: BTreeMap<&str, &str> = CRATES.iter().copied().collect();
    let mut seen = BTreeSet::new();
    let mut workspace = BTreeSet::new();
    let mut registry = BTreeSet::new();
    let mut todo = vec![resolve(&packages, "santree-server")];
    while let Some(p) = todo.pop() {
        if !seen.insert((p.name.clone(), p.version.clone())) {
            continue;
        }
        let follow: Vec<&String> = if p.source.is_none() {
            workspace.insert(p.name.clone());
            let dir = dirs.get(p.name.as_str()).unwrap_or_else(|| {
                panic!(
                    "the server now links the workspace crate {}: add it to CRATES in {}",
                    p.name,
                    file!()
                )
            });
            let manifest: toml::Table = String::from_utf8(read(&root.join(dir).join("Cargo.toml")))
                .unwrap()
                .parse()
                .unwrap();
            let linked = linked_deps(&manifest);
            p.deps
                .iter()
                .filter(|d| linked.contains(d.split_whitespace().next().unwrap()))
                .collect()
        } else {
            registry.insert(format!(
                "{} {} {} {}",
                p.name,
                p.version,
                p.source.as_deref().unwrap_or(""),
                p.checksum.as_deref().unwrap_or("")
            ));
            p.deps.iter().collect()
        };
        todo.extend(follow.into_iter().map(|d| resolve(&packages, d)));
    }
    (registry.into_iter().collect(), workspace)
}

fn current_hash() -> String {
    let root = root();
    let mut h = Fnv::new();
    let mut files = Vec::new();
    for (_, dir) in CRATES {
        files.push(root.join(dir).join("Cargo.toml"));
        rust_files(&root.join(dir).join("src"), &mut files);
    }
    let mut files: Vec<(String, PathBuf)> = files
        .into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            (rel, p)
        })
        .collect();
    files.sort();
    for (rel, path) in &files {
        h.field(rel.as_bytes());
        h.field(&read(path));
    }
    let manifest = String::from_utf8(read(&root.join("Cargo.toml"))).unwrap();
    h.field(profiles(&manifest).as_bytes());
    h.field(inherited(&root, &manifest).as_bytes());
    let (registry, workspace) = reachable(&root);
    let expected: BTreeSet<String> = CRATES.iter().map(|(n, _)| n.to_string()).collect();
    assert_eq!(
        workspace, expected,
        "CRATES lists a crate the server no longer links; drop it"
    );
    for package in &registry {
        h.field(package.as_bytes());
    }
    format!("{:016x}", h.0)
}

fn parse_lock(text: &str) -> (u32, String) {
    let table: toml::Table = text.parse().expect("revision.lock parses");
    let revision = table["revision"].as_integer().expect("revision = N") as u32;
    let hash = table["hash"].as_str().expect("hash = \"…\"").to_string();
    (revision, hash)
}

#[test]
fn revision_lock_matches_the_server_sources() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("revision.lock");
    let (locked, locked_hash) = parse_lock(&fs::read_to_string(&path).unwrap());
    let hash = current_hash();
    let update = std::env::var(UPDATE_ENV).is_ok_and(|v| v == "1");
    let how = "UPDATE_REVISION_LOCK=1 cargo test -p santree-server revision";

    assert!(
        REVISION >= locked,
        "REVISION ({REVISION}) is below revision.lock's ({locked}); a revision never goes back"
    );
    if REVISION == locked {
        assert_eq!(
            hash,
            locked_hash,
            "the santree server's code or dependencies changed since revision {locked}. \
             Bump `REVISION` in crates/server/src/lib.rs to {} and run `{how}` — or, if no \
             release has shipped revision {locked} yet, set revision.lock's `revision` to {} \
             and run `{how}`.",
            locked + 1,
            locked.saturating_sub(1)
        );
        return;
    }
    // REVISION was bumped.
    assert!(
        update,
        "REVISION is {REVISION} but revision.lock records {locked}: run `{how}`"
    );
    fs::write(
        &path,
        format!(
            "# Written by `{how}` (tests/revision.rs). Never edit by hand.\n\
             revision = {REVISION}\nhash = \"{hash}\"\n"
        ),
    )
    .unwrap();
}

#[test]
fn fnv1a_matches_its_reference_values() {
    let hash = |s: &str| {
        let mut h = Fnv::new();
        h.bytes(s.as_bytes());
        h.0
    };
    assert_eq!(hash(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(hash("a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(hash("foobar"), 0x8594_4171_f739_67e8);
}
