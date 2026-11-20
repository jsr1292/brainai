import type { MemoryStore } from '../memory/store.js';
import type { ToolId } from './tools.js';

export type InternetAppId = 'chatgpt' | 'claude-web' | 'grok';
export type AppId = ToolId | InternetAppId;
/** Apps installed on this computer, in screen order (the same list Connect supports). */
export const LOCAL_APPS: readonly ToolId[] = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'opencode'];
/** Apps that run on their makers' computers, in screen order. */
export const INTERNET_APPS: readonly InternetAppId[] = ['chatgpt', 'claude-web', 'grok'];
export type Way = 'reach' | 'server' | 'later';
const WAYS: readonly Way[] = ['reach', 'server', 'later'];

export interface Answer { apps: AppId[]; way: Way | null; dismissed: boolean }
/** The brain switch that holds the answer (JSON). */
export const YOUR_APPS_SWITCH = 'your_apps';

const isApp = (v: unknown): v is AppId => (LOCAL_APPS as readonly unknown[]).includes(v) || (INTERNET_APPS as readonly unknown[]).includes(v);
export const isInternetApp = (v: AppId): v is InternetAppId => (INTERNET_APPS as readonly string[]).includes(v);
export const isWay = (v: unknown): v is Way => (WAYS as readonly unknown[]).includes(v);

/** The stored answer, or null when unset or unreadable. Unknown ids are dropped. */
export function readAnswer(store: Pick<MemoryStore, 'switchValue'>): Answer | null {
  const raw = store.switchValue(YOUR_APPS_SWITCH);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const o = j as { apps?: unknown; way?: unknown; dismissed?: unknown };
    const apps = Array.isArray(o.apps) ? [...new Set(o.apps.filter(isApp))] : [];
    return { apps, way: isWay(o.way) ? o.way : null, dismissed: o.dismissed === true };
  } catch { return null; }
}

/** Stores a new answer, replacing the old one (and clearing a dismissed Home card). */
export function saveAnswer(store: Pick<MemoryStore, 'setSwitch'>, apps: AppId[], way: Way | null): void {
  store.setSwitch(YOUR_APPS_SWITCH, JSON.stringify({ apps, way, dismissed: false }));
}

/** Dismisses the Home card for good (until the next answer). */
export function dismissNext(store: Pick<MemoryStore, 'switchValue' | 'setSwitch'>): void {
  const a = readAnswer(store);
  if (!a) return;
  store.setSwitch(YOUR_APPS_SWITCH, JSON.stringify({ ...a, dismissed: true }));
}

export interface Outcome { works: ToolId[]; notFound: ToolId[]; internet: InternetAppId[]; internetWorks: boolean; ways: Way[] }

export function outcome(apps: AppId[], ctx: { found: ReadonlySet<ToolId>; reachOn: boolean; windows: boolean }): Outcome {
  const local = LOCAL_APPS.filter((id) => apps.includes(id));
  const internet = INTERNET_APPS.filter((id) => apps.includes(id));
  const ways: Way[] = internet.length === 0 || ctx.reachOn ? [] : ctx.windows ? ['server', 'later'] : ['reach', 'server', 'later'];
  return {
    works: local.filter((id) => ctx.found.has(id)),
    notFound: local.filter((id) => !ctx.found.has(id)),
    internet, internetWorks: ctx.reachOn, ways,
  };
}

/** Which Home card (if any) follows from the answer. */
export function nextCard(a: Answer | null, ctx: { reachOn: boolean; moved: boolean }): 'reach' | 'server' | null {
  if (!a || a.dismissed || ctx.moved) return null;
  if (a.way === 'reach') return ctx.reachOn ? null : 'reach';
  if (a.way === 'server') return 'server';
  return null;
}
