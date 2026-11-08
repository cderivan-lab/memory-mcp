//! Integration tests for the memory repository — save, read, list, pull, delete, move.
//!
//! The `push_pull_with_bare_remote` test exercises the full push/pull path
//! through a `file://` bare remote.

use std::sync::Arc;

#[cfg(unix)]
use pali::error::MemoryError;
use pali::repo::MemoryRepo;
use pali::types::{Memory, MemoryMetadata, MemoryName, PullResult, Scope};

/// Full round-trip: init repo → save memory → read it back → list → delete → pull.
///
/// Because no remote is configured, `pull` returns `PullResult::NoRemote`
/// without touching the network.
#[tokio::test]
async fn repo_round_trip_local_only() {
    let tmp = tempfile::tempdir().unwrap();
    let repo =
        Arc::new(MemoryRepo::init_or_open(tmp.path(), None).expect("should init fresh repo"));

    // Save a memory.
    let metadata = MemoryMetadata::new(Scope::Root, vec!["test".into()], None);
    let memory = Memory::new("test-memory", "Hello from integration test.", metadata).unwrap();
    repo.save_memory(&memory)
        .await
        .expect("save should succeed");

    // Read it back.
    let loaded = repo
        .read_memory("test-memory", &Scope::Root)
        .await
        .expect("read should find the memory");
    assert_eq!(loaded.name.as_str(), "test-memory");
    assert_eq!(loaded.content, "Hello from integration test.");

    // List all memories.
    let list = repo.list_memories(None).await.expect("list should succeed");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name.as_str(), "test-memory");

    // Pull with no remote configured.
    let pull_result = repo.pull("main").await.expect("pull should succeed");
    assert!(
        matches!(pull_result, PullResult::NoRemote),
        "expected NoRemote since we didn't configure origin, got: {pull_result:?}",
    );

    // Delete the memory.
    repo.delete_memory("test-memory", &Scope::Root)
        .await
        .expect("delete should succeed");

    // Verify it's gone.
    let list_after = repo.list_memories(None).await.expect("list should succeed");
    assert!(list_after.is_empty(), "memory should be deleted");
}

/// Push and pull against a `file://` bare remote.
///
/// `file://` remotes need no credentials, but the git2
/// `RemoteCallbacks::credentials` closure is still exercised, proving the
/// callback path reaches the transport without a token being configured.
#[tokio::test]
async fn push_pull_with_bare_remote() {
    // Set up a bare remote.
    let remote_dir = tempfile::tempdir().unwrap();
    git2::Repository::init_bare(remote_dir.path()).expect("failed to init bare repo");
    // Forward slashes are required for a `file://` URL on Windows.
    let remote_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));

    // Init a local repo with origin pointing at the bare remote.
    let local_dir = tempfile::tempdir().unwrap();
    let repo = Arc::new(
        MemoryRepo::init_or_open(local_dir.path(), Some(&remote_url))
            .expect("should init local repo with remote"),
    );

    // Save a memory so there's something to push.
    let metadata = MemoryMetadata::new(Scope::Root, vec!["push-test".into()], None);
    let memory = Memory::new("push-memory", "Content for push test.", metadata).unwrap();
    repo.save_memory(&memory)
        .await
        .expect("save should succeed");

    // Push to the bare remote.
    repo.push("main").await.expect("push should succeed");

    // Verify the bare remote received the commit.
    let bare = git2::Repository::open_bare(remote_dir.path()).unwrap();
    let head = bare.find_reference("refs/heads/main").unwrap();
    let commit = head.peel_to_commit().unwrap();
    assert!(
        commit.message().unwrap().contains("push-memory"),
        "bare remote should contain a commit mentioning the memory name",
    );

    // Pull into a fresh clone to verify the round-trip.
    let clone_dir = tempfile::tempdir().unwrap();
    let clone_repo = Arc::new(
        MemoryRepo::init_or_open(clone_dir.path(), Some(&remote_url))
            .expect("should init clone repo"),
    );
    let pull_result = clone_repo.pull("main").await.expect("pull should succeed");
    assert!(
        matches!(
            pull_result,
            PullResult::FastForward { .. } | PullResult::Merged { .. }
        ),
        "expected FastForward or Merged pull, got: {pull_result:?}",
    );

    // The cloned repo should have the memory.
    let memories = clone_repo
        .list_memories(None)
        .await
        .expect("list should succeed");
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].name.as_str(), "push-memory");
    assert_eq!(memories[0].content, "Content for push test.");
}

/// Push via `git://` to a daemon whose bare remote has an `update` hook
/// that rejects all ref updates.
///
/// This exercises the `push_update_reference` callback path — the fix for
/// issue #81. Unlike `file://` transport, the git smart protocol runs
/// server-side hooks and reports per-ref rejection status through the
/// callback. Our code collects those rejections and surfaces them as
/// `MemoryError::PushRejected`.
#[cfg(unix)]
#[tokio::test]
async fn push_rejected_by_server_hook() {
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Child, Command, Stdio};

    /// RAII guard that kills `git daemon` on drop.
    struct GitDaemon(Child);
    impl Drop for GitDaemon {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// Ports probed before giving up. The probe socket is closed before the
    /// daemon starts, so a busy runner can hand the port to another process in
    /// that window; retrying turns a lost race into a slower start instead of
    /// a failed test.
    const DAEMON_ATTEMPTS: usize = 5;

    /// Start `git daemon` on a probed free port and wait for its readiness
    /// line, retrying on a fresh port while startup fails.
    ///
    /// Returns the guard and the port the daemon actually accepted. The guard
    /// keeps the daemon alive for the caller and reaps it when dropped, which
    /// is also how a failed attempt is cleaned up before the next one.
    fn start_git_daemon(base_path: &std::path::Path) -> (GitDaemon, u16) {
        let mut last_output = String::new();
        for _ in 0..DAEMON_ATTEMPTS {
            let port = {
                let listener = TcpListener::bind("127.0.0.1:0").expect("probe port");
                listener.local_addr().expect("probe addr").port()
            };

            // --verbose makes the daemon print "Ready to rumble" to stderr once
            // it has bound the port and is accepting connections.
            let mut child = Command::new("git")
                .args([
                    "daemon",
                    "--verbose",
                    "--reuseaddr",
                    "--listen=127.0.0.1",
                    &format!("--port={port}"),
                    &format!("--base-path={}", base_path.display()),
                    "--enable=receive-pack",
                    "--export-all",
                    &base_path.to_string_lossy(),
                ])
                .stderr(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .expect("failed to start git daemon — is git installed?");

            let stderr = child.stderr.take().expect("daemon stderr");
            let daemon = GitDaemon(child);
            let mut lines = BufReader::new(stderr).lines();
            let mut startup = String::new();
            let mut ready = false;
            for line in &mut lines {
                let line = line.unwrap_or_default();
                if line.contains("Ready to rumble") {
                    ready = true;
                    break;
                }
                startup.push_str(&line);
                startup.push('\n');
            }

            if ready {
                // Keep draining stderr in the background so verbose logging
                // cannot fill the pipe buffer and block the daemon.
                std::thread::spawn(move || for _ in lines {});
                return (daemon, port);
            }

            // The daemon exited before accepting connections (usually a lost
            // race for the port). Drop reaps it before the next attempt.
            last_output = startup;
            drop(daemon);
        }
        panic!("git daemon never became ready after {DAEMON_ATTEMPTS} attempts:\n{last_output}");
    }

    // Set up a bare remote with an `update` hook that rejects all pushes.
    let remote_dir = tempfile::tempdir().unwrap();
    git2::Repository::init_bare(remote_dir.path()).expect("failed to init bare repo");

    let hooks_dir = remote_dir.path().join("hooks");
    fs::create_dir_all(&hooks_dir).unwrap();
    let hook_path = hooks_dir.join("update");
    fs::write(
        &hook_path,
        "#!/bin/sh\necho \"branch protection: PRs required\" >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o755)).unwrap();

    let base_path = remote_dir.path().parent().unwrap();
    let (_daemon, port) = start_git_daemon(base_path);

    // Build the git:// URL pointing at the bare repo.
    let repo_name = remote_dir.path().file_name().unwrap().to_string_lossy();
    let remote_url = format!("git://127.0.0.1:{port}/{repo_name}");

    // Init a local repo, save a memory, and push.
    let local_dir = tempfile::tempdir().unwrap();
    let repo = Arc::new(
        MemoryRepo::init_or_open(local_dir.path(), Some(&remote_url))
            .expect("should init local repo"),
    );

    let metadata = MemoryMetadata::new(Scope::Root, vec!["rejected".into()], None);
    let memory = Memory::new("rejected-memory", "This push should be rejected.", metadata).unwrap();
    repo.save_memory(&memory)
        .await
        .expect("save should succeed");

    let result = repo.push("main").await;
    assert!(result.is_err(), "push to a rejecting remote should fail");
    let err = result.unwrap_err();
    assert!(
        matches!(err, MemoryError::PushRejected(_)),
        "expected PushRejected, got: {err:?}",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("refs/heads/main"),
        "rejection should name the rejected ref, got: {msg}",
    );
}

/// Move a memory to a different scope with a new name via `repo.move_memory`.
#[tokio::test]
async fn move_memory_with_rename() {
    let tmp = tempfile::tempdir().unwrap();
    let repo =
        Arc::new(MemoryRepo::init_or_open(tmp.path(), None).expect("should init fresh repo"));

    let from_scope: Scope = "project-a".parse().unwrap();
    let to_scope: Scope = "project-b".parse().unwrap();

    // Save a memory.
    let metadata = MemoryMetadata::new(from_scope.clone(), vec!["rename-test".into()], None);
    let memory = Memory::new("old-name", "Content for rename test.", metadata).unwrap();
    repo.save_memory(&memory)
        .await
        .expect("save should succeed");

    let new_name = MemoryName::new("new-name").unwrap();
    repo.move_memory("old-name", &from_scope, &new_name, &to_scope)
        .await
        .expect("move should succeed");

    // Old name in old scope is gone.
    assert!(repo.read_memory("old-name", &from_scope).await.is_err());

    // New name in new scope exists with correct content.
    let loaded = repo
        .read_memory("new-name", &to_scope)
        .await
        .expect("renamed memory should exist");
    assert_eq!(loaded.content, "Content for rename test.");
    assert_eq!(loaded.metadata.tags, vec!["rename-test".to_string()]);
}

/// Exercise `repo.move_memory` directly — single-commit atomicity.
///
/// Verifies that after a successful move the source is gone, the
/// destination exists with correct content, and the git log shows
/// exactly one new commit (not two).
#[tokio::test]
async fn repo_move_memory_atomic_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let repo =
        Arc::new(MemoryRepo::init_or_open(tmp.path(), None).expect("should init fresh repo"));

    let from_scope = Scope::Root;
    let to_scope: Scope = "target-project".parse().unwrap();

    // Save source memory (creates first commit after init).
    let metadata = MemoryMetadata::new(
        from_scope.clone(),
        vec!["atomic".into()],
        Some("test".into()),
    );
    let source = Memory::new("atomic-mem", "Atomic move content.", metadata).unwrap();
    repo.save_memory(&source)
        .await
        .expect("save should succeed");

    // Count commits before move.
    let pre_move_commits = {
        let git = git2::Repository::open(tmp.path()).unwrap();
        let mut revwalk = git.revwalk().unwrap();
        revwalk.push_head().unwrap();
        revwalk.count()
    };

    // Move via the repo method.
    let dest_name = MemoryName::new("atomic-mem").unwrap();
    let dest = repo
        .move_memory("atomic-mem", &from_scope, &dest_name, &to_scope)
        .await
        .expect("move should succeed");

    // Returned memory has correct content and metadata.
    assert_eq!(dest.content, "Atomic move content.");
    assert_eq!(dest.metadata.tags, vec!["atomic".to_string()]);
    assert_eq!(dest.metadata.source.as_deref(), Some("test"));

    // Source should be gone.
    assert!(
        repo.read_memory("atomic-mem", &from_scope).await.is_err(),
        "source should be deleted"
    );

    // Destination should be readable from repo.
    let loaded = repo
        .read_memory("atomic-mem", &to_scope)
        .await
        .expect("dest should exist");
    assert_eq!(loaded.content, "Atomic move content.");

    // Exactly one new commit should have been created (the move).
    let post_move_commits = {
        let git = git2::Repository::open(tmp.path()).unwrap();
        let mut revwalk = git.revwalk().unwrap();
        revwalk.push_head().unwrap();
        revwalk.count()
    };
    assert_eq!(
        post_move_commits,
        pre_move_commits + 1,
        "move should produce exactly one git commit"
    );
}

/// ADR-0041 compatibility (#293 review, round 6): a repo path spelled with
/// `..` over a not-yet-existing component — `existing/missing/../repo` —
/// worked before startup canonicalization was introduced, so the startup
/// pipeline (canonicalize, then init at the resolved path) must still accept
/// it and land the repo at `existing/repo`.
#[tokio::test]
async fn init_accepts_dot_dot_over_missing_component_in_repo_path() {
    let tmp = tempfile::tempdir().unwrap();
    let existing = tmp.path().canonicalize().unwrap();
    let spelled = tmp.path().join("missing/../repo");

    // Mirrors `run_serve`: canonicalize before opening.
    let resolved = pali::fs_util::canonicalize_allow_missing(&spelled)
        .expect("previously valid spelling must canonicalize");
    assert_eq!(resolved, existing.join("repo"));

    // Repo init at the resolved path succeeds and creates the directory.
    let repo = MemoryRepo::init_or_open(&resolved, None).expect("repo init should succeed");
    assert!(
        existing.join("repo/.git").exists(),
        "repo should be created"
    );
    drop(repo);
}
