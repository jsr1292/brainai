/** Settings › Move to a server (D5). */
import { html, type SafeHtml } from './html.js';
import { t } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { ComputerName, computerName } from '../desktop/computer.js';

export interface MoveView {
  said: string | null;
  /** The moving file waiting in the data folder: its name, size and when it was made. */
  file: { name: string; mb: string; made: string } | null;
  /** Live pictures with no file on this computer (they cannot come along). */
  missingPictures: number;
  /** Finder (the Mac) or Explorer (Windows). */
  revealIn: 'Finder' | 'Explorer';
  /** Where the brain lives now, once moved. */
  movedTo: URL | null;
}

export function movePage(v: MoveView): SafeHtml {
  const file = v.file
    ? html`<p><span class="ok">${t('data.move.ready')}</span> <code>${v.file.name}</code> (${tHtml('data.move.fileInfo', { mb: v.file.mb, made: v.file.made })})</p>
<p>${t('data.move.holds')}</p>
<div class="row-actions">
<form method="post" action="/settings/move/show"><button type="submit" class="secondary">${t('data.show', { app: v.revealIn })}</button></form>
<form method="post" action="/settings/move/file"><button type="submit" class="secondary">${t('data.move.again')}</button></form>
<form method="post" action="/settings/move/file/delete"><button type="submit" class="secondary">${t('data.move.delete')}</button></form>
</div>`
    : html`<p>${t('data.move.oneFile')}</p>
<form method="post" action="/settings/move/file"><button type="submit" class="primary">${t('data.move.make')}</button></form>`;
  return html`<div class="narrow">
<h1>${t('data.move.title')}</h1>
<p class="lede">${t('data.move.lede')}</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${v.missingPictures > 0 ? html`<p class="notice">${t('data.move.missing', { count: v.missingPictures, computer: computerName() })}</p>` : ''}
<ol class="setup-steps">
<li><h2>${t('data.move.step1')}</h2>${file}</li>
<li><h2>${t('data.move.step2')}</h2><p>${tHtml('data.move.runbook', { link: html`<a href="https://github.com/jsr1292/brainai/blob/main/docs/RUNBOOK.md#4-moving-from-the-app" target="_blank" rel="noopener">${t('data.move.runbookLink')}</a>`, path: html`<code>docs/RUNBOOK.md</code>` })}</p></li>
<li><h2>${t('data.move.step3')}</h2>${v.movedTo
    ? html`<p><span class="ok">${t('data.move.moved')}</span> ${tHtml('data.move.livesAt', { link: html`<a href="${v.movedTo.origin}">${v.movedTo.origin}</a>`, computer: computerName() })}</p>
<div class="row-actions">
<form method="post" action="/settings/move/remove"><button type="submit" class="primary">${t('data.move.removeFrom', { computer: computerName() })}</button></form>
<form method="post" action="/settings/move/undo"><button type="submit" class="secondary">${t('data.move.undo')}</button></form>
</div>
<p class="meta">${t('data.move.removeNote', { computer: computerName() })}</p>`
    : html`<p>${t('data.move.giveAddress', { Computer: ComputerName() })}</p>
<form method="post" action="/settings/move/done" class="stack">
  <label for="address">${t('data.move.address')}</label><input id="address" name="address" type="url" placeholder="https://brain.example.com" required>
  <p><button type="submit" class="${v.file ? 'primary' : 'secondary'}"${v.file ? '' : ' disabled'}>${t('data.move.itsMoved')}</button></p>${v.file ? '' : html`\n  <p class="meta">${t('data.move.makeFirst')}</p>`}
</form>`}</li>
</ol>
</div>`;
}
