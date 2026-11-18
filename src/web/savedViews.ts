/** Settings › Save a copy of everything: where it goes (app), the authenticator code (server), and the result. */
import { factsAndPages } from '../saved/savedCopy.js';
import { html, type SafeHtml } from './html.js';

/**
 * The Documents-or-home choice. Documents that a cloud service keeps a copy of get a warning and the home folder first;
 * otherwise one button. Each button posts `where` to `action`.
 */
export function whereChoice(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; action: string }): SafeHtml {
  if (v.synced === null) {
    return html`<p>It goes into your Documents folder: <code class="path">${v.documents}</code></p>
<form method="post" action="${v.action}"><input type="hidden" name="where" value="documents"><button type="submit" class="primary">Save to Documents</button></form>`;
  }
  return html`<p class="notice">Your Documents folder syncs to ${v.synced}, so this copy would be uploaded there.</p>
<p>Every memory is in it in plain text. Your home folder, <code class="path">${v.home}</code>, stays on this computer.</p>
<div class="row-actions">
<form method="post" action="${v.action}"><input type="hidden" name="where" value="home"><button type="submit" class="primary">Save to your home folder</button></form>
<form method="post" action="${v.action}"><input type="hidden" name="where" value="documents"><button type="submit" class="secondary">Save to Documents anyway</button></form>
</div>`;
}

export function savedPage(v: { documents: string; synced: 'iCloud' | 'OneDrive' | null; home: string; said: string | null }): SafeHtml {
  return html`<div class="narrow">
<h1>Save a copy of everything</h1>
<p class="lede">Every memory and page, in a folder you can keep or take elsewhere: the one file that brings everything back, the same pages as plain text, and a README.</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${whereChoice({ ...v, action: '/settings/save' })}
</div>`;
}

export function savedDone(v: { folder: string; facts: number; pages: number; revealIn: 'Finder' | 'Explorer' }): SafeHtml {
  return html`<div class="narrow">
<h1>Saved</h1>
<p><span class="ok">Saved ✓</span> ${factsAndPages(v.facts, v.pages)} are in <code class="path">${v.folder}</code></p>
<p>It holds every memory in plain text: keep it private.</p>
<div class="row-actions">
<form method="post" action="/settings/save/show"><button type="submit" class="primary">Show in ${v.revealIn}</button></form>
<a class="secondary button" href="/settings">Back to Settings</a>
</div>
</div>`;
}

/** The server: the authenticator code first, as the login asks for it. */
export function savedCodePage(v: { error: string | null }): SafeHtml {
  return html`<div class="narrow">
<h1>Save a copy of everything</h1>
<p class="lede">Downloads one file with every memory and page in plain text, and the archive that brings everything back. Enter the code from your authenticator app to make it.</p>
${v.error ? html`<p class="notice" role="alert">${v.error}</p>` : ''}
<form method="post" action="/settings/save">
<label>Authenticator code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" required autofocus></label>
<button type="submit" class="primary">Download the saved copy</button>
</form>
</div>`;
}
