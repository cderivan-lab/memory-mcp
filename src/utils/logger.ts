// Level-filtering logger shared by the extension host and the install
// library. Every Pali log line produced by the extension flows through here,
// so the "Pali Memory" output channel carries one consistent, level-filtered
// stream instead of scattered `console.log` calls that are invisible outside
// the extension host.
//
// The same `pali.logLevel` setting also drives the MCP server (`RUST_LOG`)
// and the Copilot hooks (`PALI_HOOK_LOG_LEVEL`), so one knob controls the
// whole project's verbosity.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
};

/** Map a raw setting value to a known level; unknown values fall back to `info`. */
export function normalizeLogLevel(value: unknown): LogLevel {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw in WEIGHT ? (raw as LogLevel) : 'info';
}

/**
 * The `RUST_LOG` filter for the MCP server at a given level. The filter is
 * scoped to the `pali` crate so `debug` does not flood the server with
 * dependency noise (git2, tokio, ...); everything else stays at its default.
 * `info` reproduces the server's built-in default exactly.
 */
export function rustLogFilter(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return 'pali=debug,info';
    case 'info':
      return 'pali=info,warn';
    case 'warn':
      return 'pali=warn';
    case 'error':
      return 'pali=error';
    case 'off':
      return 'off';
  }
}

export type LogSink = (line: string) => void;

class Logger {
  private level: LogLevel = 'info';
  // The extension host replaces this with the output channel; standalone
  // runs (tests, scripts) keep the console.
  private sink: LogSink = (line) => console.log(line);

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Replace the sink, returning the previous one so callers can restore it. */
  setSink(sink: LogSink): LogSink {
    const previous = this.sink;
    this.sink = sink;
    return previous;
  }

  private emit(level: LogLevel, message: string): void {
    if (WEIGHT[level] < WEIGHT[this.level]) return;
    this.sink(
      `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [pali] ${message}`,
    );
  }

  debug(message: string): void {
    this.emit('debug', message);
  }

  info(message: string): void {
    this.emit('info', message);
  }

  /** Install-flow success marker; logged at `info`. */
  success(message: string): void {
    this.emit('info', message);
  }

  warn(message: string): void {
    this.emit('warn', message);
  }

  error(message: string): void {
    this.emit('error', message);
  }
}

export const log = new Logger();
