/*
 * The online reranker: OpenRouter's /api/v1/rerank. Each search sends the question and the best matches' text to the
 * service the owner chose, so every request says `data_collection: deny` (and `zdr: true` for the zero-retention
 * model). The key is read at each call from where the owner keeps it and goes only in the Authorization header.
 * Problems are told in plain words that hold neither the key nor any memory text; withFallback keeps recall working
 * with the local order when the service is down, refuses the key, is out of credit or is too slow.
 */
import type { Reranker } from './reranker.js';

const URL = 'https://openrouter.ai/api/v1/rerank';

/** A problem fit to show the owner: written here, never made of what the service or the network said. */
class OnlineProblem extends Error {}
/** Skipped during the rest after a failure: the problem already shown stays. */
class RestingProblem extends Error {}

export interface OpenRouterOptions {
  /** Read at each call, so a replaced or removed key takes effect at once. */
  apiKey: () => string | null;
  model: string;
  /** Zero retention: only providers that keep nothing. */
  zdr?: boolean;
  fetch?: typeof fetch;
  /** The whole call, answer included (default 3 s: recall waits for it). */
  timeoutMs?: number;
  onProblem?: (plain: string) => void;
  onOk?: () => void;
  /** After a failure the service is not called for this long (default 60 s), so an outage costs one wait, not one per search. */
  coolOffMs?: number;
  now?: () => number;
}

export function createOpenRouterReranker(o: OpenRouterOptions): Reranker {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  /** When the rest ends, and the key it began with (a replaced key ends it: it may be the cure). */
  let resting: { until: number; key: string | null } | null = null;
  const call = async (query: string, texts: string[]): Promise<number[]> => {
    const key = o.apiKey();
    if (key === null) throw new OnlineProblem('there is no OpenRouter key saved');
    if (resting && resting.key === key && now() < resting.until) throw new RestingProblem();
    const ctrl = new AbortController();
    const ms = o.timeoutMs ?? 3000;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new OnlineProblem('OpenRouter did not answer in time')); }, ms);
    });
    const work = (async () => {
      let res: Response;
      try {
        res = await f(URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: o.model, query, documents: texts, provider: { data_collection: 'deny', ...(o.zdr ? { zdr: true } : {}) } }),
          signal: ctrl.signal,
        });
      } catch {
        throw new OnlineProblem('BrainAI could not reach OpenRouter');
      }
      if (res.status === 401 || res.status === 403) throw new OnlineProblem('the OpenRouter key was refused');
      if (res.status === 402) throw new OnlineProblem('OpenRouter says you are out of credit');
      if (res.status === 429) throw new OnlineProblem('OpenRouter is limiting requests for now');
      if (!res.ok) throw new OnlineProblem('OpenRouter had a problem and could not rerank');
      let j: { results?: { index: number; relevance_score: number }[] };
      try {
        j = await res.json() as typeof j;
      } catch {
        throw new OnlineProblem('OpenRouter sent an answer BrainAI could not read');
      }
      const out = texts.map(() => 0);
      for (const r of Array.isArray(j.results) ? j.results : []) {
        if (Number.isInteger(r?.index) && r.index >= 0 && r.index < texts.length && Number.isFinite(r.relevance_score)) out[r.index] = r.relevance_score;
      }
      return out;
    })();
    work.catch(() => {}); // when the timer wins, a late failure of `work` is not an unhandled rejection
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async score(query, texts) {
      try {
        const out = await call(query, texts);
        o.onOk?.();
        return out;
      } catch (e) {
        if (!(e instanceof RestingProblem)) {
          o.onProblem?.(e instanceof OnlineProblem ? e.message : 'OpenRouter could not be used');
          const key = o.apiKey();
          if (key !== null) resting = { until: now() + (o.coolOffMs ?? 60_000), key };
        }
        throw new Error('the online reranker is not available');
      }
    },
  };
}

/** The first reranker, or the second when the first fails. */
export function withFallback(primary: Reranker, backup: Reranker): Reranker {
  return {
    async score(query, texts) {
      try { return await primary.score(query, texts); } catch { return backup.score(query, texts); }
    },
    /** One source per recall: if any phrasing fails online, every phrasing is scored by the backup (never a mix). */
    async scoreMany(queries, texts) {
      try {
        const scores: number[][] = [];
        for (const q of queries) scores.push(await primary.score(q, texts));
        return { scores, online: true };
      } catch {
        const scores: number[][] = [];
        for (const q of queries) scores.push(await backup.score(q, texts));
        return { scores, online: false };
      }
    },
  };
}
