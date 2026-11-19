import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { html, type SafeHtml } from './html.js';
import { formatBytes, type SpaceBreakdown } from '../diskSpace.js';

/** The row's status text ("1.4 GB") for the Settings index, when the sizes are known. */
export const spaceTotalText = (s: SpaceBreakdown | null | undefined): string => (s ? formatBytes(s.total) : '');

const line = (label: string, bytes: number, sub?: string): SafeHtml =>
  html`<li><div class="row nolead"><span class="txt">${label}${sub ? html`<span class="sub">${sub}</span>` : ''}</span><span class="st">${formatBytes(bytes)}</span></div></li>`;

/** The breakdown, or "Working out the sizes…" (which app.js replaces once /settings/space has the answer). Only the app has it. */
export function spaceBlock(s: SpaceBreakdown | null): SafeHtml {
  if (!s) return html`<div data-space="/settings/space"><h3 id="space">${t('settings.space.title')}</h3><p class="meta" role="status">${t('settings.space.working')}</p></div>`;
  const models = s.models.parts.length > 0 ? s.models.parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(' · ') : undefined;
  return html`<div data-space="/settings/space" data-ready><h3 id="space">${t('settings.space.title')}</h3>
  <p>${tHtml('settings.space.uses', { size: html`<strong>${formatBytes(s.total)}</strong>` })}</p>
  <ul class="group">
    ${s.app === null ? '' : line(t('settings.space.app'), s.app)}
    ${line(t('settings.space.models'), s.models.bytes, models)}
    ${line(t('settings.space.memories'), s.memories, t('settings.space.memoriesSub'))}
    ${line(t('settings.space.backups'), s.backups)}
    ${line(t('settings.space.other'), s.other, t('settings.space.otherSub'))}
  </ul>
  <p class="meta">${t('settings.space.second')}</p></div>`;
}
