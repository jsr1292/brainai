import type { Clock } from '../clock.js';
import { cosine, type Embedder } from '../memory/embedder.js';
import { looksLikeInjection } from '../memory/instructionLike.js';
import { looksLikeSecret } from '../memory/secrets.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProjectStore } from '../projects/store.js';
import type { GrowthStore } from './store.js';
import {
  DAILY_CAP, GROWTH_AREAS, GROWTH_KINDS, GrowthError, MAX_PRACTISE, MAX_WHAT, MERGE_DAYS, REACTIONS,
  type Evidence, type GrowthArea, type GrowthKind, type Observation, type Reaction,
} from './types.js';

const DAY_MS = 86_400_000;
const invalid = (message: string) => new GrowthError('invalid', message);

function checkText(label: string, value: string, max: number): string {
  const s = value.trim();
  if (s === '') throw invalid(`${label} is empty`);
  if (s.length > max) throw invalid(`${label} is ${s.length} characters; the limit is ${max}`);
  return s;
}

function checkSafe(label: string, s: string): void {
  const secret = looksLikeSecret(s);
  if (secret) throw invalid(`${label} looks like it contains a secret (${secret}). Secrets are never stored.`);
  // The narrow check: observations describe skipped checks and briefing rules, which the full one would refuse.
  const instruction = looksLikeInjection(s);
  if (instruction) throw invalid(`${label} reads like an instruction to assistants (${instruction}), so it isn't saved.`);
}

export type NoteResult = { status: 'saved'; observation: Observation } | { status: 'merged'; observation: Observation };

/** Checks what assistants notice about the owner's way of working, merges repeats into evidence, and caps each assistant. */
export class GrowthService {
  constructor(
    private store: GrowthStore,
    private embedder: Embedder,
    private memories: MemoryService,
    private registry: ProjectStore,
    private memoryStore: MemoryStore,
    private opts: { duplicateThreshold: number },
    private now: Clock,
  ) {}

  private project(name: string | undefined): string | null {
    const raw = name?.trim();
    if (!raw) return null;
    const real = this.memories.projectNamed(raw);
    if (this.registry.get(real) || this.memoryStore.list({ project: real, limit: 1, replaced: 'include' }).length > 0) return real;
    throw invalid(`No project named ${raw}`);
  }

  /** `client` is the connection's OAuth client id: the daily cap counts per connection, since names are not unique. */
  async note(input: { kind: string; area: string; what: string; practise?: string; project?: string }, by: string, client?: string): Promise<NoteResult> {
    if (!(GROWTH_KINDS as readonly string[]).includes(input.kind)) throw invalid(`The kind must be one of: ${GROWTH_KINDS.join(', ')}`);
    if (!(GROWTH_AREAS as readonly string[]).includes(input.area)) throw invalid(`The area must be one of: ${GROWTH_AREAS.join(', ')}`);
    const kind = input.kind as GrowthKind;
    const area = input.area as GrowthArea;
    const what = checkText('What happened', input.what, MAX_WHAT);
    const practiseRaw = input.practise?.trim() ?? '';
    let practise: string | null = null;
    if (kind === 'improve') {
      if (practiseRaw === '') throw invalid('Something to improve needs one concrete thing to practise next');
      practise = checkText('What to practise', practiseRaw, MAX_PRACTISE);
    } else if (practiseRaw !== '') {
      throw invalid('A strength has nothing to practise: leave practise out');
    }
    const project = this.project(input.project);
    checkSafe('What happened', what);
    if (practise) checkSafe('What to practise', practise);

    const embedding = await this.embedder.embed(what, 'passage');
    const since = new Date(this.now().getTime() - MERGE_DAYS * DAY_MS).toISOString();
    let best: { id: string; score: number } | undefined;
    // Observations keep the project name they were filed under; one renamed or made an alias since is still this project.
    const names = project === null ? [null] : [project, ...this.memories.aliases().filter((x) => x.project === project).map((x) => x.alias)];
    for (const c of names.flatMap((name) => this.store.candidates(kind, area, name, since))) {
      const score = cosine(embedding, c.embedding);
      if (score >= this.opts.duplicateThreshold && (!best || score > best.score)) best = { id: c.observation.id, score };
    }
    if (best) return { status: 'merged', observation: this.store.addEvidence(best.id, { what, project, by }) };

    const dayAgo = new Date(this.now().getTime() - DAY_MS).toISOString();
    if ((client === undefined ? this.store.createdBySince(by, dayAgo) : this.store.createdByClientSince(client, by, dayAgo)) >= DAILY_CAP) {
      throw new GrowthError('limit', `Already ${DAILY_CAP} observations from you today: keep only the most notable ones`);
    }
    return { status: 'saved', observation: this.store.insert({ kind, area, project, summary: what, practise, embedding, by, client }) };
  }

  /** The owner's reaction to an observation; null clears it. */
  react(id: string, reaction: Reaction | null): Observation {
    if (reaction !== null && !(REACTIONS as readonly string[]).includes(reaction)) throw invalid(`The reaction must be one of: ${REACTIONS.join(', ')}`);
    return this.store.react(id, reaction);
  }

  /** Week › Growth: how many there are and how many of each kind still count, without reading any evidence. */
  counts(): { total: number; strengths: number; improve: number } {
    return this.store.counts();
  }

  /** One observation under its project's current name. */
  get(id: string): Observation | undefined {
    const o = this.store.get(id);
    return o && { ...o, project: o.project === null ? null : this.memories.projectNamed(o.project) };
  }

  /** Every observation with its evidence, newest evidence first, under each project's current name. */
  list(): { observation: Observation; evidence: Evidence[] }[] {
    const current = (p: string | null): string | null => (p === null ? null : this.memories.projectNamed(p));
    return this.store.list().map((o) => ({
      observation: { ...o, project: current(o.project) },
      evidence: this.store.evidence(o.id).map((e) => ({ ...e, project: current(e.project) })),
    }));
  }
}
