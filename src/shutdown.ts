import type { Server } from 'node:http';

/** Connections still open this long after a signal are cut, well inside Docker's 10 s stop timeout. */
const FORCE_CLOSE_MS = 5000;

/**
 * On SIGTERM or SIGINT: stop accepting connections, stop the cleanup timer, let open requests finish,
 * then close the database and exit 0.
 */
export function installShutdown(o: {
  server: Server;
  /** More servers on the same app (local mode's ::1 listener), closed with the first. */
  also?: Server[];
  timer: NodeJS.Timeout;
  db: { close(): void };
  proc?: Pick<NodeJS.EventEmitter, 'on'>;
  exit?: (code: number) => void;
}): void {
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(o.timer);
    for (const s of o.also ?? []) { s.close(); s.closeAllConnections(); }
    o.server.close(() => {
      o.db.close();
      exit(0);
    });
    o.server.closeIdleConnections();
    setTimeout(() => o.server.closeAllConnections(), FORCE_CLOSE_MS).unref();
  };
  const proc = o.proc ?? process;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) proc.on(signal, () => stop(signal));
}
