//! End-to-end SSH remote test against a real git server.
//!
//! Ignored by default: it needs an SSH-reachable repository and working
//! credentials (a default key in `~/.ssh` or a loaded ssh-agent). Run it with:
//!
//! ```sh
//! PALI_SSH_TEST_REMOTE=ssh://git@host:2222/org/repo.git \
//!   cargo test --test ssh_remote -- --ignored
//! ```
//!
//! The test pushes a uniquely named branch and deletes it afterwards, so the
//! remote's configured branch is never modified. It exercises libgit2's SSH
//! transport, which `git ls-remote` cannot: the verification and cleanup use
//! the system git only to inspect and remove the pushed ref.

use std::process::Command;
use std::sync::Arc;

use pali::repo::MemoryRepo;
use pali::types::{Memory, MemoryMetadata, Scope};

fn git(args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("failed to run git")
}

#[tokio::test]
#[ignore = "requires PALI_SSH_TEST_REMOTE and SSH credentials"]
async fn push_and_delete_a_branch_over_ssh() {
    let remote = std::env::var("PALI_SSH_TEST_REMOTE")
        .expect("set PALI_SSH_TEST_REMOTE to an ssh:// git remote");

    let dir = tempfile::tempdir().expect("tempdir");
    let repo = Arc::new(MemoryRepo::init_or_open(dir.path(), Some(&remote)).expect("init repo"));

    let memory = Memory::new(
        "ssh-transport-test",
        "memory written by the ssh remote test",
        MemoryMetadata::new(Scope::Root, vec!["test".into()], None),
    )
    .expect("valid memory");
    repo.save_memory(&memory).await.expect("save memory");

    let branch = format!("pali-ssh-test-{}", std::process::id());
    {
        let git_repo = git2::Repository::open(dir.path()).expect("open repo");
        let head = git_repo
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("peel to commit");
        git_repo
            .branch(&branch, &head, false)
            .expect("create test branch");
    }

    // The push under test goes through libgit2's SSH transport. No token is
    // configured, and none is needed: the key file or agent authenticates.
    repo.push(&branch)
        .await
        .unwrap_or_else(|error| panic!("ssh push failed: {error}"));

    let refname = format!("refs/heads/{branch}");
    let listed = git(&["ls-remote", &remote, &refname]);
    assert!(
        listed.status.success(),
        "ls-remote failed: {}",
        String::from_utf8_lossy(&listed.stderr)
    );
    assert!(
        String::from_utf8_lossy(&listed.stdout).contains(&refname),
        "pushed branch is missing from the remote: {}",
        String::from_utf8_lossy(&listed.stdout)
    );

    let deleted = git(&["push", &remote, "--delete", &branch]);
    assert!(
        deleted.status.success(),
        "failed to delete the test branch: {}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    let listed = git(&["ls-remote", &remote, &refname]);
    assert!(
        !String::from_utf8_lossy(&listed.stdout).contains(&refname),
        "test branch is still present after cleanup"
    );
}
