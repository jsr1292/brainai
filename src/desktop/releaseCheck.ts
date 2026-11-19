/**
 * Server mode's "Check for updates": one request to GitHub's latest-release address, made only when the owner presses
 * the button (never on a schedule). Nothing is sent but the request itself and a generic User-Agent.
 */
import { compareVersions } from './updateState.js';

/** Tests point this elsewhere (AppDeps.releaseApiUrl); nothing in the code reaches it without a press. */
export const RELEASE_API_URL = 'https://api.github.com/repos/jsr1292/brainai/releases/latest';
export const RELEASE_PAGE_URL = 'https://github.com/jsr1292/brainai/releases/latest';
const RELEASE_TAG_URL = 'https://github.com/jsr1292/brainai/releases/tag/';
const TIMEOUT_MS = 8000;

export type ReleaseResult =
  | { ok: true; version: string; newer: boolean; url: string }
  | { ok: false; error: string };

/** Asks for the latest release and compares its tag with the running version. Never throws. */
export async function checkLatestRelease(running: string, opts: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<ReleaseResult> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(opts.url ?? RELEASE_API_URL, {
      headers: { 'User-Agent': 'BrainAI update check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}.` };
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag);
    if (!m) return { ok: false, error: 'GitHub did not name a version.' };
    const version = m[1]!;
    return { ok: true, version, newer: compareVersions(version, running) > 0, url: `${RELEASE_TAG_URL}${tag}` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, error: timedOut ? 'GitHub did not answer in time.' : 'GitHub could not be reached.' };
  }
}
