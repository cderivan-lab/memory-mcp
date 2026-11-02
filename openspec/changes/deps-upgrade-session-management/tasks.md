# Tasks

- [x] Update Cargo.toml with new dependency versions
- [x] Remove unused dependencies (hf-hub, axum, http, futures-core)
- [x] Add libc dependency (cfg(unix))
- [x] Run `cargo update` to refresh Cargo.lock
- [x] Create src/session.rs with Session and SessionManager
- [x] Integrate SessionManager in src/main.rs
- [x] Integrate SessionManager in src/server.rs
- [x] Fix all compile errors from API changes
- [x] Run cargo check to verify
- [x] Run cargo test to verify no regressions