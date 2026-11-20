import type { MemoryStore } from '../memory/store.js';

/** The owner's brain-wide choice (brain_switches): 'on' while developer coaching is on; no row means off. */
export const COACHING_SWITCH = 'developer_coaching';

/** Whether developer coaching (growth notes, the five areas, the handbook) is on in this brain, read each time it is asked. */
export const coachingOn = (store: Pick<MemoryStore, 'switchValue'>): boolean => store.switchValue(COACHING_SWITCH) === 'on';
