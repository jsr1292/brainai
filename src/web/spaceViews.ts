import { html, type SafeHtml } from './html.js';
import { formatBytes, type SpaceBreakdown } from '../diskSpace.js';

/** The row's status text ("1.4 GB") for the Settings index, when the sizes are known. */
export const spaceTotalText = (s: SpaceBreakdown | null | undefined): string => (s ? formatBytes(s.total) : '');

const line = (label: string, bytes: number, sub?: string): SafeHtml =>
  html`<li><div class="row nolead"><span class="txt">${label}${sub ? html`<span class="sub">${sub}</span>` : ''}</span><span class="st">${formatBytes(bytes)}</span></div></li>`;

/** The breakdown, or "Working out the sizes…" (which app.js replaces once /settings/space has the answer). Only the app has it. */
export function spaceBlock(s: SpaceBreakdown | null): SafeHtml {
  if (!s) return html`<div data-space="/settings/space"><h3 id="space">Space on this computer</h3><p class="meta" role="status">Working out the sizes…</p></div>`;
  const models = s.models.parts.length > 0 ? s.models.parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(' · ') : undefined;
  return html`<div data-space="/settings/space" data-ready><h3 id="space">Space on this computer</h3>
  <p>BrainAI uses <strong>${formatBytes(s.total)}</strong> here.</p>
  <ul class="group">
    ${s.app === null ? '' : line('The app itself', s.app)}
    ${line('Search models', s.models.bytes, models)}
    ${line('Your memories', s.memories, 'The database and your pictures')}
    ${line('Backups on this computer', s.backups)}
    ${line('Other', s.other, 'Logs and status files')}
  </ul>
  <p class="meta">Copies in your second folder aren't counted.</p></div>`;
}
