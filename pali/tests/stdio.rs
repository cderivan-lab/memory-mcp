//! Process-level stdio transport.
//!
//! The behavior under test is the transport itself: a client launches Pali as
//! a subprocess and speaks newline-delimited JSON-RPC over stdin/stdout. That
//! requires a real process, so this is a subprocess test rather than an
//! in-process tower test.

#[path = "common/subprocess.rs"]
mod subprocess_support;

use std::{path::Path, process::Stdio, time::Duration};

use rmcp::model::ProtocolVersion;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

/// Generous enough for a first run, which loads (and may download) the
/// embedding model before serving.
const REPLY_TIMEOUT: Duration = Duration::from_secs(180);

struct StdioClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr_path: std::path::PathBuf,
}

impl StdioClient {
    fn spawn(repo: &Path, log_dir: &Path) -> Self {
        let stderr_path = log_dir.join("stdio-stderr.log");
        let stderr = std::fs::File::create(&stderr_path).expect("create stderr capture");
        let mut child = subprocess_support::pali_command()
            .args([
                "serve",
                "--repo-path",
                repo.to_str().expect("utf8 repo path"),
            ])
            // The default config path is user state; tests must not depend on
            // whether the runner has a per-scope remote configured.
            .env("PALI_CONFIG", "")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // A pipe would block the child once it fills; a file keeps the
            // server responsive and leaves the log readable on failure.
            .stderr(Stdio::from(stderr))
            .kill_on_drop(true)
            .spawn()
            .expect("failed to start pali serve");

        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            stderr_path,
        }
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    async fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        let mut frame = message.to_string();
        frame.push('\n');
        stdin
            .write_all(frame.as_bytes())
            .await
            .expect("write request");
        stdin.flush().await.expect("flush request");
    }

    async fn reply(&mut self) -> Value {
        let mut line = String::new();
        let read = tokio::time::timeout(REPLY_TIMEOUT, self.stdout.read_line(&mut line)).await;
        let bytes = match read {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => panic!("failed reading stdout: {error}; stderr: {}", self.stderr()),
            Err(_) => panic!(
                "timed out waiting for a stdio reply; stderr: {}",
                self.stderr()
            ),
        };
        assert!(
            bytes > 0,
            "server closed stdout before replying; stderr: {}",
            self.stderr()
        );
        serde_json::from_str(&line).unwrap_or_else(|error| {
            panic!(
                "stdout must carry only JSON-RPC frames, got {line:?}: {error}; stderr: {}",
                self.stderr()
            )
        })
    }
}

/// Regression: stdio mode must complete the initialize handshake, list tools,
/// and successfully call one. Tool handlers used to require HTTP request
/// parts, which stdio never injects, so every stdio tool call failed while the
/// handshake and `tools/list` still succeeded — which is why this test
/// exercises a tool call too.
#[tokio::test]
async fn stdio_transport_serves_tool_calls_until_stdin_closes() {
    let repo = tempfile::tempdir().expect("repo tempdir");
    let logs = tempfile::tempdir().expect("log tempdir");
    let mut client = StdioClient::spawn(repo.path(), logs.path());

    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": ProtocolVersion::LATEST.as_str(),
                "capabilities": {},
                "clientInfo": { "name": "pali-stdio-test", "version": "0" },
            },
        }))
        .await;
    let init = client.reply().await;
    assert_eq!(init["id"], 1, "initialize response: {init}");
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "initialize must advertise tools: {init}"
    );

    client
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;

    client
        .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))
        .await;
    let tools = client.reply().await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("tools/list returned no tool array: {tools}"))
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(
        names.contains(&"remember") && names.contains(&"recall"),
        "tools/list is missing expected tools: {names:?}"
    );

    client
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "list", "arguments": {} },
        }))
        .await;
    let listed = client.reply().await;
    assert!(
        listed["error"].is_null(),
        "tools/call over stdio failed: {listed}"
    );
    let text = listed["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("tools/call returned no text content: {listed}"));
    assert!(
        text.contains("\"count\":0"),
        "list over stdio returned an unexpected page: {text}"
    );

    // Closing stdin is how a stdio client ends the session; the server must
    // shut down and persist cleanly instead of hanging.
    drop(client.stdin.take());
    let status = tokio::time::timeout(REPLY_TIMEOUT, client.child.wait())
        .await
        .expect("server did not exit after stdin closed")
        .expect("wait for stdio server");
    assert!(
        status.success(),
        "stdio server exited with {status}; stderr: {}",
        client.stderr()
    );
}
