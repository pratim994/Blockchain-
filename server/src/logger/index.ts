// ============================================================
// server/src/logger/index.ts
//
// Structured, leveled logger.  Outputs JSON in production
// (machine-parseable by Datadog/Splunk) and pretty-prints in dev.
// ============================================================

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level:     Level;
  message:   string;
  timestamp: string;
  service:   string;
  [key: string]: unknown;
}

const isProd = process.env.NODE_ENV === 'production';

function log(level: Level, message: string, meta: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    service:   'blockchain-server',
    ...meta,
  };

  const line = isProd ? JSON.stringify(entry) : prettyPrint(entry);

  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function prettyPrint(entry: LogEntry): string {
  const colors: Record<Level, string> = {
    debug: '\x1b[34m', // blue
    info:  '\x1b[32m', // green
    warn:  '\x1b[33m', // yellow
    error: '\x1b[31m', // red
  };
  const reset = '\x1b[0m';
  const color = colors[entry.level];

  const metaStr = Object.entries(entry)
    .filter(([k]) => !['level', 'message', 'timestamp', 'service'].includes(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');

  return `${color}[${entry.level.toUpperCase()}]${reset} ${entry.timestamp} ${entry.message}${metaStr ? ' | ' + metaStr : ''}`;
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info:  (message: string, meta?: Record<string, unknown>) => log('info',  message, meta),
  warn:  (message: string, meta?: Record<string, unknown>) => log('warn',  message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
