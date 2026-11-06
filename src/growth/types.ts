export const GROWTH_KINDS = ['strength', 'improve'] as const;
export type GrowthKind = (typeof GROWTH_KINDS)[number];

export const GROWTH_AREAS = [
  'planning', 'briefing', 'testing', 'reviewing', 'understanding',
  'finishing', 'git', 'security', 'deploying', 'product',
] as const;
export type GrowthArea = (typeof GROWTH_AREAS)[number];

export const GROWTH_AREA_LABELS: Record<GrowthArea, string> = {
  planning: 'Planning and scope',
  briefing: 'Briefing the AIs',
  testing: 'Testing and checking',
  reviewing: 'Reviewing AI work',
  understanding: 'Understanding the code',
  finishing: 'Finishing',
  git: 'Git and backups',
  security: 'Security',
  deploying: 'Deploying and running',
  product: 'Design and product sense',
};

export const REACTIONS = ['agree', 'disagree', 'dismiss'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Longest "what happened", in characters. */
export const MAX_WHAT = 500;
/** Longest "what to practise", in characters. */
export const MAX_PRACTISE = 300;
/** New observations one assistant may save in any 24 hours (merges don't count). */
export const DAILY_CAP = 4;
/** A repeat merges only into an observation with evidence this recent. */
export const MERGE_DAYS = 60;

/** Something an assistant noticed about how the owner works. Never a memory: its own tables, never in recall or the profile. */
export interface Observation {
  id: string;
  kind: GrowthKind;
  area: GrowthArea;
  project: string | null;
  summary: string;
  practise: string | null;
  evidenceCount: number;
  reaction: Reaction | null;
  reactedAt: string | null;
  createdAt: string;
  createdBy: string;
  lastEvidenceAt: string;
}

export interface Evidence {
  id: number;
  what: string;
  project: string | null;
  addedBy: string;
  addedAt: string;
}

export class GrowthError extends Error {
  constructor(public code: 'invalid' | 'not_found' | 'limit', message: string) {
    super(message);
    this.name = 'GrowthError';
  }
}
