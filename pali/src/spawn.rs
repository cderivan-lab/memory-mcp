//! Blocking-task spawning with tracing context propagation.

/// Spawn a blocking task with the caller's `tracing::Dispatch` propagated.
///
/// Blocking-pool threads do not inherit the caller's thread-local dispatch,
/// so `Span::current()`, events, and `Span::record()` are silently dropped
/// unless the dispatch is explicitly re-installed. This wrapper captures the
/// current dispatch and sets it as the thread-local default inside the closure.
pub(crate) fn traced_spawn_blocking<F, T>(f: F) -> tokio::task::JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let dispatch = tracing::dispatcher::get_default(|d| d.clone());
    #[allow(clippy::disallowed_methods)]
    tokio::task::spawn_blocking(move || {
        let _guard = tracing::dispatcher::set_default(&dispatch);
        f()
    })
}
