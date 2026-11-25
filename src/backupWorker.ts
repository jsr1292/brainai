/** The worker thread of offThread.ts: runs one backup task and posts the result or the error. */
import { parentPort, workerData } from 'node:worker_threads';
import { finishDraft, syncPictureFiles, missingPictureCount, readCounts, moveAcrossDisks, type GonePicture } from './backupWork.js';
import { BackupCopy } from './desktop/backupCopy.js';
import type { WorkerReply } from './offThread.js';

const { task, args } = workerData as { task: string; args: unknown[] };
parentPort?.postMessage({ started: true });
let reply: WorkerReply;
try {
  let value: unknown;
  if (task === 'finishDraft') finishDraft(args[0] as string, args[1] as string, args[2] as string);
  else if (task === 'syncPictures') syncPictureFiles(args[0] as string, args[1] as string, args[2] as GonePicture[], args[3] as boolean);
  else if (task === 'missingPictures') value = missingPictureCount(args[0] as string, args[1] as { id: string; type: string }[]);
  else if (task === 'readCounts') value = readCounts(args[0] as string);
  else if (task === 'moveAcrossDisks') moveAcrossDisks(args[0] as string, args[1] as string);
  else if (task === 'copyRun') {
    const [file, keep, now, id, pictures, folder, written] = args as [string, number, string, string, { gone: GonePicture[]; dataDir: string } | undefined, string, string[] | null];
    value = new BackupCopy('').work(file, keep, new Date(now), id, pictures, folder, written);
  } else throw new Error(`Unknown backup task ${task}`);
  reply = { ok: true, value };
} catch (e) {
  reply = { ok: false, error: { message: e instanceof Error ? e.message : String(e), code: (e as NodeJS.ErrnoException)?.code, name: e instanceof Error ? e.name : undefined, stack: e instanceof Error ? e.stack : undefined } };
}
parentPort?.postMessage(reply);
