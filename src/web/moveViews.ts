/** Settings › Move to a server (D5). */
import { html, type SafeHtml } from './html.js';
import { ThisComputer, thisComputer } from '../desktop/computer.js';

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
    ? html`<p><span class="ok">Ready ✓</span> <code>${v.file.name}</code> (${v.file.mb} MB, made ${v.file.made})</p>
<p>It holds every memory, page and picture as they were when it was made, without your password or any app's sign-in. Copy it only to your server, then delete it here.</p>
<div class="row-actions">
<form method="post" action="/settings/move/show"><button type="submit" class="secondary">Show in ${v.revealIn}</button></form>
<form method="post" action="/settings/move/file"><button type="submit" class="secondary">Make it again</button></form>
<form method="post" action="/settings/move/file/delete"><button type="submit" class="secondary">Delete the moving file</button></form>
</div>`
    : html`<p>One file with every memory, page and picture, and none of your sign-in details. It stays in BrainAI's data folder on this computer until you copy it.</p>
<form method="post" action="/settings/move/file"><button type="submit" class="primary">Make the moving file</button></form>`;
  return html`<div class="narrow">
<h1>Move to a server</h1>
<p class="lede">Keep BrainAI running all the time, on a home server or a rented one, with every memory you have here.</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${v.missingPictures > 0 ? html`<p class="notice">${v.missingPictures === 1 ? '1 picture is' : `${v.missingPictures} pictures are`} missing on ${thisComputer()} and cannot come along.</p>` : ''}
<ol class="setup-steps">
<li><h2>Make the moving file</h2>${file}</li>
<li><h2>Set up the server</h2><p>Follow "Moving from the app" in the runbook (<code>docs/RUNBOOK.md</code> in BrainAI's repository): set the server up, unpack the file there, set a password and an authenticator, and start it. Then connect each app from the server's own Settings pages.</p></li>
<li><h2>It's moved</h2>${v.movedTo
    ? html`<p><span class="ok">Moved ✓</span> This brain now lives at <a href="${v.movedTo.origin}">${v.movedTo.origin}</a>. Apps that still use ${thisComputer()} are told to connect there.</p>
<div class="row-actions">
<form method="post" action="/settings/move/remove"><button type="submit" class="primary">Remove BrainAI from ${thisComputer()}</button></form>
<form method="post" action="/settings/move/undo"><button type="submit" class="secondary">Not moved after all</button></form>
</div>
<p class="meta">Remove disconnects the tools on ${thisComputer()} from this copy, stops BrainAI and stops it starting at login. Your data folder stays.</p>`
    : html`<p>Once the server runs with your memories, give its address. ${ThisComputer()} then stops answering its apps and tells them where the brain lives, and Reach from phone and web is turned off.</p>
<form method="post" action="/settings/move/done" class="stack">
  <label for="address">The server's address</label><input id="address" name="address" type="url" placeholder="https://brain.example.com" required>
  <p><button type="submit" class="primary">It's moved</button></p>
</form>`}</li>
</ol>
</div>`;
}
