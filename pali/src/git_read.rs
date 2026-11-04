//! Read-only git access backed by `gix`.
//!
//! The crate keeps libgit2 (`git2`) for the operations gitoxide does not yet
//! provide in a shippable form — merge, push, fetch, commit and checkout — and
//! uses `gix` for everything that only reads repository state: resolving HEAD,
//! comparing two commits' trees, and reading blobs out of a tree.
//!
//! See ADR-0053 for why the split falls where it does. The seam is deliberate:
//! this module is the only place that speaks `gix` types, and it hands back
//! plain paths, byte buffers and a [`ChangeKind`], so the repository layer and
//! its error type stay independent of the reader.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::MemoryError;

/// How a tracked path differs between two commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChangeKind {
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
pub(crate) struct TreeChange {
    /// Repository-relative path, e.g. `global/notes/foo.md`.
    pub path: String,
    /// What happened to the path.
    pub kind: ChangeKind,
    /// Blob content on the older side, when the path was a blob there.
    pub old_blob: Option<Vec<u8>>,
    /// Blob content on the newer side, when the path is a blob there.
    pub new_blob: Option<Vec<u8>>,
}

/// Resolve `HEAD` to its commit id, or `None` when the branch is unborn.
///
/// An unborn branch (a freshly initialised repository, or a branch ref removed
/// from outside) has no id to report; every other failure is also reported as
/// `None`, matching the previous libgit2 behaviour, which treated a missing
/// HEAD as "no commit yet" rather than an operational fault.
pub(crate) fn head_sha(root: &Path) -> Option<String> {
    let repo = gix::open(root).ok()?;
    repo.head_id().ok().map(|id| id.to_string())
}

/// Repository-relative paths of files that are untracked and not ignored.
///
/// This is the scanner's enumeration: git's own view of "new file", with
/// `.gitignore` applied and untracked directories expanded to the files they
/// contain. libgit2 answered this before; the parity test in the scanner pins
/// both implementations to the same set so the two cannot drift apart.
pub(crate) fn untracked_files(root: &Path) -> Result<Vec<String>, MemoryError> {
    let repo = gix::open(root)?;
    let platform = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files);

    let mut paths = Vec::new();
    for item in platform.into_iter(None)? {
        let item = item?;
        if let gix::status::Item::IndexWorktree(
            gix::status::index_worktree::Item::DirectoryContents { entry, .. },
        ) = item
            && entry.status == gix::dir::entry::Status::Untracked
        {
            paths.push(entry.rela_path.to_string());
        }
    }
    Ok(paths)
}

/// Compare the trees of two commits and return the memory files that changed.
///
/// `old_oid` may be `[0u8; 20]` for an unborn branch, in which case every file
/// in the newer tree is reported as added. Only `.md` files under `global/` or
/// `projects/` are returned: those are the namespace directories the memory
/// store owns.
///
/// Blob content is read eagerly for the returned files. A memory store's diff
/// touches a handful of small markdown files, and callers that need to parse
/// frontmatter would otherwise reopen the repository once per file.
pub(crate) fn changed_files(
    root: &Path,
    old_oid: [u8; 20],
    new_oid: [u8; 20],
) -> Result<Vec<TreeChange>, MemoryError> {
    let repo = gix::open(root)?;
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

/// Decode the 20-byte ids this crate passes around into a gix object id.
///
/// The crate's public change-set surface is defined in terms of raw 20-byte
/// ids (it predates the read-path port); hex is the stable bridge between that
/// representation and gix's object id, whichever hash kind it is built for.
fn object_id(oid: [u8; 20]) -> Result<gix::ObjectId, MemoryError> {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(40);
    for byte in oid {
        write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    gix::ObjectId::from_hex(hex.as_bytes())
        .map_err(|e| MemoryError::Internal(format!("invalid git object id: {e}")))
}

fn commit_tree(repo: &gix::Repository, oid: [u8; 20]) -> Result<gix::Tree<'_>, MemoryError> {
    let id = object_id(oid)?;
    Ok(repo.find_object(id)?.try_into_commit()?.tree()?)
}

/// A tree's entries keyed by file name, so both sides diff in one pass.
fn entries(
    tree: &gix::Tree<'_>,
) -> Result<BTreeMap<String, (gix::object::tree::EntryMode, gix::ObjectId)>, MemoryError> {
    let mut map = BTreeMap::new();
    for entry in tree.iter() {
        let entry = entry.map_err(MemoryError::gix)?;
        map.insert(
            entry.filename().to_string(),
            (entry.mode(), entry.id().detach()),
        );
    }
    Ok(map)
}

fn diff_trees(
    repo: &gix::Repository,
    old: Option<&gix::Tree<'_>>,
    new: Option<&gix::Tree<'_>>,
    prefix: &str,
    out: &mut Vec<TreeChange>,
) -> Result<(), MemoryError> {
    let old_entries = old.map(entries).transpose()?;
    let new_entries = new.map(entries).transpose()?;
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
                match (old_mode.is_tree(), new_mode.is_tree()) {
                    (true, true) => {
                        let old_tree = repo.find_object(*old_id)?.try_into_tree()?;
                        let new_tree = repo.find_object(*new_id)?.try_into_tree()?;
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
                    (true, false) => {
                        collect_side(repo, *old_mode, *old_id, &path, ChangeKind::Removed, out)?;
                        collect_side(repo, *new_mode, *new_id, &path, ChangeKind::Added, out)?;
                    }
                    (false, true) => {
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

/// Whether two non-tree entries are the same git object kind.
///
/// `100644` and `100755` are both regular files — an executable bit change is
/// an edit, not a type change — while `120000` (symlink) and `160000`
/// (submodule) are different kinds.
fn same_blob_kind(old: gix::object::tree::EntryMode, new: gix::object::tree::EntryMode) -> bool {
    use gix::object::tree::EntryKind;

    // `100644` and `100755` are both regular files: an executable-bit change
    // is an edit, not a type change. Anything else must match exactly.
    let blob = |kind: EntryKind| matches!(kind, EntryKind::Blob | EntryKind::BlobExecutable);
    let old = EntryKind::from(old);
    let new = EntryKind::from(new);
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
    repo: &gix::Repository,
    mode: gix::object::tree::EntryMode,
    id: gix::ObjectId,
    path: &str,
    kind: ChangeKind,
    out: &mut Vec<TreeChange>,
) -> Result<(), MemoryError> {
    if mode.is_tree() {
        let tree = repo.find_object(id)?.try_into_tree()?;
        for entry in tree.iter() {
            let entry = entry.map_err(MemoryError::gix)?;
            let child = join_path(path, &entry.filename().to_string());
            collect_side(repo, entry.mode(), entry.id().detach(), &child, kind, out)?;
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
    repo: &gix::Repository,
    path: &str,
    kind: ChangeKind,
    old_id: Option<gix::ObjectId>,
    new_id: Option<gix::ObjectId>,
) -> Result<Option<TreeChange>, MemoryError> {
    if !is_memory_path(path) {
        return Ok(None);
    }
    Ok(Some(TreeChange {
        path: path.to_string(),
        kind,
        old_blob: old_id.map(|id| blob(repo, id)).transpose()?,
        new_blob: new_id.map(|id| blob(repo, id)).transpose()?,
    }))
}

fn blob(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>, MemoryError> {
    Ok(repo.find_object(id)?.try_into_blob()?.data.to_vec())
}

/// True for `.md` files inside the namespace directories the store owns.
fn is_memory_path(path: &str) -> bool {
    path.ends_with(".md") && (path.starts_with("global/") || path.starts_with("projects/"))
}
