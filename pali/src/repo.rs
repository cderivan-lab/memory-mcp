use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use git2::{ErrorCode, MergeOptions, Repository, Signature, build::CheckoutBuilder};
use tracing::{info, warn};

use crate::{
    error::MemoryError,
    health::SubsystemReporter,
    spawn::traced_spawn_blocking,
    types::{Memory, MemoryMetadata, MemoryName, MemoryRef, Scope},
};

/// Strip userinfo (credentials) from a URL before logging.
///
/// `https://user:token@host/path` → `https://[REDACTED]@host/path`
pub(crate) fn redact_url(url: &str) -> String {
    let (prefix, after_at) = match url.split_once('@') {
        Some(pair) => pair,
        None => return url.to_string(),
    };
    let scheme_end = match prefix.find("://") {
        Some(pos) => pos,
        None => return url.to_string(),
    };
    let (scheme, _) = prefix.split_at(scheme_end + 3);
    format!("{}[REDACTED]@{}", scheme, after_at)
}

/// Return the current HEAD commit OID as a 20-byte array.
///
/// Returns `[0u8; 20]` as a sentinel when the branch is unborn (no commits yet).
fn capture_head_oid(repo: &git2::Repository) -> Result<[u8; 20], MemoryError> {
    match repo.head() {
        Ok(h) => {
            let oid = h.peel_to_commit()?.id();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(oid.as_bytes());
            Ok(buf)
        }
        // Unborn branch — use zero OID as sentinel.
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
            Ok([0u8; 20])
        }
        Err(e) => Err(MemoryError::Git(e)),
    }
}

/// Perform a fast-forward of `fetch_commit` into `branch`.
///
/// Captures the old HEAD OID (zero sentinel if unborn), advances the branch
/// ref, sets HEAD, and force-checks out the new tree.
fn fast_forward(
    repo: &git2::Repository,
    fetch_commit: &git2::AnnotatedCommit,
    branch: &str,
) -> Result<PullResult, MemoryError> {
    let old_head = capture_head_oid(repo)?;

    let refname = format!("refs/heads/{branch}");
    let target_oid = fetch_commit.id();

    match repo.find_reference(&refname) {
        Ok(mut reference) => {
            reference.set_target(target_oid, &format!("pull: fast-forward to {}", target_oid))?;
        }
        Err(e) if e.code() == ErrorCode::NotFound => {
            // Branch doesn't exist locally yet — create it.
            repo.reference(
                &refname,
                target_oid,
                true,
                &format!("pull: create branch {} from fetch", branch),
            )?;
        }
        Err(e) => {
            return Err(MemoryError::Git(e));
        }
    }

    repo.set_head(&refname)?;
    let mut checkout = CheckoutBuilder::default();
    checkout.force();
    repo.checkout_head(Some(&mut checkout))?;

    let mut new_head = [0u8; 20];
    new_head.copy_from_slice(target_oid.as_bytes());

    info!("pull: fast-forwarded to {}", target_oid);
    Ok(PullResult::FastForward { old_head, new_head })
}

/// Whether a remote URL uses the SSH transport.
///
/// Covers both the explicit `ssh://[user@]host[:port]/path` form and the
/// scp-like `[user@]host:path` form git treats as SSH.
fn is_ssh_remote(url: &str) -> bool {
    if let Some((scheme, _)) = url.split_once("://") {
        return scheme.eq_ignore_ascii_case("ssh") || scheme.eq_ignore_ascii_case("git+ssh");
    }
    // scp-like syntax has no scheme: a non-empty host with no `/` followed by
    // a `:` and a path.
    url.split_once(':')
        .is_some_and(|(host, path)| !host.is_empty() && !host.contains('/') && !path.is_empty())
}

/// Default private keys, in the order OpenSSH tries them.
const DEFAULT_SSH_KEYS: &[&str] = &[".ssh/id_ed25519", ".ssh/id_ecdsa", ".ssh/id_rsa"];

/// First existing default SSH private key, if any.
fn default_ssh_key() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    DEFAULT_SSH_KEYS
        .iter()
        .map(|relative| home.join(relative))
        .find(|path| path.is_file())
}

/// Choose an SSH credential for one authentication attempt.
///
/// libgit2 calls the credential callback again after a rejected attempt, so
/// the first attempt uses a default key file and later attempts fall back to
/// the ssh-agent. That keeps unencrypted keys working without an agent while
/// still supporting passphrase-protected keys the agent has unlocked.
///
/// The key is never read here: `Cred::ssh_key` hands libgit2 the path.
fn ssh_credentials(
    username: Option<&str>,
    allowed: git2::CredentialType,
    attempt: usize,
) -> Result<git2::Cred, git2::Error> {
    let user = username.filter(|name| !name.is_empty()).unwrap_or("git");

    if allowed.contains(git2::CredentialType::USERNAME) {
        return git2::Cred::username(user);
    }
    if !allowed.contains(git2::CredentialType::SSH_KEY) {
        return Err(git2::Error::from_str(
            "ssh remote does not accept key authentication",
        ));
    }

    if attempt == 0
        && let Some(key) = default_ssh_key()
    {
        return git2::Cred::ssh_key(user, None, &key, None);
    }
    if std::env::var_os("SSH_AUTH_SOCK").is_some() {
        return git2::Cred::ssh_key_from_agent(user);
    }

    Err(git2::Error::from_str(
        "no ssh credential available: start ssh-agent (SSH_AUTH_SOCK) or create ~/.ssh/id_ed25519",
    ))
}

/// Normalise a token read from the environment.
///
/// A blank or whitespace-only value (an unset variable in a compose file, a
/// cleared extension setting) must behave exactly like an unset one, so a
/// stray `PALI_GIT_TOKEN=` never turns into an authentication attempt with an
/// empty password.
fn normalize_git_token(value: Option<String>) -> Option<String> {
    value
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

/// Token for HTTPS remotes, read from `PALI_GIT_TOKEN` at connect time.
///
/// Held only for the duration of the credential callback: Pali never writes it
/// to the repository config, logs, spans, or the MCP wire. Callers that need
/// token auth without a credential helper set this variable on the process.
fn git_token() -> Option<String> {
    normalize_git_token(std::env::var("PALI_GIT_TOKEN").ok())
}

/// HTTPS credential for one authentication attempt.
///
/// The username comes from the remote URL when the operator supplied one
/// (`https://oauth2@gitlab.com/...`); otherwise GitHub's `x-access-token`
/// convention is used, which GitHub accepts for personal access tokens.
/// Without a token the attempt falls through to libgit2's default credential
/// acquisition (configured helpers and `~/.netrc`).
fn https_credentials(
    username: Option<&str>,
    token: Option<String>,
) -> Result<git2::Cred, git2::Error> {
    match token {
        Some(token) => {
            let user = username
                .filter(|name| !name.is_empty())
                .unwrap_or("x-access-token");
            git2::Cred::userpass_plaintext(user, &token)
        }
        _none => git2::Cred::default(),
    }
}

/// Build `RemoteCallbacks` for a remote operation.
///
/// HTTPS remotes use `PALI_GIT_TOKEN` when it is set, and otherwise libgit2's
/// default credential acquisition, which reads the configured credential
/// helpers and `~/.netrc`. SSH remotes get an explicit key-or-agent attempt so
/// `~/.ssh` keys work without a running agent.
fn build_auth_callbacks() -> git2::RemoteCallbacks<'static> {
    let mut callbacks = git2::RemoteCallbacks::new();
    let mut ssh_attempt = 0usize;
    callbacks.credentials(move |url, username, allowed| {
        if is_ssh_remote(url) {
            let attempt = ssh_attempt;
            ssh_attempt += 1;
            return ssh_credentials(username, allowed, attempt);
        }
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            return https_credentials(username, git_token());
        }
        git2::Cred::default()
    });
    callbacks
}

/// The outcome of a `pull()` operation.
#[derive(Debug)]
#[non_exhaustive]
pub enum PullResult {
    /// No `origin` remote is configured — running in local-only mode.
    NoRemote,
    /// The local branch was already up to date with the remote.
    UpToDate,
    /// The remote was ahead and the branch was fast-forwarded.
    FastForward {
        /// Commit OID before the fast-forward.
        old_head: [u8; 20],
        /// Commit OID after the fast-forward.
        new_head: [u8; 20],
    },
    /// A merge was performed; `conflicts_resolved` counts auto-resolved files.
    Merged {
        /// Number of conflicting files that were auto-resolved.
        conflicts_resolved: usize,
        /// Commit OID before the merge.
        old_head: [u8; 20],
        /// Commit OID after the merge.
        new_head: [u8; 20],
    },
}

/// Memories that changed between two git commits.
///
/// This is the crate's public change-set surface: repository-path strings
/// (without the `.md` suffix, e.g. `"global/foo"`, `"projects/a/b/mem"`) for
/// added/modified and deleted memories, derived straight from the git deltas. It is produced by
/// [`MemoryRepo::diff_changed_memories`], which reports every
/// changed `.md` file — including ones whose blob is non-UTF-8 or has
/// unparseable frontmatter — because a path is available even when the content
/// cannot be resolved to a memory.
///
/// Internally the index-mirror path does NOT consume these strings: it uses the
/// richer crate-internal `ResolvedChanges` (structured [`MemoryRef`]s
/// plus an `unresolved` count, produced by
/// `MemoryRepo::diff_changed_refs`) so hierarchical scopes are resolved from
/// frontmatter rather than by splitting a path back into scope + name, which is
/// ambiguous (`projects/a/b/mem.md` could be scope `a/b`, name `mem` or scope
/// `a`, name `b/mem`).
#[derive(Debug, Default)]
pub struct ChangedMemories {
    /// Repository-path qualified names without the `.md` suffix (e.g.
    /// `"global/foo"`) that were added or modified.
    pub upserted: Vec<String>,
    /// Repository-path qualified names (e.g. `"global/foo"`) that were deleted.
    pub removed: Vec<String>,
}

impl ChangedMemories {
    /// Returns `true` if there are no changes.
    pub fn is_empty(&self) -> bool {
        self.upserted.is_empty() && self.removed.is_empty()
    }
}

/// Changed memories resolved to structured references, for the index mirror.
///
/// Every changed file is resolved to a [`MemoryRef`] by parsing the
/// blob's YAML frontmatter (the new tree for upserts, the old tree for
/// removals) — the same authority `list_memories` uses to build the canonical
/// index keys, so hierarchical scope paths are never split ambiguously
/// (`projects/a/b/mem.md` is unambiguously scope `a/b`, name `mem`, not scope
/// `a`, name `b/mem`). Files that cannot be resolved (unparseable frontmatter,
/// non-UTF-8 content, or a non-memory object such as a symlink) are counted in
/// `unresolved` so callers degrade derived indexes instead of committing a
/// silently reduced change set.
///
/// Crate-internal on purpose: it carries the structured `scope`/`name` the
/// mirror needs; the public [`ChangedMemories`] surface stays the stable
/// repository-path contract.
#[derive(Debug, Default)]
pub(crate) struct ResolvedChanges {
    /// Memories that were added or modified (resolved from the new tree).
    pub(crate) upserted: Vec<MemoryRef>,
    /// Memories that were deleted (resolved from the old tree).
    pub(crate) removed: Vec<MemoryRef>,
    /// Changed memory files whose reference could not be resolved. Any
    /// non-zero value means the change set is incomplete: derived indexes
    /// must be marked for rebuild rather than treated as fully mirrored.
    pub(crate) unresolved: usize,
}

impl ResolvedChanges {
    /// Returns `true` if there are no resolved changes to apply.
    ///
    /// Deliberately ignores `unresolved` — callers must check that field
    /// separately, because an all-unresolved change set still requires the
    /// derived indexes to be degraded and repaired.
    pub(crate) fn is_empty(&self) -> bool {
        self.upserted.is_empty() && self.removed.is_empty()
    }
}

/// Git-backed repository for persisting and syncing memory files.
pub struct MemoryRepo {
    inner: Mutex<Repository>,
    root: PathBuf,
    reporter: SubsystemReporter,
    sync_reporter: SubsystemReporter,
}

// SAFETY: Repository holds raw pointers but is documented as safe to send
// across threads when not used concurrently. We guarantee exclusive access via
// the Mutex, so MemoryRepo is Send + Sync.
unsafe impl Send for MemoryRepo {}
unsafe impl Sync for MemoryRepo {}

/// How a tracked path differs between two commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    /// The path exists only in the newer tree.
    Added,
    /// The path exists only in the older tree.
    Removed,
    /// The path exists in both trees with the same object kind, different content.
    Modified,
    /// The path kept its name but changed object kind, e.g. a regular file
    /// became a symlink. Reported as an old-side removal plus a new-side
    /// upsert, mirroring what a delete and an add would produce.
    TypeChanged,
}

/// One changed memory file between two commits.
struct TreeChange {
    /// Repository-relative path, e.g. `global/notes/foo.md`.
    path: String,
    /// What happened to the path.
    kind: ChangeKind,
    /// Blob content on the older side, when the path was a blob there.
    old_blob: Option<Vec<u8>>,
    /// Blob content on the newer side, when the path is a blob there.
    new_blob: Option<Vec<u8>>,
}

/// Compare the trees of two commits and return the memory files that changed.
///
/// `old_oid` may be `[0u8; 20]` for an unborn branch, in which case every file
/// in the newer tree is reported as added. Only `.md` files under `global/` or
/// `projects/` are returned: those are the namespace directories the memory
/// store owns. Blob content is read eagerly for the returned files, since a
/// memory store's diff touches a handful of small markdown files and callers
/// that parse frontmatter would otherwise reopen the repository per file.
fn changed_files(
    root: &Path,
    old_oid: [u8; 20],
    new_oid: [u8; 20],
) -> Result<Vec<TreeChange>, MemoryError> {
    let repo = git2::Repository::open(root)?;
    let new_tree = commit_tree(&repo, new_oid)?;
    let old_tree = if old_oid == [0u8; 20] {
        None
    } else {
        Some(commit_tree(&repo, old_oid)?)
    };

    let mut changes = Vec::new();
    diff_trees(&repo, old_tree.as_ref(), Some(&new_tree), "", &mut changes)?;
    Ok(changes)
}

fn commit_tree<'repo>(
    repo: &'repo git2::Repository,
    oid: [u8; 20],
) -> Result<git2::Tree<'repo>, MemoryError> {
    let id = git2::Oid::from_bytes(&oid)?;
    Ok(repo.find_object(id, None)?.peel_to_tree()?)
}

/// A tree's entries keyed by file name, so both sides diff in one pass.
fn tree_entries(tree: &git2::Tree) -> Result<BTreeMap<String, (i32, git2::Oid)>, MemoryError> {
    let mut map = BTreeMap::new();
    for entry in tree.iter() {
        map.insert(entry.name()?.to_string(), (entry.filemode(), entry.id()));
    }
    Ok(map)
}

fn diff_trees(
    repo: &git2::Repository,
    old: Option<&git2::Tree>,
    new: Option<&git2::Tree>,
    prefix: &str,
    out: &mut Vec<TreeChange>,
) -> Result<(), MemoryError> {
    let old_entries = old.map(tree_entries).transpose()?;
    let new_entries = new.map(tree_entries).transpose()?;
    let empty = BTreeMap::new();
    let old_entries = old_entries.as_ref().unwrap_or(&empty);
    let new_entries = new_entries.as_ref().unwrap_or(&empty);

    for (name, (new_mode, new_id)) in new_entries {
        let path = join_path(prefix, name);
        match old_entries.get(name) {
            None => collect_side(repo, *new_mode, *new_id, &path, ChangeKind::Added, out)?,
            Some((old_mode, old_id)) => {
                if old_id == new_id && old_mode == new_mode {
                    continue;
                }
                match (is_tree_mode(*old_mode), is_tree_mode(*new_mode)) {
                    (true, true) => {
                        let old_tree = repo.find_object(*old_id, None)?.peel_to_tree()?;
                        let new_tree = repo.find_object(*new_id, None)?.peel_to_tree()?;
                        diff_trees(repo, Some(&old_tree), Some(&new_tree), &path, out)?;
                    }
                    (false, false) => {
                        // A mode change between blob kinds (regular file,
                        // symlink, submodule) is a type change, not an edit:
                        // the old object must leave the index and the new one
                        // is only upserted if it resolves to a memory.
                        let kind = if same_blob_kind(*old_mode, *new_mode) {
                            ChangeKind::Modified
                        } else {
                            ChangeKind::TypeChanged
                        };
                        if let Some(change) =
                            memory_change(repo, &path, kind, Some(*old_id), Some(*new_id))?
                        {
                            out.push(change);
                        }
                    }
                    // A directory replaced by a file, or the reverse: git
                    // models this as a deletion and an addition, so emit the
                    // whole subtree on the side that had one.
                    (true, false) | (false, true) => {
                        collect_side(repo, *old_mode, *old_id, &path, ChangeKind::Removed, out)?;
                        collect_side(repo, *new_mode, *new_id, &path, ChangeKind::Added, out)?;
                    }
                }
            }
        }
    }

    for (name, (old_mode, old_id)) in old_entries {
        if new_entries.contains_key(name) {
            continue;
        }
        let path = join_path(prefix, name);
        collect_side(repo, *old_mode, *old_id, &path, ChangeKind::Removed, out)?;
    }

    Ok(())
}

fn is_tree_mode(mode: i32) -> bool {
    mode == 0o040000
}

/// Whether two non-tree entries are the same git object kind.
///
/// `100644` and `100755` are both regular files — an executable bit change is
/// an edit, not a type change — while `120000` (symlink) and `160000`
/// (submodule) are different kinds.
fn same_blob_kind(old: i32, new: i32) -> bool {
    let blob = |mode: i32| mode == 0o100644 || mode == 0o100755;
    (blob(old) && blob(new)) || old == new
}

/// Join a tree path prefix and an entry name.
///
/// Tree entries carry only their own name, so the walk rebuilds the
/// repository-relative path as it descends; the root contributes no separator.
fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Emit one change per file under a subtree that exists on only one side.
fn collect_side(
    repo: &git2::Repository,
    mode: i32,
    id: git2::Oid,
    path: &str,
    kind: ChangeKind,
    out: &mut Vec<TreeChange>,
) -> Result<(), MemoryError> {
    if is_tree_mode(mode) {
        let tree = repo.find_object(id, None)?.peel_to_tree()?;
        for entry in tree.iter() {
            let child = join_path(path, entry.name()?);
            collect_side(repo, entry.filemode(), entry.id(), &child, kind, out)?;
        }
        return Ok(());
    }

    let (old_id, new_id) = match kind {
        ChangeKind::Removed => (Some(id), None),
        _ => (None, Some(id)),
    };
    if let Some(change) = memory_change(repo, path, kind, old_id, new_id)? {
        out.push(change);
    }
    Ok(())
}

/// Build a [`TreeChange`] for a path the memory store owns, loading its blob.
fn memory_change(
    repo: &git2::Repository,
    path: &str,
    kind: ChangeKind,
    old_id: Option<git2::Oid>,
    new_id: Option<git2::Oid>,
) -> Result<Option<TreeChange>, MemoryError> {
    if !is_memory_path(path) {
        return Ok(None);
    }
    let old_blob = old_id
        .map(|id| object_content(repo, id))
        .transpose()?
        .flatten();
    let new_blob = new_id
        .map(|id| object_content(repo, id))
        .transpose()?
        .flatten();
    Ok(Some(TreeChange {
        path: path.to_string(),
        kind,
        old_blob,
        new_blob,
    }))
}

fn object_content(repo: &git2::Repository, id: git2::Oid) -> Result<Option<Vec<u8>>, MemoryError> {
    let object = repo.find_object(id, None)?;
    // Symlinks are stored as blobs carrying the target path; a gitlink
    // (submodule) under a memory path is reported by its recorded oid; any
    // other object kind carries no content.
    Ok(match object.kind() {
        Some(git2::ObjectType::Blob) => object.as_blob().map(|blob| blob.content().to_vec()),
        Some(git2::ObjectType::Commit) => Some(object.id().to_string().into_bytes()),
        _ => None,
    })
}

/// True for `.md` files inside the namespace directories the store owns.
fn is_memory_path(path: &str) -> bool {
    path.ends_with(".md")
        && (path.starts_with(Scope::ROOT_PREFIX) || path.starts_with(Scope::PROJECTS_PREFIX))
}

impl MemoryRepo {
    /// Open an existing git repo at `path`, or initialise a new one.
    ///
    /// If `remote_url` is provided, ensures an `origin` remote exists pointing
    /// at that URL (creating or updating it as necessary).
    ///
    /// `reporter` receives `report_ok`/`report_err` after local git operations,
    /// recording the repository's operational state passively.
    pub fn init_or_open(path: &Path, remote_url: Option<&str>) -> Result<Self, MemoryError> {
        Self::init_or_open_with_reporter(
            path,
            remote_url,
            SubsystemReporter::new(),
            SubsystemReporter::new(),
        )
    }

    /// Open or initialise a git repo with specific health reporters.
    ///
    /// `reporter` tracks local git operations; `sync_reporter` tracks push/pull.
    pub fn init_or_open_with_reporter(
        path: &Path,
        remote_url: Option<&str>,
        reporter: SubsystemReporter,
        sync_reporter: SubsystemReporter,
    ) -> Result<Self, MemoryError> {
        let _span = tracing::info_span!("repo.init").entered();

        let repo = if path.join(".git").exists() {
            Repository::open(path)?
        } else {
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head("main");
            let repo = Repository::init_opts(path, &opts)?;
            // Write a .gitignore so the vector index is never committed.
            let gitignore = path.join(".gitignore");
            if !gitignore.exists() {
                std::fs::write(&gitignore, ".memory-mcp-index/\n")?;
            }
            {
                let mut index = repo.index()?;
                index.add_path(Path::new(".gitignore"))?;
                index.write()?;
                let tree_oid = index.write_tree()?;
                let tree = repo.find_tree(tree_oid)?;
                let sig = Signature::now("memory-mcp", "memory-mcp@local")?;
                repo.commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "chore: init repository",
                    &tree,
                    &[],
                )?;
            }
            repo
        };

        if let Some(url) = remote_url {
            match repo.find_remote("origin") {
                Ok(existing) => {
                    let current_url = existing.url().unwrap_or("");
                    if current_url != url {
                        repo.remote_set_url("origin", url)?;
                        info!("updated origin remote URL to {}", redact_url(url));
                    }
                }
                Err(e) if e.code() == ErrorCode::NotFound => {
                    repo.remote("origin", url)?;
                    info!("created origin remote pointing at {}", redact_url(url));
                }
                Err(e) => {
                    return Err(MemoryError::Git(e));
                }
            }
        }

        Ok(Self {
            inner: Mutex::new(repo),
            root: path.to_path_buf(),
            reporter,
            sync_reporter,
        })
    }

    /// Root directory of the working tree.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Return the current HEAD commit SHA as a hex string, or `None` if the
    /// branch is unborn (no commits yet).
    pub async fn head_sha(self: &Arc<Self>) -> Option<String> {
        let root = self.root.clone();
        // A read: it neither blocks on nor contends with the writer's mutex.
        // Every failure is reported as `None`, treating a missing HEAD as
        // "no commit yet" rather than an operational fault.
        traced_spawn_blocking(move || -> Option<String> {
            let repo = git2::Repository::open(&root).ok()?;
            let commit = repo.head().ok()?.peel_to_commit().ok()?;
            Some(commit.id().to_string())
        })
        .await
        .ok()?
    }

    /// Absolute path for a memory's markdown file inside the repo.
    fn memory_path(&self, name: &str, scope: &Scope) -> PathBuf {
        self.root
            .join(scope.dir_prefix().as_ref())
            .join(format!("{}.md", name))
    }

    /// Write the memory file to disk, then `git add` + `git commit`.
    ///
    /// All blocking work (mutex lock + fs ops + git2 ops) is performed inside
    /// `tokio::task::spawn_blocking` so the async executor is not stalled.
    pub async fn save_memory(self: &Arc<Self>, memory: &Memory) -> Result<(), MemoryError> {
        let file_path = self.memory_path(&memory.name, &memory.metadata.scope);

        let arc = Arc::clone(self);
        let memory = memory.clone();
        let name = memory.name.clone();

        let span = tracing::info_span!("repo.save", name = %name, oid = tracing::field::Empty);

        let result = traced_spawn_blocking(move || -> Result<(), MemoryError> {
            let _enter = span.entered();
            let repo = arc
                .inner
                .lock()
                .expect("lock poisoned — prior panic corrupted state");

            arc.assert_within_root(&file_path)?;

            if let Some(parent) = file_path.parent() {
                #[allow(clippy::disallowed_methods)]
                std::fs::create_dir_all(parent)?;
            }

            let markdown = memory.to_markdown()?;
            arc.write_memory_file(&file_path, markdown.as_bytes())?;

            let mut index = arc.index_from_head(&repo)?;
            arc.stage_add(&mut index, &file_path)?;
            let oid = arc.commit_index(
                &repo,
                &mut index,
                &format!("chore: save memory '{}'", memory.name),
            )?;

            tracing::Span::current().record("oid", oid.to_string().as_str());
            info!(oid = %oid, "memory saved to repo");

            Ok(())
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.reporter.report_ok(),
            Err(_) => self.reporter.report_err("save_memory failed"),
        }
        result
    }

    /// Remove a memory's file and commit the deletion.
    pub async fn delete_memory(
        self: &Arc<Self>,
        name: &str,
        scope: &Scope,
    ) -> Result<(), MemoryError> {
        let file_path = self.memory_path(name, scope);

        let arc = Arc::clone(self);
        let name = name.to_string();
        let file_path_clone = file_path.clone();
        let span = tracing::info_span!("repo.delete", name = %name, oid = tracing::field::Empty);
        let result = traced_spawn_blocking(move || -> Result<(), MemoryError> {
            let _enter = span.entered();
            let repo = arc
                .inner
                .lock()
                .expect("lock poisoned — prior panic corrupted state");

            arc.assert_within_root(&file_path_clone)?;

            Self::assert_exists_no_symlink(&file_path_clone, &name)?;

            #[allow(clippy::disallowed_methods)]
            std::fs::remove_file(&file_path_clone)?;

            let mut index = arc.index_from_head(&repo)?;
            arc.stage_remove(&mut index, &file_path_clone)?;
            let oid = arc.commit_index(
                &repo,
                &mut index,
                &format!("chore: delete memory '{}'", name),
            )?;

            tracing::Span::current().record("oid", oid.to_string().as_str());
            info!(oid = %oid, "memory deleted from repo");

            Ok(())
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.reporter.report_ok(),
            Err(_) => self.reporter.report_err("delete_memory failed"),
        }
        result
    }

    /// Move a memory from one scope to another in a single git commit.
    ///
    /// Reads the source, builds a destination [`Memory`] with a new ID and
    /// the given name/scope (preserving content, tags, and source hint),
    /// writes the destination file, removes the source file, stages both
    /// changes, and commits atomically. If any step fails, the working
    /// tree is reset to HEAD via `checkout_head --force` so no dirty or
    /// untracked files are left behind.
    ///
    /// Returns the newly created destination [`Memory`] on success.
    pub async fn move_memory(
        self: &Arc<Self>,
        source_name: &str,
        source_scope: &Scope,
        dest_name: &MemoryName,
        dest_scope: &Scope,
    ) -> Result<Memory, MemoryError> {
        let source_path = self.memory_path(source_name, source_scope);
        let dest_path = self.memory_path(dest_name, dest_scope);

        let arc = Arc::clone(self);
        let source_name = source_name.to_string();
        let dest_name = dest_name.clone();
        let dest_scope = dest_scope.clone();
        let span = tracing::info_span!(
            "repo.move",
            source_name = %source_name,
            dest_name = %dest_name,
            oid = tracing::field::Empty,
        );

        let result = traced_spawn_blocking(move || -> Result<Memory, MemoryError> {
            let _enter = span.entered();
            let repo = arc
                .inner
                .lock()
                .expect("lock poisoned — prior panic corrupted state");

            arc.assert_within_root(&source_path)?;
            arc.assert_within_root(&dest_path)?;

            Self::assert_exists_no_symlink(&source_path, &source_name)?;

            let raw = arc.read_memory_file(&source_path)?;
            let source = Memory::from_markdown(&raw)?;

            let metadata = MemoryMetadata::new(
                dest_scope,
                source.metadata.tags.clone(),
                source.metadata.source.clone(),
            );
            let dest = Memory::from_validated(dest_name, source.content.clone(), metadata);

            // If anything fails after we start modifying the working tree,
            // reset hard to HEAD so we never leave dirty/untracked files.
            let commit_result = (|| -> Result<git2::Oid, MemoryError> {
                if let Some(parent) = dest_path.parent() {
                    #[allow(clippy::disallowed_methods)]
                    std::fs::create_dir_all(parent)?;
                }
                let markdown = dest.to_markdown()?;
                arc.write_memory_file(&dest_path, markdown.as_bytes())?;
                #[allow(clippy::disallowed_methods)]
                std::fs::remove_file(&source_path)?;

                let mut index = arc.index_from_head(&repo)?;
                arc.stage_add(&mut index, &dest_path)?;
                arc.stage_remove(&mut index, &source_path)?;
                arc.commit_index(
                    &repo,
                    &mut index,
                    &format!("chore: move memory '{}' → '{}'", source_name, dest.name),
                )
            })();

            match commit_result {
                Ok(oid) => {
                    tracing::Span::current().record("oid", oid.to_string().as_str());
                    info!(oid = %oid, "memory moved in repo");
                    Ok(dest)
                }
                Err(e) => {
                    // Reset working tree + index to HEAD — restores source,
                    // removes destination, clears staged changes.
                    let mut checkout = git2::build::CheckoutBuilder::default();
                    checkout.force();
                    if let Err(reset_err) = repo.checkout_head(Some(&mut checkout)) {
                        warn!(
                            error = %reset_err,
                            "failed to reset working tree after move failure"
                        );
                    }
                    Err(e)
                }
            }
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.reporter.report_ok(),
            Err(_) => self.reporter.report_err("move_memory failed"),
        }
        result
    }

    /// Read and parse a memory from disk.
    pub async fn read_memory(
        self: &Arc<Self>,
        name: &str,
        scope: &Scope,
    ) -> Result<Memory, MemoryError> {
        let file_path = self.memory_path(name, scope);

        let arc = Arc::clone(self);
        let name = name.to_string();
        let span = tracing::debug_span!("repo.read", name = %name);
        let result = traced_spawn_blocking(move || -> Result<Memory, MemoryError> {
            let _enter = span.entered();
            arc.assert_within_root(&file_path)?;
            Self::assert_exists_no_symlink(&file_path, &name)?;
            let raw = arc.read_memory_file(&file_path)?;
            Memory::from_markdown(&raw)
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.reporter.report_ok(),
            Err(MemoryError::NotFound { .. }) | Err(MemoryError::InvalidInput { .. }) => {
                // Application-level errors — the repo itself is fine.
                self.reporter.report_ok();
            }
            Err(_) => self.reporter.report_err("read_memory failed"),
        }
        result
    }

    /// List all memories, optionally filtered by scope.
    pub async fn list_memories(
        self: &Arc<Self>,
        scope: Option<&Scope>,
    ) -> Result<Vec<Memory>, MemoryError> {
        let root = self.root.clone();
        let scope_clone = scope.cloned();
        let span = tracing::debug_span!("repo.list", file_count = tracing::field::Empty);

        let result = traced_spawn_blocking(
            move || -> Result<Vec<Memory>, MemoryError> {
                let _enter = span.entered();
                let dirs: Vec<PathBuf> = match scope_clone.as_ref() {
                    Some(s) => vec![root.join(s.dir_prefix().as_ref())],
                    None => {
                        // Walk both global/ and projects/* (on-disk namespace directories)
                        let mut dirs = Vec::new();
                        let global = root.join(Scope::ROOT_DIR);
                        if global.exists() {
                            dirs.push(global);
                        }
                        let projects = root.join(Scope::PROJECTS_DIR);
                        if projects.exists() {
                            for entry in std::fs::read_dir(&projects)? {
                                let entry = entry?;
                                if entry.file_type()?.is_dir() {
                                    dirs.push(entry.path());
                                }
                            }
                        }
                        dirs
                    }
                };

                fn collect_md_files(dir: &Path, out: &mut Vec<Memory>) -> Result<(), MemoryError> {
                    if !dir.exists() {
                        return Ok(());
                    }
                    for entry in std::fs::read_dir(dir)? {
                        let entry = entry?;
                        let path = entry.path();
                        let ft = entry.file_type()?;
                        // Skip symlinks entirely to prevent directory traversal.
                        if ft.is_symlink() {
                            warn!(
                                "skipping symlink at {:?} — symlinks are not permitted in the memory store",
                                path
                            );
                            continue;
                        }
                        if ft.is_dir() {
                            collect_md_files(&path, out)?;
                        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                            #[allow(clippy::disallowed_methods)]
                            let raw = std::fs::read_to_string(&path)?;
                            match Memory::from_markdown(&raw) {
                                Ok(m) => out.push(m),
                                Err(e) => {
                                    warn!("skipping {:?}: {}", path, e);
                                }
                            }
                        }
                    }
                    Ok(())
                }

                let mut memories = Vec::new();
                for dir in dirs {
                    collect_md_files(&dir, &mut memories)?;
                }

                tracing::Span::current().record("file_count", memories.len());

                Ok(memories)
            }
        ).await.map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.reporter.report_ok(),
            Err(_) => self.reporter.report_err("list_memories failed"),
        }
        result
    }

    /// Push local commits to `origin/<branch>`.
    ///
    /// If no `origin` remote is configured the call is a no-op (local-only
    /// mode). HTTPS credentials come from `PALI_GIT_TOKEN` when set, otherwise
    /// from git's own configuration.
    pub async fn push(self: &Arc<Self>, branch: &str) -> Result<(), MemoryError> {
        let arc = Arc::clone(self);
        let branch = branch.to_string();
        let span = tracing::debug_span!("repo.push", branch = %branch);

        let result = traced_spawn_blocking(move || -> Result<(), MemoryError> {
            let _enter = span.entered();
            let repo = arc
                .inner
                .lock()
                .expect("lock poisoned — prior panic corrupted state");

            let mut remote = match repo.find_remote("origin") {
                Ok(r) => r,
                Err(e) if e.code() == ErrorCode::NotFound => {
                    warn!("push: no origin remote configured — skipping (local-only mode)");
                    return Ok(());
                }
                Err(e) => {
                    return Err(MemoryError::Git(e));
                }
            };

            let mut callbacks = build_auth_callbacks();

            // git2's Remote::push() does not surface server-side rejections
            // through its return value — they arrive via this callback.
            let rejections: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let rej = Arc::clone(&rejections);
            callbacks.push_update_reference(move |refname, status| {
                if let Some(msg) = status {
                    rej.lock()
                        .expect("rejection lock poisoned")
                        .push(format!("{refname}: {msg}"));
                }
                Ok(())
            });

            let mut push_opts = git2::PushOptions::new();
            push_opts.remote_callbacks(callbacks);

            let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
            if let Err(e) = remote.push(&[&refspec], Some(&mut push_opts)) {
                warn!("push to origin failed at transport level: {e}");
                return Err(MemoryError::Git(e));
            }

            let rejected = rejections.lock().expect("rejection lock poisoned");
            if !rejected.is_empty() {
                return Err(MemoryError::PushRejected(rejected.join("; ")));
            }

            info!("pushed branch '{}' to origin", branch);
            Ok(())
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.sync_reporter.report_ok(),
            Err(_) => self.sync_reporter.report_err("push failed"),
        }
        result
    }

    /// Perform a normal (non-fast-forward) merge of `fetch_commit` into HEAD.
    ///
    /// Resolves any conflicts using recency-based auto-resolution, creates the
    /// merge commit, and cleans up MERGE state.
    fn merge_with_remote(
        &self,
        repo: &git2::Repository,
        fetch_commit: &git2::AnnotatedCommit,
        branch: &str,
    ) -> Result<PullResult, MemoryError> {
        // Capture old HEAD before the merge commit.
        // HEAD must exist here — merge analysis would not reach this path
        // with an unborn branch. Propagate the error if it somehow does.
        let oid = repo.head()?.peel_to_commit()?.id();
        let mut old_head = [0u8; 20];
        old_head.copy_from_slice(oid.as_bytes());

        let mut merge_opts = MergeOptions::new();
        merge_opts.fail_on_conflict(false);
        repo.merge(&[fetch_commit], Some(&mut merge_opts), None)?;

        let mut index = repo.index()?;
        let conflicts_resolved = if index.has_conflicts() {
            self.resolve_conflicts_by_recency(repo, &mut index)?
        } else {
            0
        };

        // Safety check: if any conflicts remain after auto-resolution,
        // clean up the MERGE state and surface a clear error rather than
        // letting write_tree() fail with an opaque message.
        if index.has_conflicts() {
            let _ = repo.cleanup_state();
            return Err(MemoryError::Internal(
                "unresolved conflicts remain after auto-resolution".into(),
            ));
        }

        index.write()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let sig = self.signature(repo)?;

        let head_commit = repo.head()?.peel_to_commit()?;
        let fetch_commit_obj = repo.find_commit(fetch_commit.id())?;

        let new_commit_oid = repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("chore: merge origin/{}", branch),
            &tree,
            &[&head_commit, &fetch_commit_obj],
        )?;

        repo.cleanup_state()?;

        let mut new_head = [0u8; 20];
        new_head.copy_from_slice(new_commit_oid.as_bytes());

        info!(
            "pull: merge complete ({} conflicts auto-resolved)",
            conflicts_resolved
        );
        Ok(PullResult::Merged {
            conflicts_resolved,
            old_head,
            new_head,
        })
    }

    /// Pull from `origin/<branch>` and merge into the current HEAD.
    ///
    /// Uses a recency-based auto-resolution strategy for conflicts: the version
    /// with the more recent `updated_at` frontmatter timestamp wins. If
    /// timestamps are equal or unparseable, the local version is kept.
    pub async fn pull(self: &Arc<Self>, branch: &str) -> Result<PullResult, MemoryError> {
        let arc = Arc::clone(self);
        let branch = branch.to_string();
        let span = tracing::debug_span!("repo.pull", branch = branch.as_str());

        let result = traced_spawn_blocking(move || -> Result<PullResult, MemoryError> {
            let _enter = span.entered();
            let repo = arc
                .inner
                .lock()
                .expect("lock poisoned — prior panic corrupted state");

            let mut remote = match repo.find_remote("origin") {
                Ok(r) => r,
                Err(e) if e.code() == ErrorCode::NotFound => {
                    warn!("pull: no origin remote configured — skipping (local-only mode)");
                    return Ok(PullResult::NoRemote);
                }
                Err(e) => {
                    return Err(MemoryError::Git(e));
                }
            };

            let callbacks = build_auth_callbacks();
            let mut fetch_opts = git2::FetchOptions::new();
            fetch_opts.remote_callbacks(callbacks);
            remote.fetch(&[&branch], Some(&mut fetch_opts), None)?;

            let fetch_head = match repo.find_reference("FETCH_HEAD") {
                Ok(r) => r,
                Err(e) if e.code() == ErrorCode::NotFound => {
                    // Empty remote — nothing to merge.
                    return Ok(PullResult::UpToDate);
                }
                Err(e)
                    if e.class() == git2::ErrorClass::Reference
                        && e.message().contains("corrupted") =>
                {
                    // Empty/corrupted FETCH_HEAD (e.g. remote has no commits yet).
                    info!("pull: FETCH_HEAD is empty or corrupted — treating as empty remote");
                    return Ok(PullResult::UpToDate);
                }
                Err(e) => {
                    return Err(MemoryError::Git(e));
                }
            };
            let fetch_commit = match repo.reference_to_annotated_commit(&fetch_head) {
                Ok(c) => c,
                Err(e) if e.class() == git2::ErrorClass::Reference => {
                    // FETCH_HEAD exists but can't be resolved (empty remote).
                    info!("pull: FETCH_HEAD not resolvable — treating as empty remote");
                    return Ok(PullResult::UpToDate);
                }
                Err(e) => {
                    return Err(MemoryError::Git(e));
                }
            };

            let (analysis, _preference) = repo.merge_analysis(&[&fetch_commit])?;

            if analysis.is_up_to_date() {
                info!("pull: already up to date");
                return Ok(PullResult::UpToDate);
            }

            if analysis.is_fast_forward() {
                return fast_forward(&repo, &fetch_commit, &branch);
            }

            arc.merge_with_remote(&repo, &fetch_commit, &branch)
        })
        .await
        .map_err(|e| MemoryError::Join(e.to_string()))?;

        match &result {
            Ok(_) => self.sync_reporter.report_ok(),
            Err(_) => self.sync_reporter.report_err("pull failed"),
        }
        result
    }

    /// Diff two commits and return the memory files that changed.
    ///
    /// Only `.md` files under `global/` or `projects/` (namespace directories)
    /// are considered. Added, modified and type-changed files go into
    /// `upserted`; deleted and type-changed files go into `removed`. Qualified
    /// names are returned without the `.md` suffix (e.g. `"global/foo"`).
    ///
    /// This is the stable public change-set surface: it derives its strings
    /// straight from the git delta paths and reports **every** changed `.md`
    /// file — including ones whose blob is non-UTF-8 or has unparseable
    /// frontmatter — because a path is always available even when the content
    /// is not. This is deliberately distinct from the crate-internal
    /// `Self::diff_changed_refs`, which resolves each file to a canonical
    /// [`crate::types::MemoryRef`] (and drops/counts the unresolvable ones) for
    /// the complete-or-degraded index mirror; the mirror path uses
    /// `diff_changed_refs`.
    ///
    /// Must be called from within `spawn_blocking` since it reads git objects.
    pub fn diff_changed_memories(
        &self,
        old_oid: [u8; 20],
        new_oid: [u8; 20],
    ) -> Result<ChangedMemories, MemoryError> {
        let mut changes = ChangedMemories::default();
        for change in changed_files(&self.root, old_oid, new_oid)? {
            let Some(qualified) = change.path.strip_suffix(".md").map(str::to_string) else {
                continue;
            };
            match change.kind {
                ChangeKind::Added | ChangeKind::Modified => changes.upserted.push(qualified),
                ChangeKind::Removed => changes.removed.push(qualified),
                ChangeKind::TypeChanged => {
                    changes.removed.push(qualified.clone());
                    changes.upserted.push(qualified);
                }
            }
        }
        Ok(changes)
    }

    /// Diff two commits and resolve the changed memory files to structured refs.
    ///
    /// Only `.md` files under `global/` or `projects/` (namespace directories)
    /// are considered. Each changed file is resolved to a
    /// [`crate::types::MemoryRef`] by parsing the blob's YAML frontmatter (new
    /// side for upserts, old side for removals) — the same authority
    /// `list_memories` uses to build the canonical index keys, so hierarchical
    /// scope paths are never split ambiguously. Files whose frontmatter cannot
    /// be parsed, or whose object is not a memory at all (e.g. a symlink blob),
    /// are counted in [`ResolvedChanges::unresolved`] rather than silently
    /// dropped; a git failure while reading a blob the diff itself reported is
    /// an error.
    ///
    /// A git type change (a tracked regular memory file replaced by a symlink,
    /// or the reverse) is reported as an old-side removal plus a new-side
    /// upsert, so a memory that `list_memories` will no longer see (symlinks
    /// are skipped there) is dropped from derived indexes rather than left
    /// stale.
    ///
    /// Must be called from within `spawn_blocking` since it reads git objects.
    pub(crate) fn diff_changed_refs(
        &self,
        old_oid: [u8; 20],
        new_oid: [u8; 20],
    ) -> Result<ResolvedChanges, MemoryError> {
        let mut changes = ResolvedChanges::default();
        for change in changed_files(&self.root, old_oid, new_oid)? {
            match change.kind {
                ChangeKind::Added | ChangeKind::Modified => {
                    self.resolve_change(
                        &mut changes,
                        change.new_blob.as_deref(),
                        &change.path,
                        true,
                    );
                }
                ChangeKind::Removed => {
                    self.resolve_change(
                        &mut changes,
                        change.old_blob.as_deref(),
                        &change.path,
                        false,
                    );
                }
                ChangeKind::TypeChanged => {
                    self.resolve_change(
                        &mut changes,
                        change.old_blob.as_deref(),
                        &change.path,
                        false,
                    );
                    self.resolve_change(
                        &mut changes,
                        change.new_blob.as_deref(),
                        &change.path,
                        true,
                    );
                }
            }
        }
        Ok(changes)
    }

    /// Parse one changed blob into a `MemoryRef`, counting unresolvable files.
    fn resolve_change(
        &self,
        changes: &mut ResolvedChanges,
        blob: Option<&[u8]>,
        path: &str,
        upsert: bool,
    ) {
        let Some(raw) = blob.and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
            warn!(
                path,
                "changed memory file is not UTF-8; cannot resolve its reference"
            );
            changes.unresolved += 1;
            return;
        };
        match Memory::from_markdown(raw) {
            Ok(memory) => {
                if upsert {
                    changes.upserted.push(memory.mem_ref());
                } else {
                    changes.removed.push(memory.mem_ref());
                }
            }
            Err(error) => {
                warn!(
                    path,
                    error = %error,
                    "changed memory file has unparseable frontmatter; cannot resolve its reference"
                );
                changes.unresolved += 1;
            }
        }
    }

    /// Resolve all index conflicts using a recency-based strategy.
    ///
    /// For each conflicted entry, the version with the more recent `updated_at`
    /// frontmatter timestamp wins. Ties and parse failures fall back to "ours"
    /// (local). Returns the number of files resolved.
    fn resolve_conflicts_by_recency(
        &self,
        repo: &Repository,
        index: &mut git2::Index,
    ) -> Result<usize, MemoryError> {
        // Collect conflict info first to avoid borrow issues with the index.
        struct ConflictInfo {
            path: PathBuf,
            our_blob: Option<Vec<u8>>,
            their_blob: Option<Vec<u8>>,
        }

        let mut conflicts_info: Vec<ConflictInfo> = Vec::new();

        {
            let conflicts = index.conflicts()?;
            for conflict in conflicts {
                let conflict = conflict?;

                let path = conflict
                    .our
                    .as_ref()
                    .or(conflict.their.as_ref())
                    .and_then(|e| std::str::from_utf8(&e.path).ok())
                    .map(|s| self.root.join(s));

                let path = match path {
                    Some(p) => p,
                    None => {
                        continue;
                    }
                };

                let our_blob = conflict
                    .our
                    .as_ref()
                    .and_then(|e| repo.find_blob(e.id).ok())
                    .map(|b| b.content().to_vec());

                let their_blob = conflict
                    .their
                    .as_ref()
                    .and_then(|e| repo.find_blob(e.id).ok())
                    .map(|b| b.content().to_vec());

                conflicts_info.push(ConflictInfo {
                    path,
                    our_blob,
                    their_blob,
                });
            }
        }

        let mut resolved = 0usize;

        for info in conflicts_info {
            let our_str = info
                .our_blob
                .as_deref()
                .and_then(|b| std::str::from_utf8(b).ok())
                .map(str::to_owned);
            let their_str = info
                .their_blob
                .as_deref()
                .and_then(|b| std::str::from_utf8(b).ok())
                .map(str::to_owned);

            let our_ts = our_str
                .as_deref()
                .and_then(|s| Memory::from_markdown(s).ok())
                .map(|m| m.metadata.updated_at);
            let their_ts = their_str
                .as_deref()
                .and_then(|s| Memory::from_markdown(s).ok())
                .map(|m| m.metadata.updated_at);

            let (chosen_bytes, label): (Vec<u8>, String) =
                match (our_str.as_deref(), their_str.as_deref()) {
                    (Some(ours), Some(theirs)) => match (our_ts, their_ts) {
                        (Some(ot), Some(tt)) if tt > ot => (
                            theirs.as_bytes().to_vec(),
                            format!("theirs (updated_at: {})", tt),
                        ),
                        (Some(ot), _) => (
                            ours.as_bytes().to_vec(),
                            format!("ours (updated_at: {})", ot),
                        ),
                        _ => (
                            ours.as_bytes().to_vec(),
                            "ours (timestamp unparseable)".to_string(),
                        ),
                    },
                    (Some(ours), None) => (
                        ours.as_bytes().to_vec(),
                        "ours (theirs missing)".to_string(),
                    ),
                    (None, Some(theirs)) => (
                        theirs.as_bytes().to_vec(),
                        "theirs (ours missing)".to_string(),
                    ),
                    (None, None) => {
                        // Both UTF-8 conversions failed — fall back to raw blob bytes.
                        match (info.our_blob.as_deref(), info.their_blob.as_deref()) {
                            (Some(ours), _) => {
                                (ours.to_vec(), "ours (binary/non-UTF-8)".to_string())
                            }
                            (_, Some(theirs)) => {
                                (theirs.to_vec(), "theirs (binary/non-UTF-8)".to_string())
                            }
                            (None, None) => {
                                // Both blobs truly absent — remove the entry from
                                // the index so write_tree() succeeds.
                                warn!(
                                    "conflict at '{}': both sides missing — removing from index",
                                    info.path.display()
                                );
                                let relative = info.path.strip_prefix(&self.root).map_err(|e| {
                                    MemoryError::InvalidInput {
                                        reason: format!(
                                            "path strip error during conflict resolution: {}",
                                            e
                                        ),
                                    }
                                })?;
                                index.conflict_remove(relative)?;
                                resolved += 1;
                                continue;
                            }
                        }
                    }
                };

            warn!(
                "conflict resolved: {} — kept {}",
                info.path.display(),
                label
            );

            // Write the chosen content to the working directory — going through
            // assert_within_root and write_memory_file enforces path-traversal
            // and symlink protections.
            self.assert_within_root(&info.path)?;
            if let Some(parent) = info.path.parent() {
                #[allow(clippy::disallowed_methods)]
                std::fs::create_dir_all(parent)?;
            }
            self.write_memory_file(&info.path, &chosen_bytes)?;

            let relative =
                info.path
                    .strip_prefix(&self.root)
                    .map_err(|e| MemoryError::InvalidInput {
                        reason: format!("path strip error during conflict resolution: {}", e),
                    })?;
            index.add_path(relative)?;

            resolved += 1;
        }

        Ok(resolved)
    }

    fn signature<'r>(&self, repo: &'r Repository) -> Result<Signature<'r>, MemoryError> {
        let sig = repo
            .signature()
            .or_else(|_| Signature::now("memory-mcp", "memory-mcp@local"))?;
        Ok(sig)
    }

    /// Return an index whose contents match the repository's current HEAD tree.
    ///
    /// `MemoryRepo` holds one `Repository` for the process lifetime, and
    /// libgit2 caches the index it hands back. Nothing re-reads it, so a
    /// commit made outside pali leaves the cached index describing a tree
    /// that predates that commit. Committing from the stale index writes it
    /// back over `.git/index` and builds a tree from it, producing a commit
    /// that presents as a wholesale revert of the external writer's work with
    /// one file added on top. The working tree stays correct throughout,
    /// which is why it can go unnoticed for weeks — only HEAD is wrong.
    ///
    /// Basing the index on HEAD instead means a pali commit always says
    /// "HEAD, plus exactly what I staged," no matter who else has written.
    ///
    /// This is deliberately *not* fail-closed on divergence: a memory store
    /// must not answer confusion by declining to remember.
    ///
    /// Only the index is reset — the working tree is untouched, so staging a
    /// path afterwards still picks up the file on disk. One consequence:
    /// anything an outside writer has staged but not yet committed is
    /// unstaged by the next pali write (the file stays on disk, and it was
    /// also lost by the cached-index code before #365).
    fn index_from_head(&self, repo: &Repository) -> Result<git2::Index, MemoryError> {
        let mut index = repo.index()?;
        match repo.head() {
            Ok(head) => {
                let tree = head.peel_to_tree()?;
                index.read_tree(&tree)?;
            }
            Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
                // No tree to read. `init_or_open` always makes a first
                // commit, so the reachable case is a branch ref removed
                // from outside, not a fresh repo. Clearing here would make
                // the next commit a root holding one file. Fall back to the
                // freshest record of what is tracked, the on-disk index,
                // so this path never remembers less than it did before #365.
                index.read(true)?;
            }
            Err(e) => {
                return Err(MemoryError::Git(e));
            }
        }
        Ok(index)
    }

    /// Commit the current index state and return the new commit's `Oid`.
    fn commit_index(
        &self,
        repo: &Repository,
        index: &mut git2::Index,
        message: &str,
    ) -> Result<git2::Oid, MemoryError> {
        index.write()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let sig = self.signature(repo)?;

        let oid = match repo.head() {
            Ok(head) => {
                let parent_commit = head.peel_to_commit()?;
                repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent_commit])?
            }
            Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
                repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?
            }
            Err(e) => {
                return Err(MemoryError::Git(e));
            }
        };

        Ok(oid)
    }

    /// Stage a file addition in the given index.
    fn stage_add(&self, index: &mut git2::Index, file_path: &Path) -> Result<(), MemoryError> {
        let relative =
            file_path
                .strip_prefix(&self.root)
                .map_err(|e| MemoryError::InvalidInput {
                    reason: format!("path strip error: {}", e),
                })?;
        index.add_path(relative)?;
        Ok(())
    }

    /// Stage a file removal in the given index.
    fn stage_remove(&self, index: &mut git2::Index, file_path: &Path) -> Result<(), MemoryError> {
        let relative =
            file_path
                .strip_prefix(&self.root)
                .map_err(|e| MemoryError::InvalidInput {
                    reason: format!("path strip error: {}", e),
                })?;
        index.remove_path(relative)?;
        Ok(())
    }

    /// Assert that `path` exists on disk and is not a symlink.
    ///
    /// Returns `NotFound` if the file is absent, `InvalidInput` if it is a
    /// symlink. This is the standard pre-check for operations that read or
    /// remove an existing memory file.
    fn assert_exists_no_symlink(path: &Path, name: &str) -> Result<(), MemoryError> {
        match std::fs::symlink_metadata(path) {
            Err(_) => Err(MemoryError::NotFound {
                name: name.to_string(),
            }),
            Ok(m) if m.file_type().is_symlink() => Err(MemoryError::InvalidInput {
                reason: format!(
                    "path '{}' is a symlink, which is not permitted",
                    path.display()
                ),
            }),
            Ok(_) => Ok(()),
        }
    }

    /// Assert that `path` remains under `self.root` after canonicalisation,
    /// preventing path-traversal attacks.
    fn assert_within_root(&self, path: &Path) -> Result<(), MemoryError> {
        // The file may not exist yet, so we canonicalize its parent and
        // then re-append the filename.
        let parent = path.parent().unwrap_or(path);
        let filename = path.file_name().ok_or_else(|| MemoryError::InvalidInput {
            reason: "path has no filename component".to_string(),
        })?;

        // If the parent doesn't exist yet we check as many ancestors as
        // necessary until we find one that does.
        let canon_parent = {
            let mut p = parent.to_path_buf();
            let mut suffixes: Vec<std::ffi::OsString> = Vec::new();
            loop {
                match p.canonicalize() {
                    Ok(c) => {
                        let mut full = c;
                        for s in suffixes.into_iter().rev() {
                            full.push(s);
                        }
                        break full;
                    }
                    Err(_) => {
                        if let Some(name) = p.file_name() {
                            suffixes.push(name.to_os_string());
                        }
                        match p.parent() {
                            Some(par) => {
                                p = par.to_path_buf();
                            }
                            _none => {
                                return Err(MemoryError::InvalidInput {
                                    reason: "cannot resolve any ancestor of path".into(),
                                });
                            }
                        }
                    }
                }
            }
        };

        let resolved = canon_parent.join(filename);

        let canon_root = self
            .root
            .canonicalize()
            .map_err(|e| MemoryError::InvalidInput {
                reason: format!("cannot canonicalize repo root: {}", e),
            })?;

        if !resolved.starts_with(&canon_root) {
            return Err(MemoryError::InvalidInput {
                reason: format!(
                    "path '{}' escapes repository root '{}'",
                    resolved.display(),
                    canon_root.display()
                ),
            });
        }

        // Reject any symlinks within the repo root. We check each existing
        // component of `resolved` that lies inside `canon_root` — if any is a
        // symlink the request is rejected, because canonicalization already
        // followed it and the prefix check above would silently pass.
        {
            let mut probe = canon_root.clone();
            // Collect the path components that are beneath the root.
            let relative =
                resolved
                    .strip_prefix(&canon_root)
                    .map_err(|e| MemoryError::InvalidInput {
                        reason: format!("path strip error: {}", e),
                    })?;
            for component in relative.components() {
                probe.push(component);
                // Only check components that currently exist on disk.
                if (probe.exists() || probe.symlink_metadata().is_ok())
                    && probe
                        .symlink_metadata()
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false)
                {
                    return Err(MemoryError::InvalidInput {
                        reason: format!(
                            "path component '{}' is a symlink, which is not allowed",
                            probe.display()
                        ),
                    });
                }
            }
        }

        Ok(())
    }

    /// Atomically write `data` to `path` via temp-file + rename.
    ///
    /// Defense-in-depth against symlink attacks (layered):
    /// 1. `validate_path` rejects symlinks in all path components.
    /// 2. An `lstat` check here catches symlinks created between
    ///    validation and write (narrows the TOCTOU window).
    /// 3. On Unix, an `O_NOFOLLOW` probe on the final path detects
    ///    symlinks planted in the window between lstat and
    ///    `atomic_write`. The temp file itself is separately guarded
    ///    by `O_NOFOLLOW` inside `write_tmp`.
    fn write_memory_file(&self, path: &Path, data: &[u8]) -> Result<(), MemoryError> {
        // Layer 2: lstat — reject if the target is currently a symlink.
        if path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(MemoryError::InvalidInput {
                reason: format!("refusing to write through symlink: {}", path.display()),
            });
        }

        // Layer 3 (Unix): O_NOFOLLOW probe — kernel-level symlink rejection.
        // NotFound is fine (file doesn't exist yet); any other error (ELOOP
        // from a symlink, permission denied, etc.) is rejected.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            if let Err(e) = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(crate::fs_util::O_NOFOLLOW)
                .open(path)
            {
                // NotFound is fine — the file doesn't exist yet.
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(MemoryError::InvalidInput {
                        reason: format!("O_NOFOLLOW check failed for {}: {e}", path.display()),
                    });
                }
            }
        }

        crate::fs_util::atomic_write(path, data)?;
        Ok(())
    }

    /// Open `path` for reading using `O_NOFOLLOW` on Unix, then return its
    /// contents as a `String`.
    ///
    /// On non-Unix platforms falls back to `std::fs::read_to_string`.
    fn read_memory_file(&self, path: &Path) -> Result<String, MemoryError> {
        #[cfg(unix)]
        {
            use std::io::Read as _;
            use std::os::unix::fs::OpenOptionsExt as _;
            let mut f = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(crate::fs_util::O_NOFOLLOW)
                .open(path)?;
            let mut buf = String::new();
            f.read_to_string(&mut buf)?;
            Ok(buf)
        }
        #[cfg(not(unix))]
        {
            Ok(std::fs::read_to_string(path)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Memory, MemoryMetadata, Scope, ScopePath};
    use std::sync::Arc;

    fn make_memory(name: &str, content: &str, updated_at_secs: i64) -> Memory {
        let meta = MemoryMetadata {
            tags: vec![],
            scope: Scope::Root,
            created_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            updated_at: chrono::DateTime::from_timestamp(updated_at_secs, 0).unwrap(),
            source: None,
        };
        Memory::new(name, content, meta).unwrap()
    }

    fn setup_bare_remote() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        git2::Repository::init_bare(dir.path()).expect("failed to init bare repo");
        // `display()` yields backslashes on Windows; a `file://` URL needs
        // forward slashes. Unix absolute paths already carry a leading `/`,
        // so only non-root paths need the extra slash before the drive/root.
        let p = dir.path().display().to_string().replace('\\', "/");
        let url = if p.starts_with('/') {
            format!("file://{p}")
        } else {
            format!("file:///{p}")
        };
        (dir, url)
    }

    fn open_repo(dir: &tempfile::TempDir, remote_url: Option<&str>) -> Arc<MemoryRepo> {
        Arc::new(MemoryRepo::init_or_open(dir.path(), remote_url).expect("failed to init repo"))
    }

    // -- #365: cached index must not revert an external writer -------------

    /// Commit a file directly with git2, bypassing `MemoryRepo` entirely —
    /// the way a human running `git commit` in the memories checkout does.
    fn commit_out_of_band(dir: &tempfile::TempDir, filename: &str, body: &str) {
        let repo = git2::Repository::open(dir.path()).expect("open for out-of-band write");
        std::fs::write(dir.path().join(filename), body).expect("write out-of-band file");

        let mut index = repo.index().expect("index");
        index
            .add_path(std::path::Path::new(filename))
            .expect("stage out-of-band file");
        index.write().expect("write index");
        let tree_oid = index.write_tree().expect("write_tree");
        let tree = repo.find_tree(tree_oid).expect("find_tree");
        let sig = git2::Signature::now("outsider", "outsider@example.invalid").unwrap();
        let parent = repo
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("peel to commit");
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "out-of-band commit",
            &tree,
            &[&parent],
        )
        .expect("commit out-of-band");
    }

    /// True if `filename` is present in the repository's current HEAD tree.
    fn in_head_tree(dir: &tempfile::TempDir, filename: &str) -> bool {
        let repo = git2::Repository::open(dir.path()).expect("open for tree check");
        let head = repo.head().expect("head");
        let tree = head.peel_to_tree().expect("peel to tree");
        let found = tree.get_name(filename).is_some();
        drop(tree);
        found
    }

    #[tokio::test]
    async fn save_after_external_commit_does_not_revert_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        // A save through the API, so the cached index is populated and warm.
        repo.save_memory(&make_memory("first", "one", 1_700_000_100))
            .await
            .expect("first save");

        // Someone else commits, without going through pali.
        commit_out_of_band(&dir, "outsider.md", "not pali's file\n");
        assert!(in_head_tree(&dir, "outsider.md"), "precondition");

        // A second save must add its file WITHOUT deleting the outsider's.
        repo.save_memory(&make_memory("second", "two", 1_700_000_200))
            .await
            .expect("second save");

        assert!(
            in_head_tree(&dir, "outsider.md"),
            "#365: save_memory built its tree from a stale cached index and \
             reverted a commit made outside pali"
        );
        repo.read_memory("first", &Scope::Root)
            .await
            .expect("earlier memory still present");
        repo.read_memory("second", &Scope::Root)
            .await
            .expect("new memory written");
    }

    #[tokio::test]
    async fn delete_after_external_commit_does_not_revert_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        repo.save_memory(&make_memory("doomed", "bye", 1_700_000_100))
            .await
            .expect("save");

        commit_out_of_band(&dir, "outsider.md", "not pali's file\n");

        repo.delete_memory("doomed", &Scope::Root)
            .await
            .expect("delete");

        assert!(
            in_head_tree(&dir, "outsider.md"),
            "#365: delete_memory reverted an out-of-band commit"
        );
        assert!(
            repo.read_memory("doomed", &Scope::Root).await.is_err(),
            "the delete itself must still take effect"
        );
    }

    #[tokio::test]
    async fn move_after_external_commit_does_not_revert_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        repo.save_memory(&make_memory("travelling", "here", 1_700_000_100))
            .await
            .expect("save");

        commit_out_of_band(&dir, "outsider.md", "not pali's file\n");

        let dest_name: MemoryName = "travelling".parse().expect("valid memory name");
        let dest_scope = Scope::Path(ScopePath::new("elsewhere").expect("valid scope path"));
        repo.move_memory("travelling", &Scope::Root, &dest_name, &dest_scope)
            .await
            .expect("move");

        assert!(
            in_head_tree(&dir, "outsider.md"),
            "#365: move_memory reverted an out-of-band commit"
        );
        repo.read_memory("travelling", &dest_scope)
            .await
            .expect("the move itself must still take effect: memory at destination");
        assert!(
            repo.read_memory("travelling", &Scope::Root).await.is_err(),
            "the move itself must still take effect: source removed"
        );
    }

    /// Path of `name` in the root scope, relative to the repository root.
    fn root_rel_path(repo: &MemoryRepo, name: &str) -> std::path::PathBuf {
        repo.memory_path(name, &Scope::Root)
            .strip_prefix(&repo.root)
            .expect("memory path is inside the repo")
            .to_path_buf()
    }

    /// The harm #365 actually reported: an outside commit that deletes one of
    /// pali's files and edits another must survive the next save, along with
    /// an outside add — no resurrected deletion, no reverted edit.
    #[tokio::test]
    async fn save_after_external_delete_and_edit_does_not_revert_them() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        repo.save_memory(&make_memory("keep", "one", 1_700_000_100))
            .await
            .expect("save keep");
        repo.save_memory(&make_memory("gone", "two", 1_700_000_200))
            .await
            .expect("save gone");

        let keep_rel = root_rel_path(&repo, "keep");
        let gone_rel = root_rel_path(&repo, "gone");
        let edited = b"edited outside pali\n";

        // One outside commit: edit `keep`, delete `gone`, add `outsider.md`.
        {
            let outside = git2::Repository::open(dir.path()).expect("open outside");
            let mut index = outside.index().expect("index");
            std::fs::write(dir.path().join(&keep_rel), edited).expect("edit keep");
            index.add_path(&keep_rel).expect("stage edit");
            std::fs::remove_file(dir.path().join(&gone_rel)).expect("delete gone");
            index.remove_path(&gone_rel).expect("stage delete");
            std::fs::write(dir.path().join("outsider.md"), "not pali's file\n").expect("add");
            index
                .add_path(std::path::Path::new("outsider.md"))
                .expect("stage add");
            index.write().expect("write index");
            let tree = outside
                .find_tree(index.write_tree().expect("write_tree"))
                .expect("find_tree");
            let sig = git2::Signature::now("outsider", "outsider@example.invalid").unwrap();
            let parent = outside.head().unwrap().peel_to_commit().unwrap();
            outside
                .commit(Some("HEAD"), &sig, &sig, "outside", &tree, &[&parent])
                .expect("outside commit");
        }

        repo.save_memory(&make_memory("third", "three", 1_700_000_300))
            .await
            .expect("save third");

        let git = git2::Repository::open(dir.path()).expect("open for checks");
        let tree = git.head().unwrap().peel_to_tree().unwrap();
        assert!(
            tree.get_path(std::path::Path::new("outsider.md")).is_ok(),
            "#365: outside add reverted"
        );
        assert!(
            tree.get_path(&gone_rel).is_err(),
            "#365: outside delete reverted (file resurrected in HEAD)"
        );
        let keep_blob = git
            .find_blob(tree.get_path(&keep_rel).expect("keep in HEAD").id())
            .unwrap();
        assert_eq!(
            keep_blob.content(),
            edited,
            "#365: outside edit reverted in HEAD"
        );
        assert!(
            tree.get_path(&root_rel_path(&repo, "third")).is_ok(),
            "the save itself must still take effect"
        );
        assert_eq!(
            git.diff_tree_to_index(Some(&tree), None, None)
                .unwrap()
                .deltas()
                .len(),
            0,
            "on-disk index differs from HEAD after the save"
        );
        assert_eq!(
            git.diff_index_to_workdir(None, None)
                .unwrap()
                .deltas()
                .len(),
            0,
            "working tree differs from the index after the save"
        );
    }

    /// A branch ref removed from outside leaves HEAD unborn. The next save
    /// must not commit a root that holds only its own file: the memories
    /// already tracked have to be in that commit too.
    #[tokio::test]
    async fn save_after_branch_ref_removed_keeps_tracked_memories() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        repo.save_memory(&make_memory("first", "one", 1_700_000_100))
            .await
            .expect("first save");

        {
            let outside = git2::Repository::open(dir.path()).expect("open outside");
            let mut branch = outside.head().expect("head").resolve().expect("resolve");
            branch.delete().expect("delete branch ref");
            assert!(outside.head().is_err(), "precondition: HEAD is unborn");
        }

        repo.save_memory(&make_memory("second", "two", 1_700_000_200))
            .await
            .expect("second save");

        let git = git2::Repository::open(dir.path()).expect("open for checks");
        let tree = git.head().unwrap().peel_to_tree().unwrap();
        assert!(
            tree.get_path(&root_rel_path(&repo, "second")).is_ok(),
            "the save itself must take effect"
        );
        assert!(
            tree.get_path(&root_rel_path(&repo, "first")).is_ok(),
            "an unborn HEAD cleared the index: the new root commit dropped \
             every memory already tracked"
        );
    }

    #[test]
    fn redact_url_strips_userinfo() {
        assert_eq!(
            redact_url("https://user:test_token123@github.com/org/repo.git"),
            "https://[REDACTED]@github.com/org/repo.git"
        );
    }

    #[test]
    fn redact_url_no_at_passthrough() {
        let url = "https://github.com/org/repo.git";
        assert_eq!(redact_url(url), url);
    }

    #[test]
    fn redact_url_file_protocol_passthrough() {
        let url = "file:///tmp/bare.git";
        assert_eq!(redact_url(url), url);
    }

    #[test]
    fn assert_within_root_accepts_valid_path() {
        let dir = tempfile::tempdir().unwrap();
        let repo = MemoryRepo::init_or_open(dir.path(), None).unwrap();
        let valid = dir.path().join("global").join("my-memory.md");
        // Create the parent so canonicalization works.
        std::fs::create_dir_all(valid.parent().unwrap()).unwrap();
        assert!(repo.assert_within_root(&valid).is_ok());
    }

    #[test]
    fn assert_within_root_rejects_escape() {
        let dir = tempfile::tempdir().unwrap();
        let repo = MemoryRepo::init_or_open(dir.path(), None).unwrap();
        // Build a path that escapes the repo root. We need enough ".." to go
        // above the tmpdir, then descend into /tmp/evil.
        let _evil = dir
            .path()
            .join("..")
            .join("..")
            .join("..")
            .join("tmp")
            .join("evil.md");
        // Only assert if the path actually resolves outside root.
        // (If the temp dir is at root level, this might not escape — use an
        // explicit absolute path instead.)
        let outside = std::path::PathBuf::from("/tmp/definitely-outside");
        assert!(repo.assert_within_root(&outside).is_err());
    }

    #[tokio::test]
    async fn push_local_only_returns_ok() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);
        let result = repo.push("main").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn pull_local_only_returns_no_remote() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);
        let result = repo.pull("main").await.unwrap();
        assert!(matches!(result, PullResult::NoRemote));
    }

    /// Regression guard: scp-like remotes (`git@host:path`) are SSH even
    /// though they carry no scheme, while an `https://host/path` remote must
    /// not be mistaken for one — URL classification decides whether a token
    /// is required at all.
    #[test]
    fn ssh_remote_detection_covers_ssh_and_scp_forms() {
        for url in [
            "ssh://git@gitea.example:2222/AI/Memory.git",
            "git+ssh://git@gitea.example/AI/Memory.git",
            "git@github.com:org/repo.git",
            "user@host:path.git",
        ] {
            assert!(is_ssh_remote(url), "{url} must be treated as ssh");
        }
        for url in [
            "https://gitea.example/AI/Memory.git",
            "http://127.0.0.1:8080/repo.git",
            "file:///tmp/memory.git",
            "git://127.0.0.1:9418/repo.git",
        ] {
            assert!(!is_ssh_remote(url), "{url} must not be treated as ssh");
        }
    }

    /// An SSH origin must reach the transport instead of failing credential
    /// setup. Port 1 refuses immediately, so the failure is a `Git` transport
    /// error even though the provider's token is unusable for SSH.
    #[tokio::test]
    async fn push_to_ssh_remote_uses_ssh_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, Some("ssh://git@127.0.0.1:1/memory.git"));
        let error = repo
            .push("main")
            .await
            .expect_err("connection to port 1 must fail");
        assert!(
            matches!(error, MemoryError::Git(_)),
            "ssh push must fail at the transport, not on credentials: {error:?}"
        );
        // Without the libgit2 SSH transport the failure would be a protocol
        // rejection, not a connection attempt — this keeps the feature honest.
        let message = error.to_string().to_lowercase();
        assert!(
            !message.contains("unsupported url protocol"),
            "git2 was built without SSH support: {error}"
        );
    }

    /// A blank token must behave like an unset one: an empty environment entry
    /// would otherwise authenticate with an empty password.
    #[test]
    fn blank_git_token_is_treated_as_unset() {
        assert_eq!(
            normalize_git_token(Some(" ghp_example ".into())),
            Some("ghp_example".into())
        );
        assert_eq!(normalize_git_token(Some("   ".into())), None);
        assert_eq!(normalize_git_token(Some(String::new())), None);
        assert_eq!(normalize_git_token(None), None);
    }

    /// Regression: `PALI_GIT_TOKEN` must reach the HTTP transport as an
    /// `Authorization: Basic` header (ADR-0052).
    ///
    /// The server answers every request with `401`, so the push fails; the
    /// assertion is about the credential libgit2 was handed, not about a
    /// successful sync.
    #[tokio::test]
    async fn http_push_sends_configured_git_token() {
        use base64::Engine as _;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        /// Clears the variable even if the test panics, so no other test sees
        /// a token it did not set.
        struct TokenEnv;
        impl Drop for TokenEnv {
            fn drop(&mut self) {
                unsafe {
                    std::env::remove_var("PALI_GIT_TOKEN");
                }
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test http server");
        let addr = listener.local_addr().expect("test server addr");
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let server = {
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut buf = [0u8; 2048];
                        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                            match socket.read(&mut buf).await {
                                Ok(0) | Err(_) => {
                                    return;
                                }
                                Ok(n) => request.extend_from_slice(&buf[..n]),
                            }
                        }
                        for line in String::from_utf8_lossy(&request).lines() {
                            let Some((name, value)) = line.split_once(':') else {
                                continue;
                            };
                            if name.eq_ignore_ascii_case("authorization") {
                                seen.lock()
                                    .expect("seen lock")
                                    .push(value.trim().to_owned());
                            }
                        }
                        let _ = socket
                            .write_all(
                                b"HTTP/1.1 401 Unauthorized\r\n\
                                  WWW-Authenticate: Basic realm=\"pali\"\r\n\
                                  Content-Length: 0\r\n\
                                  Connection: close\r\n\r\n",
                            )
                            .await;
                    });
                }
            })
        };

        unsafe {
            std::env::set_var("PALI_GIT_TOKEN", "ghp_integration_test");
        }
        let _guard = TokenEnv;

        let local_dir = tempfile::tempdir().unwrap();
        let remote_url = format!("http://{addr}/memories.git");
        let repo = open_repo(&local_dir, Some(&remote_url));
        let mem = make_memory("http-push", "http content", 1_700_000_000);
        repo.save_memory(&mem).await.unwrap();

        // The server never authorizes, so this must fail — quickly.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), repo.push("main"))
            .await
            .expect("push must not hang against an unauthorized server");
        assert!(outcome.is_err(), "an always-401 server must fail the push");
        server.abort();

        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("x-access-token:ghp_integration_test")
        );
        let seen = seen.lock().expect("seen lock").clone();
        assert!(
            seen.iter().any(|value| value == &expected),
            "expected the configured token as a Basic credential, saw: {seen:?}"
        );
    }

    /// Regression: a local path must work as the remote, because the VS Code
    /// extension's `remoteUrl` setting accepts a path as well as a URL.
    #[tokio::test]
    async fn push_to_bare_remote_by_path() {
        let (remote_dir, _url) = setup_bare_remote();
        let remote_path = remote_dir.path().to_string_lossy().into_owned();
        let local_dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&local_dir, Some(&remote_path));

        let mem = make_memory("path-push", "path content", 1_700_000_000);
        repo.save_memory(&mem).await.unwrap();
        repo.push("main").await.unwrap();

        let bare = git2::Repository::open_bare(remote_dir.path()).unwrap();
        assert!(bare.find_reference("refs/heads/main").is_ok());
    }

    #[tokio::test]
    async fn push_to_bare_remote() {
        let (_remote_dir, remote_url) = setup_bare_remote();
        let local_dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&local_dir, Some(&remote_url));

        let mem = make_memory("test-push", "push content", 1_700_000_000);
        repo.save_memory(&mem).await.unwrap();

        repo.push("main").await.unwrap();

        let bare = git2::Repository::open_bare(_remote_dir.path()).unwrap();
        let head = bare.find_reference("refs/heads/main").unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert!(commit.message().unwrap().contains("test-push"));
    }

    #[tokio::test]
    async fn pull_from_empty_bare_remote_returns_up_to_date() {
        let (_remote_dir, remote_url) = setup_bare_remote();
        let local_dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&local_dir, Some(&remote_url));

        // First save something locally so we have an initial commit (HEAD exists).
        let mem = make_memory("seed", "seed content", 1_700_000_000);
        repo.save_memory(&mem).await.unwrap();

        let result = repo.pull("main").await.unwrap();
        assert!(matches!(result, PullResult::UpToDate));
    }

    #[tokio::test]
    async fn pull_fast_forward() {
        let (_remote_dir, remote_url) = setup_bare_remote();

        // Repo A: save and push
        let dir_a = tempfile::tempdir().unwrap();
        let repo_a = open_repo(&dir_a, Some(&remote_url));
        let mem = make_memory("from-a", "content from A", 1_700_000_000);
        repo_a.save_memory(&mem).await.unwrap();
        repo_a.push("main").await.unwrap();

        // Repo B: init with same remote, then pull
        let dir_b = tempfile::tempdir().unwrap();
        let repo_b = open_repo(&dir_b, Some(&remote_url));
        // Repo B needs an initial commit for HEAD to exist.
        let seed = make_memory("seed-b", "seed", 1_700_000_000);
        repo_b.save_memory(&seed).await.unwrap();

        let result = repo_b.pull("main").await.unwrap();
        assert!(
            matches!(
                result,
                PullResult::FastForward { .. } | PullResult::Merged { .. }
            ),
            "expected fast-forward or merge, got {:?}",
            result
        );

        let file = dir_b.path().join("global").join("from-a.md");
        assert!(file.exists(), "from-a.md should exist in repo B after pull");
    }

    #[tokio::test]
    async fn pull_up_to_date_after_push() {
        let (_remote_dir, remote_url) = setup_bare_remote();
        let local_dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&local_dir, Some(&remote_url));

        let mem = make_memory("synced", "synced content", 1_700_000_000);
        repo.save_memory(&mem).await.unwrap();
        repo.push("main").await.unwrap();

        let result = repo.pull("main").await.unwrap();
        assert!(matches!(result, PullResult::UpToDate));
    }

    #[tokio::test]
    async fn pull_merge_conflict_theirs_newer_wins() {
        let (_remote_dir, remote_url) = setup_bare_remote();

        // Repo A: save "shared" with T1, push
        let dir_a = tempfile::tempdir().unwrap();
        let repo_a = open_repo(&dir_a, Some(&remote_url));
        let mem_a1 = make_memory("shared", "version from A initial", 1_700_000_100);
        repo_a.save_memory(&mem_a1).await.unwrap();
        repo_a.push("main").await.unwrap();

        // Repo B: pull to get A's commit, then modify "shared" with T3 (newer), push
        let dir_b = tempfile::tempdir().unwrap();
        let repo_b = open_repo(&dir_b, Some(&remote_url));
        let seed = make_memory("seed-b", "seed", 1_700_000_000);
        repo_b.save_memory(&seed).await.unwrap();
        repo_b.pull("main").await.unwrap();

        let mem_b = make_memory("shared", "version from B (newer)", 1_700_000_300);
        repo_b.save_memory(&mem_b).await.unwrap();
        repo_b.push("main").await.unwrap();

        // Repo A: modify "shared" with T2 (older than T3), then pull — conflict
        let mem_a2 = make_memory("shared", "version from A (older)", 1_700_000_200);
        repo_a.save_memory(&mem_a2).await.unwrap();
        let result = repo_a.pull("main").await.unwrap();

        assert!(
            matches!(result, PullResult::Merged { conflicts_resolved, .. } if conflicts_resolved >= 1),
            "expected merge with conflicts resolved, got {:?}",
            result
        );

        // Verify theirs (B's version, T3=300) won.
        let file = dir_a.path().join("global").join("shared.md");
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(
            content.contains("version from B (newer)"),
            "expected B's version to win (newer timestamp), got: {}",
            content
        );
    }

    #[tokio::test]
    async fn pull_merge_conflict_ours_newer_wins() {
        let (_remote_dir, remote_url) = setup_bare_remote();

        // Repo A: save "shared" with T1, push
        let dir_a = tempfile::tempdir().unwrap();
        let repo_a = open_repo(&dir_a, Some(&remote_url));
        let mem_a1 = make_memory("shared", "version from A initial", 1_700_000_100);
        repo_a.save_memory(&mem_a1).await.unwrap();
        repo_a.push("main").await.unwrap();

        // Repo B: pull, modify with T2 (older), push
        let dir_b = tempfile::tempdir().unwrap();
        let repo_b = open_repo(&dir_b, Some(&remote_url));
        let seed = make_memory("seed-b", "seed", 1_700_000_000);
        repo_b.save_memory(&seed).await.unwrap();
        repo_b.pull("main").await.unwrap();

        let mem_b = make_memory("shared", "version from B (older)", 1_700_000_200);
        repo_b.save_memory(&mem_b).await.unwrap();
        repo_b.push("main").await.unwrap();

        // Repo A: modify with T3 (newer), pull — conflict
        let mem_a2 = make_memory("shared", "version from A (newer)", 1_700_000_300);
        repo_a.save_memory(&mem_a2).await.unwrap();
        let result = repo_a.pull("main").await.unwrap();

        assert!(
            matches!(result, PullResult::Merged { conflicts_resolved, .. } if conflicts_resolved >= 1),
            "expected merge with conflicts resolved, got {:?}",
            result
        );

        // Verify ours (A's version, T3=300) won.
        let file = dir_a.path().join("global").join("shared.md");
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(
            content.contains("version from A (newer)"),
            "expected A's version to win (newer timestamp), got: {}",
            content
        );
    }

    #[tokio::test]
    async fn pull_merge_no_conflict_different_files() {
        let (_remote_dir, remote_url) = setup_bare_remote();

        // Repo A: save "mem-a", push
        let dir_a = tempfile::tempdir().unwrap();
        let repo_a = open_repo(&dir_a, Some(&remote_url));
        let mem_a = make_memory("mem-a", "from A", 1_700_000_100);
        repo_a.save_memory(&mem_a).await.unwrap();
        repo_a.push("main").await.unwrap();

        // Repo B: pull, save "mem-b", push
        let dir_b = tempfile::tempdir().unwrap();
        let repo_b = open_repo(&dir_b, Some(&remote_url));
        let seed = make_memory("seed-b", "seed", 1_700_000_000);
        repo_b.save_memory(&seed).await.unwrap();
        repo_b.pull("main").await.unwrap();
        let mem_b = make_memory("mem-b", "from B", 1_700_000_200);
        repo_b.save_memory(&mem_b).await.unwrap();
        repo_b.push("main").await.unwrap();

        // Repo A: save "mem-a2" (different file), pull — should merge cleanly
        let mem_a2 = make_memory("mem-a2", "also from A", 1_700_000_300);
        repo_a.save_memory(&mem_a2).await.unwrap();
        let result = repo_a.pull("main").await.unwrap();

        assert!(
            matches!(
                result,
                PullResult::Merged {
                    conflicts_resolved: 0,
                    ..
                }
            ),
            "expected clean merge, got {:?}",
            result
        );

        assert!(dir_a.path().join("global").join("mem-b.md").exists());
    }

    /// Helper: valid on-disk memory markdown (frontmatter + body) for diff
    /// tests — changed files are resolved from their frontmatter.
    fn memory_markdown(name: &str, scope: Scope, content: &str) -> String {
        Memory::new(name, content, MemoryMetadata::new(scope, vec![], None))
            .unwrap()
            .to_markdown()
            .unwrap()
    }

    /// Helper: the expected resolved reference for a memory.
    fn mref(scope: Scope, name: &str) -> crate::types::MemoryRef {
        crate::types::MemoryRef::new(scope, MemoryName::new(name).unwrap())
    }

    /// Helper: commit a file with given content and return the new HEAD OID bytes.
    fn commit_file(repo: &Arc<MemoryRepo>, rel_path: &str, content: &str) -> [u8; 20] {
        let inner = repo.inner.lock().expect("lock poisoned");
        let full_path = repo.root.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&full_path, content).unwrap();

        let mut index = inner.index().unwrap();
        index.add_path(std::path::Path::new(rel_path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = inner.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("test", "test@test.com").unwrap();

        let oid = match inner.head() {
            Ok(head) => {
                let parent = head.peel_to_commit().unwrap();
                inner
                    .commit(Some("HEAD"), &sig, &sig, "test commit", &tree, &[&parent])
                    .unwrap()
            }
            Err(_) => inner
                .commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
                .unwrap(),
        };

        let mut buf = [0u8; 20];
        buf.copy_from_slice(oid.as_bytes());
        buf
    }

    /// Helper: commit raw bytes (which may be non-UTF-8) at `rel_path` and
    /// return the new HEAD OID bytes. Used to exercise the public
    /// `diff_changed_memories` path contract against blobs that cannot be
    /// resolved to a memory.
    fn commit_bytes(repo: &Arc<MemoryRepo>, rel_path: &str, content: &[u8]) -> [u8; 20] {
        let inner = repo.inner.lock().expect("lock poisoned");
        let full_path = repo.root.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&full_path, content).unwrap();

        let mut index = inner.index().unwrap();
        index.add_path(std::path::Path::new(rel_path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = inner.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("test", "test@test.com").unwrap();

        let oid = match inner.head() {
            Ok(head) => {
                let parent = head.peel_to_commit().unwrap();
                inner
                    .commit(Some("HEAD"), &sig, &sig, "test commit", &tree, &[&parent])
                    .unwrap()
            }
            Err(_) => inner
                .commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
                .unwrap(),
        };

        let mut buf = [0u8; 20];
        buf.copy_from_slice(oid.as_bytes());
        buf
    }

    /// Helper: replace `rel_path` with a symlink pointing at `target` and
    /// commit it. Records a git symlink entry (mode `120000`) so a preceding
    /// regular-file commit at the same path yields a `Delta::Typechange`.
    fn commit_symlink(repo: &Arc<MemoryRepo>, rel_path: &str, target: &str) -> [u8; 20] {
        let inner = repo.inner.lock().expect("lock poisoned");
        let full_path = repo.root.join(rel_path);
        // Remove any existing regular file, then create the symlink on disk.
        let _ = std::fs::remove_file(&full_path);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &full_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, &full_path).unwrap();

        let mut index = inner.index().unwrap();
        index.add_path(std::path::Path::new(rel_path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = inner.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("test", "test@test.com").unwrap();
        let parent = inner.head().unwrap().peel_to_commit().unwrap();
        let oid = inner
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "typechange to symlink",
                &tree,
                &[&parent],
            )
            .unwrap();

        let mut buf = [0u8; 20];
        buf.copy_from_slice(oid.as_bytes());
        buf
    }

    #[test]
    fn diff_changed_memories_detects_added_global() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        // Capture the initial HEAD (init commit).
        let old_oid = {
            let inner = repo.inner.lock().unwrap();
            let head = inner.head().unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(head.peel_to_commit().unwrap().id().as_bytes());
            buf
        };

        let new_oid = commit_file(
            &repo,
            "global/my-note.md",
            &memory_markdown("my-note", Scope::Root, "# content"),
        );

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert_eq!(changes.upserted, vec![mref(Scope::Root, "my-note")]);
        assert!(changes.removed.is_empty());
        assert_eq!(changes.unresolved, 0);
    }

    #[test]
    fn diff_changed_memories_detects_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let first_oid = commit_file(
            &repo,
            "global/to-delete.md",
            &memory_markdown("to-delete", Scope::Root, "hello"),
        );
        let second_oid = {
            let inner = repo.inner.lock().unwrap();
            let full_path = dir.path().join("global/to-delete.md");
            std::fs::remove_file(&full_path).unwrap();
            let mut index = inner.index().unwrap();
            index
                .remove_path(std::path::Path::new("global/to-delete.md"))
                .unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = inner.find_tree(tree_oid).unwrap();
            let sig = git2::Signature::now("test", "test@test.com").unwrap();
            let parent = inner.head().unwrap().peel_to_commit().unwrap();
            let oid = inner
                .commit(Some("HEAD"), &sig, &sig, "delete file", &tree, &[&parent])
                .unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(oid.as_bytes());
            buf
        };

        let changes = repo.diff_changed_refs(first_oid, second_oid).unwrap();
        assert!(changes.upserted.is_empty());
        // The removal is resolved from the *old* tree's frontmatter — the
        // file no longer exists in the new tree or the working directory.
        assert_eq!(changes.removed, vec![mref(Scope::Root, "to-delete")]);
        assert_eq!(changes.unresolved, 0);
    }

    #[test]
    fn diff_changed_memories_ignores_non_md_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let old_oid = {
            let inner = repo.inner.lock().unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(
                inner
                    .head()
                    .unwrap()
                    .peel_to_commit()
                    .unwrap()
                    .id()
                    .as_bytes(),
            );
            buf
        };

        // Add a non-.md file under global/ and a .md file outside tracked dirs.
        let _ = commit_file(&repo, "global/config.json", "{}");
        let new_oid = commit_file(&repo, "other/note.md", "# ignored");

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert!(
            changes.upserted.is_empty(),
            "should ignore non-.md and out-of-scope files"
        );
        assert!(changes.removed.is_empty());
    }

    #[test]
    fn diff_changed_memories_detects_modified() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let scope: Scope = "myproject".parse().unwrap();
        let first_oid = commit_file(
            &repo,
            "projects/myproject/note.md",
            &memory_markdown("note", scope.clone(), "version 1"),
        );
        let second_oid = commit_file(
            &repo,
            "projects/myproject/note.md",
            &memory_markdown("note", scope.clone(), "version 2"),
        );

        let changes = repo.diff_changed_refs(first_oid, second_oid).unwrap();
        assert_eq!(changes.upserted, vec![mref(scope, "note")]);
        assert!(changes.removed.is_empty());
        assert_eq!(changes.unresolved, 0);
    }

    /// Hierarchical scopes make on-disk paths ambiguous
    /// (`projects/a/b/mem.md` could be scope `a/b`, name `mem` or scope
    /// `a`, name `b/mem`); resolution must come from the frontmatter, never
    /// from splitting the path.
    #[test]
    fn diff_changed_memories_resolves_hierarchical_scope_from_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let old_oid = {
            let inner = repo.inner.lock().unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(
                inner
                    .head()
                    .unwrap()
                    .peel_to_commit()
                    .unwrap()
                    .id()
                    .as_bytes(),
            );
            buf
        };

        let scope: Scope = "a/b".parse().unwrap();
        let new_oid = commit_file(
            &repo,
            "projects/a/b/mem.md",
            &memory_markdown("mem", scope.clone(), "hierarchical content"),
        );

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert_eq!(
            changes.upserted,
            vec![mref(scope, "mem")],
            "must resolve scope 'a/b' + name 'mem' from frontmatter, not \
             scope 'a' + name 'b/mem' from the path"
        );
        assert_eq!(changes.unresolved, 0);
    }

    /// A changed `.md` file that is not a parseable memory must be counted
    /// as unresolved — never silently dropped from the change set.
    #[test]
    fn diff_changed_memories_counts_unparseable_files_as_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let old_oid = {
            let inner = repo.inner.lock().unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(
                inner
                    .head()
                    .unwrap()
                    .peel_to_commit()
                    .unwrap()
                    .id()
                    .as_bytes(),
            );
            buf
        };

        let _ = commit_file(&repo, "global/broken.md", "no frontmatter at all");
        let new_oid = commit_file(
            &repo,
            "global/fine.md",
            &memory_markdown("fine", Scope::Root, "resolvable"),
        );

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert_eq!(changes.upserted, vec![mref(Scope::Root, "fine")]);
        assert!(changes.removed.is_empty());
        assert_eq!(changes.unresolved, 1);
    }

    /// A zero OID (unborn branch sentinel) must not crash; all files in the
    /// new commit should appear as additions.
    #[test]
    fn diff_changed_memories_zero_oid_treats_all_as_added() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        // Commit a global memory file — this is the "new" state.
        let new_oid = commit_file(
            &repo,
            "global/first-memory.md",
            &memory_markdown("first-memory", Scope::Root, "# Hello"),
        );

        // old_oid = [0u8; 20] simulates an unborn branch (no prior commit).
        let old_oid = [0u8; 20];

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert_eq!(
            changes.upserted,
            vec![mref(Scope::Root, "first-memory")],
            "zero OID: all new-tree files should be additions"
        );
        assert!(changes.removed.is_empty(), "zero OID: no removals expected");
    }

    /// Replace a tracked regular memory file with a symlink at the same path
    /// (git raw status `T`). `list_memories` skips symlinks, so the memory
    /// leaves authoritative repository truth — the diff must therefore emit a
    /// removal of the old memory (so its lexical/vector entry disappears) and
    /// count the unresolvable symlink new-side, forcing degrade + repair.
    /// Without `Delta::Typechange` handling the change is dropped entirely and
    /// the old entry stays stale-Available.
    #[test]
    fn diff_changed_refs_regular_to_symlink_removes_old_and_flags_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        // Commit the memory as a normal file.
        let old_oid = commit_file(
            &repo,
            "global/note.md",
            &memory_markdown("note", Scope::Root, "noteword content"),
        );

        // Replace it with a symlink at the same path and commit the typechange.
        let new_oid = commit_symlink(&repo, "global/note.md", "elsewhere");

        let changes = repo.diff_changed_refs(old_oid, new_oid).unwrap();
        assert_eq!(
            changes.removed,
            vec![mref(Scope::Root, "note")],
            "regular->symlink must remove the old memory's canonical key"
        );
        assert!(
            changes.upserted.is_empty(),
            "the symlink new-side is not a resolvable memory, so nothing is upserted"
        );
        assert_eq!(
            changes.unresolved, 1,
            "the symlink new-side must be counted unresolved so the index degrades"
        );
    }

    /// Public-contract regression guard for `diff_changed_memories`.
    ///
    /// This is the stable public surface, distinct from the internal
    /// `diff_changed_refs` mirror path. It must return **repository-path**
    /// strings without the `.md` suffix (e.g. `projects/a/b/mem`,
    /// `global/broken`), derived straight from git deltas — NOT canonical
    /// resolved keys like `v1:scope=a/b;name=mem`. And because a path is
    /// available even when the blob is not a parseable memory, it must report
    /// **every** changed `.md` file, including unparseable and non-UTF-8 ones,
    /// rather than dropping them the way the resolving `diff_changed_refs`
    /// does. `cargo-semver-checks` cannot see returned-value semantics, so this
    /// test is the behavior-compat guard: it fails if the public method ever
    /// again projects canonical keys or drops unresolvable files.
    #[test]
    fn diff_changed_memories_returns_repo_paths_including_unresolvable_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = open_repo(&dir, None);

        let old_oid = {
            let inner = repo.inner.lock().unwrap();
            let mut buf = [0u8; 20];
            buf.copy_from_slice(
                inner
                    .head()
                    .unwrap()
                    .peel_to_commit()
                    .unwrap()
                    .id()
                    .as_bytes(),
            );
            buf
        };

        // A resolvable memory in a hierarchical scope: exercises that the
        // public method returns the on-disk path, not the canonical key.
        let scope: Scope = "a/b".parse().unwrap();
        let _ = commit_file(
            &repo,
            "projects/a/b/mem.md",
            &memory_markdown("mem", scope.clone(), "hierarchical content"),
        );

        // A `.md` file with no frontmatter — cannot resolve to a memory.
        let _ = commit_file(&repo, "global/broken.md", "no frontmatter at all");

        // A non-UTF-8 `.md` blob — cannot even be read as a string.
        let new_oid = commit_bytes(&repo, "global/binary.md", &[0xff, 0xfe, 0x00, 0x9f]);

        let changes = repo.diff_changed_memories(old_oid, new_oid).unwrap();

        let mut upserted = changes.upserted.clone();
        upserted.sort();
        assert_eq!(
            upserted,
            vec![
                "global/binary".to_string(),
                "global/broken".to_string(),
                "projects/a/b/mem".to_string()
            ],
            "public method must return repo-path strings (not canonical keys) \
             and must include unparseable + non-UTF-8 files, not drop them"
        );

        // Guard the exact contrast the round-five finding is about: the
        // hierarchical file must NOT appear as a canonical resolved key.
        assert!(
            !changes
                .upserted
                .contains(&mref(scope, "mem").qualified_path()),
            "public method must not project canonical resolved keys"
        );

        assert!(changes.removed.is_empty());
    }
}

/// Targeted coverage for lifecycle, origin maintenance, path guards, and
/// change-diff delta handling.
#[cfg(test)]
mod coverage_tests {
    use super::*;
    use crate::types::{Memory, MemoryMetadata, MemoryName, Scope, ScopePath};
    use std::sync::Arc;

    fn mem(name: &str, content: &str) -> Memory {
        Memory::new(
            name,
            content,
            MemoryMetadata::new(Scope::Root, vec![], None),
        )
        .expect("valid memory")
    }

    fn open(dir: &tempfile::TempDir) -> Arc<MemoryRepo> {
        Arc::new(MemoryRepo::init_or_open(dir.path(), None).expect("repo"))
    }

    fn head_bytes(repo: &Arc<MemoryRepo>) -> [u8; 20] {
        let inner = repo.inner.lock().expect("lock");
        let oid = inner
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("commit")
            .id();
        let mut bytes = [0u8; 20];
        bytes.copy_from_slice(oid.as_bytes());
        bytes
    }

    #[test]
    fn redact_url_without_scheme_passes_through() {
        assert_eq!(redact_url("user@host/path"), "user@host/path");
    }

    #[tokio::test]
    async fn unborn_branch_has_no_head_sha() {
        let dir = tempfile::tempdir().expect("temp dir");
        git2::Repository::init(dir.path()).expect("init empty repo");
        let repo = Arc::new(MemoryRepo::init_or_open(dir.path(), None).expect("open"));
        assert!(repo.head_sha().await.is_none());
    }

    #[test]
    fn origin_remote_is_created_then_updated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let _created =
            MemoryRepo::init_or_open(dir.path(), Some("file:///tmp/pali-first.git")).expect("init");
        let updated = MemoryRepo::init_or_open(dir.path(), Some("file:///tmp/pali-second.git"))
            .expect("open");
        {
            let inner = updated.inner.lock().expect("lock");
            let origin = inner.find_remote("origin").expect("origin");
            assert_eq!(origin.url().expect("url"), "file:///tmp/pali-second.git");
        }
        // Same URL again takes the no-update branch.
        let _same = MemoryRepo::init_or_open(dir.path(), Some("file:///tmp/pali-second.git"))
            .expect("open");
    }

    #[test]
    fn existing_gitignore_is_preserved() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join(".gitignore"), "custom\n").expect("write");
        let _repo = MemoryRepo::init_or_open(dir.path(), None).expect("init");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).expect("read"),
            "custom\n"
        );
    }

    #[tokio::test]
    async fn save_memory_creates_nested_scope_directories() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        let scope = Scope::Path(ScopePath::new("org/team").expect("scope"));
        let memory = Memory::new(
            "deep",
            "body",
            MemoryMetadata::new(scope.clone(), vec![], None),
        )
        .expect("memory");

        repo.save_memory(&memory).await.expect("save");
        assert!(repo.read_memory("deep", &scope).await.is_ok());
    }

    #[tokio::test]
    async fn save_memory_failure_is_reported_and_propagated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        // A directory where the memory file must go makes the atomic write fail.
        std::fs::create_dir_all(dir.path().join("global").join("blocked.md")).expect("dir");
        let err = repo
            .save_memory(&mem("blocked", "body"))
            .await
            .expect_err("write over a directory must fail");
        assert!(
            matches!(err, MemoryError::Io(_) | MemoryError::InvalidInput { .. }),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn delete_memory_failure_is_reported_and_propagated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        let err = repo
            .delete_memory("absent", &Scope::Root)
            .await
            .expect_err("deleting a missing memory must fail");
        assert!(matches!(err, MemoryError::NotFound { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn failed_move_rolls_back_and_keeps_source() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        repo.save_memory(&mem("source", "body"))
            .await
            .expect("save source");

        // Destination file path is a directory, so the write fails after the
        // source has been removed — the rollback must restore it.
        std::fs::create_dir_all(
            dir.path()
                .join("projects")
                .join("elsewhere")
                .join("target.md"),
        )
        .expect("dir");
        let dest_name: MemoryName = "target".parse().expect("name");
        let dest_scope = Scope::Path(ScopePath::new("elsewhere").expect("scope"));
        let err = repo
            .move_memory("source", &Scope::Root, &dest_name, &dest_scope)
            .await
            .expect_err("move into a directory must fail");
        assert!(
            !err.to_string().contains("join"),
            "failure should be the write, not the spawn: {err}"
        );
        assert!(
            repo.read_memory("source", &Scope::Root).await.is_ok(),
            "rollback must restore the source"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_memories_skips_symlinks_and_malformed_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        repo.save_memory(&mem("good", "body")).await.expect("save");

        std::fs::create_dir_all(dir.path().join("global")).expect("global dir");
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("global/evil.md"))
            .expect("symlink");
        std::fs::write(
            dir.path().join("global/broken.md"),
            "---\nnot: [valid yaml\n---\nbody",
        )
        .expect("broken markdown");

        let memories = repo.list_memories(Some(&Scope::Root)).await.expect("list");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].name.as_str(), "good");
    }

    #[cfg(unix)]
    #[test]
    fn path_guards_reject_symlinks_and_unnamed_paths() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = MemoryRepo::init_or_open(dir.path(), None).expect("repo");

        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink("/tmp/target", &link).expect("symlink");
        let err = MemoryRepo::assert_exists_no_symlink(&link, "link").expect_err("symlink");
        assert!(err.to_string().contains("symlink"), "{err}");

        assert!(
            repo.assert_within_root(std::path::Path::new("/")).is_err(),
            "a path with no filename component must be rejected"
        );

        // A dangling symlink is not resolved by canonicalize, so the
        // component-by-component symlink probe is what rejects it.
        std::os::unix::fs::symlink(dir.path().join("missing-target"), dir.path().join("alias"))
            .expect("symlink dir");
        repo.assert_within_root(&dir.path().join("alias").join("x.md"))
            .expect_err("symlinked component must be rejected");

        let err = repo
            .write_memory_file(&link, b"data")
            .expect_err("writing through a symlink");
        assert!(err.to_string().contains("refusing to write"), "{err}");
    }

    #[test]
    fn staging_rejects_paths_outside_the_repository() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = MemoryRepo::init_or_open(dir.path(), None).expect("repo");
        let inner = repo.inner.lock().expect("lock");
        let mut index = inner.index().expect("index");
        let outside = std::path::Path::new("/definitely-outside-pali");
        assert!(repo.stage_add(&mut index, outside).is_err());
        assert!(repo.stage_remove(&mut index, outside).is_err());
    }

    #[tokio::test]
    async fn diff_from_unborn_head_treats_every_file_as_added() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        repo.save_memory(&mem("alpha", "one")).await.expect("save");

        let changes = repo
            .diff_changed_refs([0u8; 20], head_bytes(&repo))
            .expect("diff");
        assert!(
            changes
                .upserted
                .iter()
                .any(|reference| reference.name.as_str().ends_with("alpha"))
        );
        assert!(changes.removed.is_empty());
    }

    #[tokio::test]
    async fn diff_ignores_untracked_file_shapes_and_handles_modifications() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        repo.save_memory(&mem("alpha", "one")).await.expect("save");
        let before = head_bytes(&repo);

        // Non-markdown, markdown outside the namespace directories, and a
        // modified memory (Modified delta) in one commit.
        let after = {
            let inner = repo.inner.lock().expect("lock");
            let mut index = inner.index().expect("index");
            let memory_path = repo
                .memory_path("alpha", &Scope::Root)
                .strip_prefix(&repo.root)
                .expect("relative")
                .to_path_buf();
            let rewritten = Memory::new(
                "alpha",
                "rewritten body",
                MemoryMetadata::new(Scope::Root, vec![], None),
            )
            .expect("rewritten memory");
            std::fs::write(
                repo.root.join(&memory_path),
                rewritten.to_markdown().expect("markdown"),
            )
            .expect("write memory");
            index.add_path(&memory_path).expect("stage memory");
            for (relative, content) in [("notes.txt", "text"), ("other/readme.md", "md")] {
                let path = repo.root.join(relative);
                std::fs::create_dir_all(path.parent().expect("parent")).expect("parent");
                std::fs::write(&path, content).expect("write");
                index
                    .add_path(std::path::Path::new(relative))
                    .expect("stage");
                std::fs::remove_file(&path).expect("clean");
            }
            index.write().expect("index write");
            let tree_oid = index.write_tree().expect("tree");
            let tree = inner.find_tree(tree_oid).expect("tree");
            let sig = git2::Signature::now("test", "test@example.invalid").expect("sig");
            let parent = inner
                .head()
                .expect("head")
                .peel_to_commit()
                .expect("parent");
            let oid = inner
                .commit(Some("HEAD"), &sig, &sig, "shapes", &tree, &[&parent])
                .expect("commit");
            let mut bytes = [0u8; 20];
            bytes.copy_from_slice(oid.as_bytes());
            bytes
        };

        let changes = repo.diff_changed_refs(before, after).expect("diff");
        // Modified memories are re-upserted; non-memory paths are ignored.
        assert_eq!(changes.upserted.len(), 1, "{:?}", changes.upserted);
        assert!(changes.upserted[0].name.as_str().ends_with("alpha"));
        assert!(changes.removed.is_empty(), "{:?}", changes.removed);
        assert_eq!(changes.unresolved, 0);
    }

    #[tokio::test]
    async fn diff_reports_deleted_and_typechanged_memories() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = open(&dir);
        repo.save_memory(&mem("gone", "one")).await.expect("save");
        repo.save_memory(&mem("changed", "two"))
            .await
            .expect("save");
        let before = head_bytes(&repo);

        // Remove one memory file and replace the other with a symlink entry.
        let gone_path = repo
            .memory_path("gone", &Scope::Root)
            .strip_prefix(&repo.root)
            .expect("relative")
            .to_path_buf();
        let changed_path = repo
            .memory_path("changed", &Scope::Root)
            .strip_prefix(&repo.root)
            .expect("relative")
            .to_path_buf();
        let after = {
            let inner = repo.inner.lock().expect("lock");
            let mut index = inner.index().expect("index");
            std::fs::remove_file(repo.root.join(&gone_path)).expect("remove");
            index.remove_path(&gone_path).expect("stage remove");
            let full = repo.root.join(&changed_path);
            std::fs::remove_file(&full).expect("remove changed");
            #[cfg(unix)]
            std::os::unix::fs::symlink("/tmp/target", &full).expect("symlink");
            #[cfg(windows)]
            std::os::windows::fs::symlink_file("target", &full).expect("symlink");
            index.add_path(&changed_path).expect("stage symlink");
            index.write().expect("index write");
            let tree_oid = index.write_tree().expect("tree");
            let tree = inner.find_tree(tree_oid).expect("tree");
            let sig = git2::Signature::now("test", "test@example.invalid").expect("sig");
            let parent = inner
                .head()
                .expect("head")
                .peel_to_commit()
                .expect("parent");
            let oid = inner
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "delete+typechange",
                    &tree,
                    &[&parent],
                )
                .expect("commit");
            let mut bytes = [0u8; 20];
            bytes.copy_from_slice(oid.as_bytes());
            bytes
        };

        let changes = repo.diff_changed_refs(before, after).expect("diff");
        assert!(
            changes
                .removed
                .iter()
                .any(|reference| reference.name.as_str().ends_with("gone")),
            "deleted memory must be reported as removed: {:?}",
            changes.removed
        );
        assert!(
            changes
                .removed
                .iter()
                .any(|reference| reference.name.as_str().ends_with("changed")),
            "typechanged memory must lose its old entry: {:?}",
            changes.removed
        );
        assert!(
            changes.unresolved > 0,
            "a symlink's blob cannot resolve to a memory reference"
        );
    }
}

/// Remaining failure paths: unreadable memory files and SSH pulls that must
/// not consume the HTTPS token path.
#[cfg(test)]
mod failure_path_tests {
    use super::*;
    use crate::types::{Memory, MemoryMetadata, Scope};
    use std::sync::Arc;

    #[tokio::test]
    async fn unreadable_memory_file_is_reported_and_propagated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Arc::new(MemoryRepo::init_or_open(dir.path(), None).expect("repo"));
        std::fs::create_dir_all(dir.path().join("global")).expect("global dir");
        // Invalid UTF-8 makes the file unreadable as markdown.
        std::fs::write(dir.path().join("global/bad.md"), [0xff, 0xfe, 0xfd])
            .expect("write invalid utf-8");

        let err = repo
            .read_memory("bad", &Scope::Root)
            .await
            .expect_err("non-UTF-8 memory must fail to read");
        assert!(matches!(err, MemoryError::Io(_)), "{err:?}");
    }

    #[tokio::test]
    async fn ssh_pull_skips_https_token_resolution() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Arc::new(
            MemoryRepo::init_or_open(dir.path(), Some("ssh://git@127.0.0.1:1/memory.git"))
                .expect("repo"),
        );
        let memory = Memory::new(
            "seed",
            "seed content",
            MemoryMetadata::new(Scope::Root, vec![], None),
        )
        .expect("memory");
        repo.save_memory(&memory).await.expect("save");

        // Port 1 refuses immediately, so the failure is at the transport —
        // never at credential selection, which SSH remotes resolve by key/agent.
        // A blank `PALI_GIT_TOKEN` keeps the HTTPS branch inert either way.
        let error = repo
            .pull("main")
            .await
            .expect_err("connection to port 1 must fail");
        assert!(matches!(error, MemoryError::Git(_)), "{error:?}");
    }
}

// Regression guard: ed25519 SSH auth on Windows requires the OpenSSL
// backend. Without `libssh2-sys/openssl-on-win32`, libssh2 uses WinCNG on
// Windows, which lacks ed25519 support and causes auth failures.
//
// `libssh2-sys`'s build script does not emit a `cargo:rustc-cfg` for the
// backend choice, so the guard asserts the observable consequence: the
// OpenSSL branch links the vendored static `ssl`/`crypto` (and `advapi32`)
// libraries, while the WinCNG branch links none of them. The build output
// lives in `<profile>/build/libssh2-sys-*/output`, located relative to the
// test executable (which sits in `<profile>/deps`).
#[cfg(windows)]
#[test]
fn ssh_uses_openssl_backend_on_windows() {
    let exe = std::env::current_exe().expect("test runs with a current exe");
    // <profile>/deps/pali-<hash>.exe -> <profile>/build
    let build_root = exe
        .parent()
        .and_then(|p| p.parent())
        .expect("exe is in <profile>/deps")
        .join("build");
    // The build dir can hold several `libssh2-sys` variants (one per feature
    // combination); the one the binary actually links is the OpenSSL build, so
    // at least one output must carry the directives.
    let outputs = std::fs::read_dir(&build_root)
        .expect("read <profile>/build")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("libssh2-sys-"))
        .filter_map(|e| std::fs::read_to_string(e.path().join("output")).ok())
        .collect::<Vec<_>>();
    assert!(
        !outputs.is_empty(),
        "no libssh2-sys build output found under {build_root:?}"
    );
    let directives = [
        "cargo:rustc-link-lib=static=libssl",
        "cargo:rustc-link-lib=static=libcrypto",
        "cargo:rustc-link-lib=advapi32",
    ];
    let has_openssl = outputs.iter().any(|output| {
        directives
            .iter()
            .all(|d| output.lines().any(|line| line.trim() == *d))
    });
    assert!(
        has_openssl,
        "no libssh2-sys build output links the OpenSSL backend \
         (openssl-on-win32); ed25519 SSH auth would fall back to WinCNG"
    );
}
