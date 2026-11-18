/** The pages of a tool's sign-in in local mode while the owner account is not fully set up: the browser waits, BrainAI's window decides. */
import { thisComputer } from '../desktop/computer.js';
import { html, type SafeHtml } from './html.js';

/** What the tool's browser shows while the owner decides in BrainAI's window. It asks /consent/:id/wait and goes on by itself. */
export function waitingView(id: string, clientName: string, origin: string): SafeHtml {
  return html`<h1>${clientName} wants access to your memory</h1>
<section data-consent-wait="/consent/${encodeURIComponent(id)}/wait">
<p>Open BrainAI's window on ${thisComputer()} to approve or deny it. This page goes on by itself.</p>
<p>It will send you back to: <strong>${origin}</strong></p>
<p class="quiet" data-consent-status role="status"></p>
</section>`;
}

/** Shown in the window after Approve: the browser that waits finishes the connection. */
export function approvedView(clientName: string): SafeHtml {
  return html`<h1>Approved</h1>
<p>Approved: ${clientName} finishes connecting in your browser.</p>
<p><a href="/">Back to BrainAI</a></p>`;
}

/** Shown in the window after Deny: the waiting browser is sent back to the tool with access_denied. */
export function deniedView(clientName: string): SafeHtml {
  return html`<h1>Denied</h1>
<p>Denied: ${clientName} was told no. Its page in your browser goes back to the tool.</p>
<p><a href="/">Back to BrainAI</a></p>`;
}
