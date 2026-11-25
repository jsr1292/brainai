import { rmSync } from 'node:fs';

/**
 * Removes a fake's temporary folder, best effort, and never throws. Tests call this in an after hook registered before
 * the app's close, and node:test stops a test's after hooks at the first one that throws: a removal that failed (ENOTEMPTY
 * while a process the app started still writes there, such as a fake tunnel saving its state as it stops) skipped the
 * app's close, its server kept listening, and the test file never ended. Retries cover a writer that is just finishing.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* a temporary folder left behind is harmless; a throw here is not */ }
}
