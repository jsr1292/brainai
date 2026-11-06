import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { posesAsOwner } from '../memory/types.js';

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const TOO_LARGE = 'Client metadata document is larger than 64 KB';

/** A failure that may go away on retry (network error, timeout, HTTP 5xx), as opposed to a bad or missing document. */
export class TransientFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientFetchError';
  }
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches and validates a Client ID Metadata Document. Throws Error with a reason on any problem; network errors,
 * timeouts and HTTP 5xx throw TransientFetchError.
 */
export async function fetchClientMetadata(clientIdUrl: string, fetchFn: typeof fetch = fetch): Promise<OAuthClientInformationFull> {
  let u: URL;
  try {
    u = new URL(clientIdUrl);
  } catch {
    throw new Error('Client ID is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('Client ID URL must use https');
  if (u.hash || clientIdUrl.includes('#')) throw new Error('Client ID URL must not contain a fragment');

  let res: Response;
  try {
    res = await fetchFn(clientIdUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    throw new TransientFetchError(`Client metadata fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500) throw new TransientFetchError(`Client metadata fetch failed with status ${res.status}`);
  if (!res.ok) throw new Error(`Client metadata fetch failed with status ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(TOO_LARGE);

  let body: string;
  try {
    body = await readLimited(res);
  } catch (e) {
    if (e instanceof Error && e.message === TOO_LARGE) throw e;
    throw new TransientFetchError(`Client metadata download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error('Client metadata document is not valid JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('Client metadata document must be a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientIdUrl) throw new Error('Client metadata client_id does not match the document URL');
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0) throw new Error('Client metadata must include a non-empty redirect_uris array');
  // The plural field lists every method the client can use; the singular one is only its preference (ChatGPT prefers
  // private_key_jwt but also lists "none"). This server accepts only public clients from a remote document.
  const methods = Array.isArray(d.token_endpoint_auth_methods_supported) ? d.token_endpoint_auth_methods_supported : [d.token_endpoint_auth_method ?? 'none'];
  if (!methods.includes('none')) {
    throw new Error('Client metadata documents must not use a client secret (token_endpoint_auth_method must be "none")');
  }
  d.token_endpoint_auth_method = 'none';
  if (posesAsOwner(d.client_name)) throw new Error('Client metadata client_name must not read as the owner ("owner", "you" or "me")');
  // Never accept secrets from a remote document.
  delete d.client_secret;
  delete d.client_secret_expires_at;
  const parsed = OAuthClientInformationFullSchema.safeParse(d);
  if (!parsed.success) throw new Error(`Client metadata is invalid: ${parsed.error.message}`);
  return parsed.data;
}
