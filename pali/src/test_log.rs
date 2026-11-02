//! Test-only tracing capture helpers shared across unit-test modules.

use std::{
    io::{self, Write},
    sync::{Arc, Mutex, Once},
};

use tracing::subscriber::with_default;
use tracing_subscriber::{Registry, layer::SubscriberExt};

/// A `Write` sink that appends into a shared buffer.
struct TestWriter(Arc<Mutex<Vec<u8>>>);

impl Write for TestWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Install a permissive global subscriber once per test binary.
///
/// `with_default` installs a *scoped* subscriber, but tracing caches each
/// callsite's interest globally. When a concurrent test reaches a logged code
/// path with no subscriber installed, that callsite can be cached as disabled
/// and later events are dropped even though the capturing subscriber allows
/// them — which made capture assertions fail only in the full parallel suite.
/// A permissive global subscriber writing to a sink keeps every callsite
/// enabled, so a scoped capture can never miss an event.
fn install_global_sink() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let subscriber = Registry::default()
            .with(tracing_subscriber::EnvFilter::new("info"))
            .with(tracing_subscriber::fmt::layer().with_writer(io::sink));
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
}

/// Run `f` with an INFO-level subscriber installed on the current thread and
/// return everything it logged as a string.
pub(crate) fn capture_info_logs(f: impl FnOnce()) -> String {
    install_global_sink();
    let output = Arc::new(Mutex::new(Vec::new()));
    let writer_output = Arc::clone(&output);
    let subscriber = Registry::default()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(move || TestWriter(Arc::clone(&writer_output))),
        );
    with_default(subscriber, f);
    let bytes = output.lock().expect("log buffer").clone();
    String::from_utf8(bytes).expect("UTF-8 logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_flush_is_a_noop() {
        let mut writer = TestWriter(Arc::new(Mutex::new(Vec::new())));
        writer.write_all(b"hello").unwrap();
        writer.flush().unwrap();
        assert_eq!(&*writer.0.lock().unwrap(), b"hello");
    }
}
