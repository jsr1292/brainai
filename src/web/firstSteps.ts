/**
 * The first-steps checklist on Home (UX review 1.4): what a new brain still needs, ticked as each step is done, until
 * every step is done or the owner hides it. "Hide these steps" is remembered in a small file in the data directory.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appOfGrant } from '../setup/texts.js';
import type { GrantInfo } from '../auth/provider.js';
import { html, type SafeHtml } from './html.js';
import { t } from '../i18n/index.js';

const HIDDEN_FILE = 'first-steps-hidden';
export const firstStepsHidden = (dataDir: string | undefined): boolean => dataDir !== undefined && existsSync(join(dataDir, HIDDEN_FILE));
export function hideFirstSteps(dataDir: string): void {
  writeFileSync(join(dataDir, HIDDEN_FILE), new Date().toISOString());
}

export interface FirstStepsInput {
  /** The app (local mode) or a server: a server has no "added" state, so adding and signing in are one step. */
  localMode: boolean;
  grants: readonly GrantInfo[];
  /** Whether any memory exists. */
  hasMemory: boolean;
  /** The same check as the Home off-site card: a second backup folder, an off-site run or a git copy. */
  backupElsewhere: boolean;
  /** Where "Hide these steps" is remembered; without one the link is left out. */
  canHide: boolean;
}

export interface Step { key: string; label: string; hint?: string; done: boolean; doneNote?: string; href?: string; link?: string; copy?: string; /** Local mode: the page may tick it after asking which tools were added. */ addedTick?: boolean }

/** The live grants' distinct apps: one per assistant, however many times it signed in. */
const appKey = (g: GrantInfo): string => appOfGrant(g.clientName) ?? g.clientName.trim().toLowerCase();

export function firstSteps(i: FirstStepsInput): Step[] {
  const live = i.grants.filter((g) => !g.revokedAt);
  const names = [...new Set(live.map((g) => g.clientName))].slice(0, 2).join(', ');
  const apps = new Set(live.map(appKey));
  const memory: Step = { key: 'memory', label: t('projects.first.memory'), hint: t('projects.first.memoryHint'), copy: t('projects.first.memoryCopy'), done: i.hasMemory };
  const bring: Step = { key: 'import', label: t('projects.first.import'), hint: t('projects.first.importHint'), done: i.hasMemory, href: '/import', link: t('projects.first.importLink') };
  const second: Step = { key: 'second', label: t('projects.first.second'), done: apps.size >= 2, href: '/settings#setup', link: t('projects.first.secondLink') };
  const backup: Step = { key: 'backup', label: i.localMode ? t('projects.first.backupLocal') : t('projects.first.backupServer'), done: i.backupElsewhere, href: i.localMode ? '/settings#backup-copy' : '/settings#health', link: t('projects.first.backupLink') };
  if (!i.localMode) {
    return [{ key: 'connect', label: t('projects.first.connect'), hint: t('projects.first.connectHint'), done: live.length > 0, doneNote: names, href: '/settings#setup', link: t('projects.first.connectLink') }, memory, bring, second, backup];
  }
  return [
    { key: 'add', label: t('projects.first.add'), done: live.length > 0, doneNote: names, href: '/settings#setup', link: t('projects.first.addLink'), addedTick: true },
    { key: 'signin', label: t('projects.first.signin'), hint: t('projects.first.signinHint'), done: live.length > 0, href: '/settings/tools', link: t('projects.first.signinLink') },
    memory, bring, second, backup,
  ];
}

/** Shown while any step is open and the owner has not hidden it. */
export const firstStepsDue = (steps: Step[], hidden: boolean): boolean => !hidden && steps.some((s) => !s.done);

export function firstStepsView(steps: Step[], canHide: boolean, localMode: boolean): SafeHtml {
  return html`<section class="first-steps" aria-labelledby="first-steps-h">
  <h2 id="first-steps-h">${t('projects.first.title')}</h2>
  <p class="first-steps-lede">${t('projects.first.lede')}</p>
  <ol class="first-steps-list">${steps.map((s, n) => html`<li class="fs-item${s.done ? ' is-done' : ''}"${s.addedTick && !s.done && localMode ? html` data-step-added` : ''}>
    <span class="fs-mark" data-n="${n + 1}" aria-hidden="true"></span>
    <span class="fs-text"><span class="fs-label">${s.label}${s.done ? html` <span class="visually-hidden">${t('projects.first.done')}</span>` : ''}</span>${s.hint && !s.done ? html`<span class="fs-hint">${s.hint}</span>` : ''}</span>
    ${s.done ? (s.doneNote ? html`<span class="fs-note">${s.doneNote}</span>` : '')
      : s.copy ? html`<button type="button" class="sm fs-do" data-copy="${s.copy}">${t('projects.first.copy')}</button>`
      : s.href ? html`<a class="fs-do" href="${s.href}">${s.link} ›</a>` : ''}
  </li>`)}</ol>
  ${canHide ? html`<form method="post" action="/first-steps/hide" class="first-steps-hide"><button type="submit" class="linklike">${t('projects.first.hide')}</button></form>` : ''}
</section>`;
}
