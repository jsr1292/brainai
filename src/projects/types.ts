/** Where a project belongs in the brain; Personal is private to the owner's own assistants. */
export const AREAS = ['apps', 'home', 'tools', 'work', 'personal'] as const;
export type Area = (typeof AREAS)[number];
export const AREA_LABELS: Record<Area, string> = {
  apps: 'Apps', home: 'Home & infrastructure', tools: 'Tools & AI', work: 'Work', personal: 'Personal',
};

/** Set by the owner only. "On the go" is a pin on an open project; "quiet" is a label, never a state. */
export const STATES = ['idea', 'open', 'parked', 'done', 'archived'] as const;
export type ProjectStateName = (typeof STATES)[number];

/** The home screen's big cards: few enough to stay a focus, not a second list. */
export const MAX_PINNED = 6;

export interface Project {
  name: string;
  oneLiner: string | null;
  area: Area | null;
  state: ProjectStateName;
  stateChangedAt: string;
  pinnedAt: string | null;
  /** Folder name in ~/Projects on the Mac. */
  folder: string | null;
  remotes: string[];
  url: string | null;
  /** Places it runs on ("Runs on"), normalised short names such as minipc or pi. */
  runsOn: string[];
  /** Home-screen suggestions about this project are hidden until then. */
  snoozedUntil: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export class ProjectError extends Error {
  constructor(public code: 'not_found' | 'invalid' | 'pin_limit', message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}
