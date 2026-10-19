export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (lvl: Exclude<LogLevel, 'silent'>) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (order[lvl] < order[level]) return;
    sink(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...fields }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = createLogger('silent');
