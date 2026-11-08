import type { Readable } from 'node:stream';

/**
 * The desktop app runs the server as its child with APP_PARENT=stdin and keeps the child's stdin open. If the app
 * goes away in any way (Quit, a crash, Force Quit), the pipe closes and `gone` runs, so the server never outlives it
 * (D2). Anything written on the pipe is ignored. Returns whether it is watching.
 */
export function watchParent(env: NodeJS.ProcessEnv, stdin: Readable, gone: () => void): boolean {
  if (env.APP_PARENT !== 'stdin') return false;
  let done = false;
  const once = () => { if (!done) { done = true; gone(); } };
  stdin.on('data', () => {});
  stdin.once('end', once);
  stdin.once('close', once);
  stdin.resume();
  return true;
}
