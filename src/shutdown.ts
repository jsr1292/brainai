import type { Server } from 'node:http';

/** Connections still open this long after a signal are cut, well inside Docker's 10 s stop timeout. */
const FORCE_CLOSE_MS = 4000;
/** The whole stop, from the signal: well inside the desktop shell's 7 s grace and Docker's 10 s. */
const DEADLINE_MS = 5000;

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
  /** Resolves when work that must not be cut short (a backup) has ended, or a few seconds have passed. */
  waitIdle?: () => Promise<void>;
  /** Test seam: the whole-stop deadline. */
  deadlineMs?: number;
  proc?: Pick<NodeJS.EventEmitter, 'on'>;
  exit?: (code: number) => void;
}): void {
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(o.timer);
    // The desktop shell gives a stop about 7 s: closing the server and waiting for a running backup share ONE deadline
    // counted from the signal, and the database closes after both, or when the deadline passes.
    const idle = (o.waitIdle?.() ?? Promise.resolve()).catch(() => {});
    const closed = new Promise<void>((resolve) => { o.server.close(() => resolve()); });
    let finished = false;
    const finish = () => { if (finished) return; finished = true; try { o.db.close(); } catch { /* exiting anyway */ } exit(0); };
    setTimeout(finish, o.deadlineMs ?? DEADLINE_MS).unref();
    void Promise.all([closed, idle]).then(finish);
    for (const s of o.also ?? []) { s.close(); s.closeAllConnections(); }
    o.server.closeIdleConnections();
    setTimeout(() => o.server.closeAllConnections(), FORCE_CLOSE_MS).unref();
  };
  const proc = o.proc ?? process;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) proc.on(signal, () => stop(signal));
}
