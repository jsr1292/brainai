/** Settings › Remove BrainAI: what will happen and where the copy goes, then what happened. */
import { t, tKey, type PlainKey } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';
import { html, type SafeHtml } from './html.js';
import { factsAndPagesText, whereChoice } from './savedViews.js';

/** `mac`: the folder report exists only on the Mac, so only there is it named. */
export function removePage(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; said: string | null; mac: boolean }): SafeHtml {
  return html`<div class="narrow">
<h1>${t('data.remove.title', { computer: computerName() })}</h1>
<p class="lede">${t('data.remove.lede')}</p>
${v.said ? html`<p class="notice" role="alert">${v.said}</p>` : ''}
<h2>${t('data.remove.order')}</h2>
<ol>
<li>${v.synced === null ? t('data.remove.s1docs') : t('data.remove.s1choose')}</li>
<li>${t('data.remove.s2')}</li>
<li>${t('data.remove.s3')}</li>
<li>${v.mac ? t('data.remove.s4mac', { computer: computerName() }) : t('data.remove.s4')}</li>
<li>${t('data.remove.s5')}</li>
<li>${t('data.remove.s6')}</li>
<li>${t('data.remove.s7', { computer: computerName() })}</li>
</ol>
<h2>${t('data.remove.kept')}</h2>
<p>${t('data.remove.keptText', { computer: computerName() })}</p>
${whereChoice({ ...v, action: '/settings/remove', start: true })}
</div>`;
}

/** The checklist lines the removal stores (English, they are also written into the README) as catalog keys on screen; a line that is not one of these shows as stored. */
const FIXED_LINES: Record<string, PlainKey> = {
  'Claude (claude.ai and the phone app): Settings › Connectors › BrainAI › Remove': 'data.todo.claude',
  'ChatGPT: Settings › Apps & Connectors › BrainAI › Delete': 'data.todo.chatgpt',
  'Grok: Settings › Connectors › BrainAI › Remove': 'data.todo.grok',
  "The text you pasted into each app's instructions to use BrainAI": 'data.todo.pasted',
  'Your uptime alert, if you set one up': 'data.todo.uptime',
  'The off-site key on your own computer (memory-offsite-key.txt), once you no longer need the Google Drive copies': 'data.todo.offsiteKey',
};
export function checklistText(line: string): string {
  const fixed = FIXED_LINES[line];
  if (fixed) return tKey(fixed);
  const web = /^(.+): remove BrainAI from its connector or MCP settings$/.exec(line);
  if (web) return t('data.todo.webApp', { name: web[1]! });
  const tunnel = /^Cloudflare: delete the tunnel and the public address(?: (\S+))? \(Zero Trust › Networks › Tunnels\)$/.exec(line);
  if (tunnel) return t('data.todo.tunnel', { address: tunnel[1] ? ` ${tunnel[1]}` : '' });
  const dns = /^Cloudflare: the name (\S+) still exists in your DNS; delete it there\.$/.exec(line);
  return dns ? t('data.todo.dns', { host: dns[1]! }) : line;
}

export type ToolOutcome = { name: string; what: 'disconnected' | 'left alone' | 'unreadable' | 'failed'; detail?: string };

export function removeDone(v: { folder: string; facts: number; pages: number; tools: ToolOutcome[]; checklist: string[]; kept: string[]; revealIn: 'Finder' | 'Explorer' }): SafeHtml {
  const line = (o: ToolOutcome) =>
    o.what === 'disconnected' ? html`<li>${t('data.remove.out.disconnected', { name: o.name })}</li>`
      : o.what === 'unreadable' ? html`<li>${o.name}: ${o.detail}</li>`
      : o.what === 'left alone' ? html`<li>${t('data.remove.out.left', { name: o.name })}${o.detail ? html` (${o.detail})` : ''}</li>`
        : html`<li>${t('data.remove.out.failed', { name: o.name })}${o.detail ? html`: ${o.detail}` : ''}</li>`;
  return html`<div class="narrow">
<h1>${t('data.removed.title')}</h1>
<p><span class="ok">${t('data.done.saved')}</span> ${tHtml('data.done.in', { summary: factsAndPagesText(v.facts, v.pages), folder: html`<code class="path">${v.folder}</code>` })}</p>
<p>${t('data.done.private')}</p>
<div class="row-actions">
<form method="post" action="/settings/remove/show"><button type="submit" class="secondary">${t('data.show', { app: v.revealIn })}</button></form>
</div>
${v.tools.length > 0 ? html`<h2>${t('data.removed.tools')}</h2><ul>${v.tools.map(line)}</ul>` : ''}
${v.kept.length > 0 ? html`<h2>${t('data.removed.left')}</h2><ul>${v.kept.map((k) => html`<li>${checklistText(k)}</li>`)}</ul>` : ''}
<h2>${t('data.removed.todo')}</h2>
<ul>${v.checklist.map((c) => html`<li>${checklistText(c)}</li>`)}</ul>
<p>${t('data.removed.same')}</p>
<div class="row-actions"><a class="primary button" href="/app/removed">${t('data.removed.finish')}</a></div>
</div>`;
}
