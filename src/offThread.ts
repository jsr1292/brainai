import { Worker } from 'node:worker_threads';
import { busyTick } from './busyMarker.js';

/**
 * Runs one of the backup tasks in a worker thread, so the server's main thread keeps answering while a big brain is
 * copied, compacted and checked. Each task is a plain function of backupWork.ts / backupCopy.ts that opens what it
 * needs itself (its own SQLite connection, never the server's). The task's own error comes back as an Error with the
 * same message (and `code`); if the worker itself cannot start (a missing file, no threads), `fallback` runs the same
 * work on this thread instead, as before, with the busy marker still up.
 */
export type Task = 'finishDraft' | 'syncPictures' | 'copyRun' | 'missingPictures' | 'readCounts' | 'moveAcrossDisks';

/** `started`: the worker has begun the task (after that a failure of the worker is not retried on this thread: the task may be half done). */
export interface WorkerReply { started?: true; ok?: boolean; value?: unknown; error?: { message: string; code?: string; name?: string; stack?: string } }

/** `.ts` when this module runs from source (tests, `tsx`), `.js` compiled or bundled. */
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './backupWorker.ts' : './backupWorker.js', import.meta.url);

/** Thrown when a task did not end within its time limit and the worker was stopped. */
export class WorkerTimeout extends Error {
  /** Settles when the stopped worker's thread has really ended (it may linger in a call that does not return). */
  exited: Promise<void> = Promise.resolve();
}

export function inWorker<T = void>(task: Task, args: unknown[], fallback: () => T, url: URL = workerUrl, limitMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(url, { workerData: { task, args } });
    } catch (e) {
      console.error('Backup worker could not start, working on the main thread:', e);
      try { resolve(fallback()); } catch (err) { reject(err); }
      return;
    }
    // The marker's time is refreshed while the worker runs (the main thread is free, so this does fire).
    const tick = setInterval(() => busyTick(), 10_000);
    let done = false;
    let started = false;
    const lost = (what: string, e: unknown) => finish(() => {
      if (started) return reject(e instanceof Error ? e : new Error(`The backup worker stopped while working (${what}).`));
      console.error(`Backup worker ${what}, working on the main thread:`, e);
      try { resolve(fallback()); } catch (err) { reject(err); }
    });
    const finish = (fn: () => void) => { if (done) return; done = true; clearInterval(tick); if (limit) clearTimeout(limit); fn(); };
    // A task that never returns (a share that stopped answering) is stopped; the thread may linger until its call returns, but nothing waits for it.
    const limit = limitMs === undefined ? null : setTimeout(() => finish(() => {
      const err = new WorkerTimeout(`The backup worker did not finish within ${Math.round(limitMs / 1000)} seconds and was stopped.`);
      err.exited = new Promise<void>((r) => { worker.once('exit', () => r()); });
      void worker.terminate().catch(() => {});
      reject(err);
    }), limitMs);
    limit?.unref();
    worker.on('message', (m: WorkerReply) => {
      if (m.started) { started = true; return; }
      finish(() => {
        if (m.ok) return resolve(m.value as T);
        const err = new Error(m.error?.message ?? 'The backup worker failed.', { cause: m.error });
        if (m.error?.name) err.name = m.error.name;
        if (m.error?.stack) err.stack = m.error.stack;
        if (m.error?.code) Object.assign(err, { code: m.error.code });
        reject(err);
      });
    });
    worker.once('error', (e) => lost('failed to run', e));
    worker.once('exit', (code) => lost(`stopped (${code})`, new Error(`The backup worker stopped (${code}).`)));
  });
}
