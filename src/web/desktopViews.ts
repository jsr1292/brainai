/** The Mac app's pages (D3): Settings › Tools on this Mac. */
import type { ToolState } from '../desktop/tools.js';
import { updateLine, type UpdateFile } from '../desktop/updateState.js';
import { factsAndPages } from '../saved/savedCopy.js';
import { html, memoryName, raw, type SafeHtml } from './html.js';
import { ThisComputer, thisComputer } from '../desktop/computer.js';
import { CATALOGUE, ONLINE_MODELS, type CatalogueModel, type ModelId } from '../models/catalogue.js';
import type { Hardware } from '../models/hardware.js';
import { suggest } from '../models/hardware.js';
import type { ModelStatus } from '../models/manager.js';
import { RERANK_POOL } from '../memory/reranker.js';

const copyBox = (text: string, label: string) =>
  html`<div class="copy-box"><pre>${text}</pre><button type="button" class="secondary" data-copy="${text}" aria-label="Copy ${label}">Copy</button></div>`;

function toolRow(t: ToolState, back: 'welcome' | null = null): SafeHtml {
  const backField = back ? html`<input type="hidden" name="back" value="${back}">` : html``;
  const action = (what: 'connect' | 'disconnect', label: string, extra = html``, cls = 'secondary') =>
    html`<form method="post" action="/settings/tools/${t.id}/${what}" class="inline">${backField}${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const status = !t.installed ? html`<span class="meta">Not on ${thisComputer()}</span>`
    : t.state === 'not-connected' && t.detail ? html`<span class="attention">Needs connecting again</span>`
    : t.state === 'connected' && t.signedIn === false ? html`<span class="attention"><span class="dot attention" aria-hidden="true"></span> Added · one step left: ${t.signIn}</span>`
    : t.state === 'connected' ? html`<span class="ok">Connected ✓</span>`
    : t.state === 'other-brainai' ? html`<span class="attention">Uses another BrainAI: ${t.detail}</span>`
    : html`<span class="meta">Not connected</span>`;
  const buttons = !t.installed ? html``
    : t.state === 'connected' ? action('disconnect', 'Disconnect')
    : t.state === 'other-brainai' ? action('connect', 'Replace', html`<input type="hidden" name="replace" value="1">`)
    : action('connect', 'Connect', html``, 'primary');
  const note = t.id === 'claude-desktop' && t.installed ? html`<br><span class="meta">Connect adds BrainAI to Claude's settings. Then quit Claude completely and open it again.</span>` : '';
  // B1: the save reminders (hooks) of tools that have them; the others rely on the rules alone.
  const reminders = !t.installed || t.state !== 'connected' || t.hooks === undefined ? ''
    : t.hooks === 'on' ? html`<br><span class="meta">Save reminders: on</span>`
    : t.hooks === 'off' ? html`<br><span class="meta">Save reminders: off. </span><form method="post" action="/settings/tools/${t.id}/reminders" class="inline"><button type="submit" class="secondary">Add save reminders</button></form>`
    : html`<br><span class="meta">No save reminders: this tool has no hook BrainAI can use, so it relies on its rules.</span>`;
  return html`<li class="tool"><div><strong>${t.name}</strong><br>${status}${note}${reminders}</div><div>${buttons}</div></li>`;
}

/** Information only: ChatGPT's app cannot reach a brain that lives on this computer, so there is nothing to connect. */
function chatgptRow(windows: boolean): SafeHtml {
  const next = windows ? html`Put BrainAI <a href="/settings/move">on a server</a> to use it from ChatGPT.`
    : html`Turn on <a href="/settings/reach">Reach from phone and web</a>, then add BrainAI in ChatGPT on the web.`;
  return html`<li class="tool"><div><strong>ChatGPT</strong><br><span class="meta note">ChatGPT's app can't reach a brain that lives only on this computer. ${next}</span></div><div></div></li>`;
}

export function toolsPage(v: { tools: ToolState[]; windows: boolean; said: string | null; cursorRules: string }): SafeHtml {
  const cursor = v.tools.find((t) => t.id === 'cursor');
  return html`<div class="narrow">
<h1>Tools on ${thisComputer()}</h1>
<p class="lede">For each coding tool, Connect adds BrainAI and its short rules to the tool's instructions, and the tool then signs in once: your browser asks you to Allow.</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
<ul class="group tools">${v.tools.map((t) => toolRow(t))}${chatgptRow(v.windows)}</ul>
<p class="meta">A tool that already uses another BrainAI is left as it is unless you press Replace. Before any change, a file is backed up next to itself as <code class="nowrap">.brainai-backup</code>.</p>
${cursor?.installed ? html`<h2>Rules for Cursor</h2><p>Cursor keeps its rules in its settings: paste this into Cursor › Settings › Rules.</p>${copyBox(v.cursorRules, 'the rules for Cursor')}` : ''}
</div>`;
}

const GB = 1024 ** 3;
const mb = (m: CatalogueModel) => Math.round(m.bytes / 1e6);
const byId = (id: ModelId) => CATALOGUE.find((m) => m.id === id)!;

/** "Apple M-series chip" or "64-bit Intel/AMD", memory and free space, in plain words. */
export function describeComputer(hw: Hardware): string {
  const chip = hw.arch === 'arm64' && hw.platform === 'darwin' ? 'Apple M-series chip' : hw.arch === 'arm64' ? '64-bit Arm' : '64-bit Intel/AMD';
  return `${chip} · ${Math.round(hw.memoryBytes / GB)} GB memory · ${Math.round(hw.freeDiskBytes / GB)} GB free`;
}

/** Megabytes as the line shows them: whole MB, or one decimal when the whole is under 10 MB. */
const megabytes = (bytes: number, small: boolean) => (small ? (bytes / 1e6).toFixed(1) : String(Math.round(bytes / 1e6)));

export interface ModelsProgress {
  text: string; busy: boolean; failed: boolean;
  /** The bar under the text: a whole percent, or null (no total to measure by) for an endless one; no bar when nothing is under way. */
  bar: { value: number | null } | null;
  /** The models are in use and a test search on this computer worked. */
  ready: boolean;
}

/** What the progress line says, in plain words (also sent to the page's script, which only shows it). */
export function modelsProgress(s: ModelStatus, dataDir?: string): ModelsProgress {
  if (s.problem !== undefined) {
    const problem = (dataDir ? s.problem.replaceAll(dataDir, 'the data folder') : s.problem).replace(/[.\s]+$/, '');
    const failed = (text: string): ModelsProgress => ({ text, busy: false, failed: true, bar: null, ready: false });
    if (s.problemWith === 'check') {
      return failed(`The search models loaded, but a test search on ${thisComputer()} failed: ${problem.replace(/^.*test search on this computer failed: /, '')}. Keyword search still works.`);
    }
    if (s.searchReady && s.problemWith === 'rerank') {
      const r = s.choice?.rerank;
      const name = r === 'online' ? ONLINE_MODELS.find((m) => m.id === s.choice?.online?.model)?.label ?? 'online' : r ? byId(r).label : null;
      return failed(`Search by meaning works; the reranker${name ? ` (${name})` : ''} could not be set up: ${problem}.`);
    }
    if (s.searchReady && s.problemWith === 'search' && s.choice) {
      return failed(`Search by meaning works with the model you had; ${byId(s.choice.search).label} could not be set up: ${problem}.`);
    }
    return failed(`The search models could not be set up: ${problem}. Keyword search still works.`);
  }
  const reread = s.rereading === true;
  const active = s.progress.filter((p) => p.state !== 'failed');
  const busy = reread || active.some((p) => p.state !== 'done') || (s.choice !== null && !s.searchReady);
  if (!busy) {
    const idle = (text: string, ready = false): ModelsProgress => ({ text, busy: false, failed: false, bar: null, ready });
    if (s.choice !== null && s.searchReady && s.checked) return idle(`Search is ready and working: a test search on ${thisComputer()} took ${s.checked.ms} ms.`, true);
    return idle(s.choice !== null && s.searchReady ? 'The search models are ready.' : '');
  }
  const total = active.reduce((n, p) => n + p.totalBytes, 0);
  const done = active.reduce((n, p) => n + Math.min(p.doneBytes, p.totalBytes), 0);
  const downloading = active.some((p) => p.state === 'downloading' || p.state === 'waiting');
  const under = (text: string, bar: { value: number | null }): ModelsProgress => ({ text, busy, failed: false, bar, ready: false });
  if (downloading && total > 0) {
    const pct = Math.min(100, Math.floor((done / total) * 100));
    const small = total < 10_000_000;
    return under(`Downloading the search models… ${megabytes(done, small)} of ${megabytes(total, small)} MB · ${pct}% — keyword search already works`, { value: pct });
  }
  if (reread) return under('Re-reading your memories with the new search model… keyword search works meanwhile', { value: null });
  return under('Getting the search models ready… keyword search already works', { value: null });
}

/** The progress line on steps 3 and 4 and Home: filled in by app.js every 2 s while anything is under way. */
export function modelsLine(s: ModelStatus, o: { onlyWhenBusy?: boolean; dataDir?: string } = {}): SafeHtml {
  const p = modelsProgress(s, o.dataDir);
  if (p.text === '' || (o.onlyWhenBusy && !p.busy && !p.failed)) return html``;
  const bar = p.bar === null ? ''
    : p.bar.value === null ? raw('<progress class="models-bar" max="100" aria-label="Search models download progress"></progress>')
    : html`<progress class="models-bar" max="100" value="${p.bar.value}" aria-label="Search models download progress"></progress>`;
  return html`<div class="conn-setup models-line" role="status" data-models-progress="/models/progress"${p.busy ? raw(' data-busy') : raw('')}>${p.ready ? html`<span class="ok models-ok">✓</span>` : ''}<span class="models-text">${p.text}</span>${p.failed ? html` <a href="/settings#search">Look in Settings › Search</a>` : ''}${bar}</div>`;
}

/**
 * The update card on Home (the app only): the notes are untrusted plain text, shown only as list items from their
 * "- " lines (the html tag escapes them). While busy, app.js asks /app/update/state every second and swaps the text.
 */
export function updateCard(u: UpdateFile, later: string | null): SafeHtml {
  const line = updateLine(u);
  if (u.state === 'available' && later === u.version) return html``;
  // An indented line after a "- " line continues that item (manifests published before the notes were unwrapped).
  const joined: string[] = [];
  let inItem = false;
  for (const raw of u.notes.split('\n')) {
    if (raw.trimStart().startsWith('- ') && !/^\s{2,}/.test(raw)) { joined.push(raw.trim()); inItem = true; }
    else if (inItem && /^\s+\S/.test(raw)) joined[joined.length - 1] += ` ${raw.trim()}`;
    else { joined.push(raw.trim()); inItem = false; }
  }
  const items = joined.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l !== '');
  return html`<div class="conn-setup update-card" role="status"${line.busy ? raw(' data-busy') : raw('')} data-update-state="/app/update/state">
  <p><strong class="update-title">${line.title}</strong></p>
  <p class="update-text"${line.text === '' ? raw(' hidden') : raw('')}>${line.text}</p>
  ${items.length > 0 && !line.busy ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : ''}
  ${line.busy ? '' : html`<div class="update-actions">${u.state === 'blocked'
    // The app cannot replace itself where it runs: the release page (outside links open in the browser).
    ? html`<a class="button" href="https://github.com/jsr1292/brainai/releases/latest">Download BrainAI ${u.version}</a>`
    : html`<a class="button" href="/app/update">${u.state === 'failed' ? 'Try again' : 'Update and restart'}</a>`}
  ${u.state === 'available' ? html`<form method="post" action="/app/update/later" class="inline"><button type="submit">Later</button></form>` : ''}</div>`}
</div>`;
}

/** The quiet card on Home (the app only) while the only copies of the brain are on this disk. Later hides it for 30 days. */
export function offsiteCard(): SafeHtml {
  return html`<div class="conn-setup offsite-card" role="status">
  <p>Your backups are only on this computer. Keep a copy in OneDrive, Dropbox or another folder that syncs.</p>
  <div class="update-actions"><a class="button" href="/settings#backup-copy">Choose a folder</a>
  <form method="post" action="/app/offsite/later" class="inline"><button type="submit">Later</button></form></div>
</div>`;
}

export interface ModelsStepInput { hardware: Hardware; installed: ModelId[] }

const downloadLabel = (search: ModelId, rerank: ModelId | null, installed: ModelId[]) => {
  const need = [search, ...(rerank ? [rerank] : [])].filter((id) => !installed.includes(id));
  return need.length === 0 ? 'Continue' : `Download ${need.reduce((n, id) => n + mb(byId(id)), 0)} MB and continue`;
};

function modelOption(m: CatalogueModel, name: string, checked: boolean, recommended: boolean, installed: ModelId[]): SafeHtml {
  const id = `${name}-${m.id}`;
  return html`<li class="model-opt"><input type="radio" id="${id}" name="${name}" value="${m.id}" data-mb="${installed.includes(m.id) ? 0 : mb(m)}"${checked ? raw(' checked') : raw('')}>
  <label for="${id}"><span class="model-name"><strong>${m.label}</strong>${recommended ? html` <span class="model-rec">recommended for this computer</span>` : ''}</span>
  <span class="meta">${mb(m)} MB · ${m.measured} · ${m.licenceUrl ? html`<a href="${m.licenceUrl}" target="_blank" rel="noopener">${m.licence}</a>` : m.licence}</span></label></li>`;
}

export interface GroupsInput {
  /** What is checked. */
  search: ModelId;
  rerank: 'none' | ModelId | `online:${string}`;
  installed: ModelId[];
  /** The pair suggested for this computer (the welcome). */
  recommended?: { search: ModelId; rerank: ModelId | null };
  /** Settings: Online can be chosen, once a key is saved. The welcome leaves it for Settings. */
  online?: { keySaved: boolean };
}

/** The lists of the welcome's step 2 and Settings › Search: the search model, the reranker, and Online. */
export function modelGroups(o: GroupsInput): SafeHtml {
  const search = CATALOGUE.filter((m) => m.kind === 'search' && m.label !== 'Strong');
  const rerank = CATALOGUE.filter((m) => m.kind === 'rerank' && m.label !== 'Strong');
  const rec = o.recommended;
  const onlineOption = (m: (typeof ONLINE_MODELS)[number]) => {
    const value = `online:${m.id}`;
    const id = `rerank-online-${m.id.replace(/[^a-z0-9]+/g, '-')}`;
    return html`<li class="model-opt${o.online?.keySaved ? '' : ' model-off'}"><input type="radio" id="${id}" name="rerank" value="${value}"${o.online?.keySaved ? raw('') : raw(' disabled')}${o.rerank === value ? raw(' checked') : raw('')}>
        <label for="${id}"><span class="model-name"><strong>${m.label}</strong> <span class="meta">${m.id}</span></span>
        <span class="meta">Online: each search sends your question and about ${RERANK_POOL} best matches to OpenRouter. ${m.label} ${m.policy}.</span></label></li>`;
  };
  return html`<fieldset class="model-group"><legend>Search model <span class="meta">finds memories by meaning</span></legend>
      <ul class="model-list">${search.map((m) => modelOption(m, 'search', m.id === o.search, m.id === rec?.search, o.installed))}</ul></fieldset>
    <fieldset class="model-group"><legend>Reranker <span class="meta">puts the right one first</span></legend>
      <ul class="model-list">
        <li class="model-opt"><input type="radio" id="rerank-none" name="rerank" value="none" data-mb="0"${o.rerank === 'none' ? raw(' checked') : raw('')}>
          <label for="rerank-none"><span class="model-name"><strong>None</strong>${rec && rec.rerank === null ? html` <span class="model-rec">recommended for this computer</span>` : ''}</span><span class="meta">No download · quickest · the first result is right less often</span></label></li>
        ${rerank.map((m) => modelOption(m, 'rerank', m.id === o.rerank, m.id === rec?.rerank, o.installed))}
      </ul></fieldset>
${o.online ? html`<fieldset class="model-group"><legend>Or online <span class="meta">nothing to download</span></legend>
      <ul class="model-list">${ONLINE_MODELS.map(onlineOption)}</ul>${!o.online.keySaved ? html`<p class="meta">Save your OpenRouter key below to choose one of these.</p>` : ''}</fieldset>`
      : html`<p class="meta online-later">Prefer an online reranker? Set it up later in Settings › Search.</p>`}`;
}

/** Step 2: what the two models do, this computer, the suggested pair (one click) and the full list. */
function modelsStep(v: ModelsStepInput): SafeHtml {
  const pick = suggest(v.hardware);
  const nameOf = (id: ModelId | null) => (id ? byId(id).label : 'no reranker');
  return html`<h1>How BrainAI finds things</h1>
<p class="lede">The <strong>search model</strong> finds your memories by meaning, in any language (“the car charger” finds “EV wallbox”), not only by the words you typed. The <strong>reranker</strong> then puts the right one first.</p>
<p class="meta">Both are small files that run on ${thisComputer()}: your memories are not sent anywhere. Until they are downloaded, search works on keywords.</p>
<p class="label">This computer</p>
<p class="computer">${describeComputer(v.hardware)}</p>
<form method="post" action="/welcome/models" class="stack models-suggest">
  <input type="hidden" name="mode" value="suggested">
  <p><strong>Recommended for this computer:</strong> ${nameOf(pick.search)} search${pick.rerank ? html` and ${nameOf(pick.rerank)} reranker` : ' and no reranker'}.</p>
  <p><button type="submit" class="primary">${downloadLabel(pick.search, pick.rerank, v.installed)}</button> <span class="meta">Change any time in Settings › Search</span></p>
</form>
<p class="meta skip-models"><a href="/welcome?step=3">Skip for now. Search works on keywords until you choose.</a></p>
<details class="models-all">
  <summary>Choose the models myself<span class="chev"></span></summary>
  <form method="post" action="/welcome/models" class="stack" data-models-form>
    <input type="hidden" name="mode" value="custom">
    ${modelGroups({ search: pick.search, rerank: pick.rerank ?? 'none', installed: v.installed, recommended: pick })}
    <p><button type="submit" class="primary" data-models-button>${downloadLabel(pick.search, pick.rerank, v.installed)}</button></p>
  </form>
</details>`;
}

/** The welcome for a new Mac install (D3), four steps as in the approved mockup. */
const SETUP_STEPS = ['Your name', 'Search', 'Connect', 'Try it'] as const;
const CHECK = raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>');

/** The setup's frame on a desktop window: the brand and the four steps on the left (done, current, to come), the step on the right. */
function setupFrame(step: 1 | 2 | 3 | 4, body: SafeHtml): SafeHtml {
  const item = (label: string, i: number) => {
    const n = i + 1;
    const state = n < step ? 'done' : n === step ? 'current' : 'todo';
    return html`<li class="${state}"${n === step ? raw(' aria-current="step"') : ''}><span class="step-mark">${state === 'done' ? CHECK : String(n)}</span><span>${label}</span>${state === 'done' ? html`<span class="visually-hidden"> (done)</span>` : ''}</li>`;
  };
  return html`<div class="setup-frame">
<aside class="setup-rail">
<p class="brand"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></p>
<ol class="setup-rail-steps" aria-label="Setup steps">${SETUP_STEPS.map(item)}</ol>
</aside>
<div class="setup-main welcome">
<p class="meta step-count">Step ${step} of 4</p>
${step > 1 ? html`<p class="step-back"><a href="/welcome?step=${step - 1}">‹ Back</a></p>` : ''}
${body}
</div>
</div>`;
}

/** Where each tool signs in, in a few words, for step 4 when nothing has arrived yet. */
const SIGN_IN_HINT: Record<ToolState['id'], string> = {
  'claude-code': 'In Claude Code: /mcp › brainai › Authenticate.',
  codex: 'In a terminal: codex mcp login brainai.',
  opencode: 'In a terminal: opencode mcp auth brainai.',
  cursor: 'Cursor asks you to sign in the first time it uses BrainAI.',
  gemini: 'In Gemini CLI: /mcp auth brainai.',
  'claude-desktop': 'Quit Claude completely and open it again.',
};

export function welcomePage(v: {
  step: 1 | 2 | 3 | 4;
  /** Step 2's facts: this computer and what is already installed. */
  models?: ModelsStepInput;
  /** The search models' progress line (steps 3 and 4). */
  modelsLine?: SafeHtml; tools: ToolState[]; windows: boolean; said: string | null; cursorRules: string;
  /** Only an empty brain can take a saved copy: 'offer' shows the link on step 1, 'choose' the file step. */
  restore?: 'offer' | 'choose' | null;
  /** What the restart found, shown once on step 2. */
  restored?: { facts: number; pages: number; pictures_missing?: number } | { refused: string } | null;
}): SafeHtml {
  if (v.step === 1 && v.restore === 'choose') {
    return setupFrame(1, html`<h1>Bring your saved brain back</h1>
<p>Choose the <code>brainai-saved-….tar.gz</code> file inside your BrainAI saved folder, or a backup file <code>memory-….db</code>.</p>
<form class="stack" data-restore-form>
  <label for="restore-file">Saved file</label>
  <input id="restore-file" type="file" accept=".gz,.db" required>
  <p class="notice error" role="alert" data-restore-error hidden></p>
  <p class="notice" role="status" data-restore-busy hidden>Bringing your brain back… this can take a minute.</p>
  <p class="setup-actions"><a href="/welcome">Cancel</a> <button type="submit" class="primary">Bring it back</button></p>
</form>`);
  }
  if (v.step === 1) {
    return setupFrame(1, html`<h1>Your brain is running</h1>
<p class="lede">One memory for all your AI assistants. Tell one of them something, and the others know it too.</p>
<p>It stays on ${thisComputer()}: only apps on ${thisComputer()} can reach it.</p>
<form method="post" action="/welcome/name" class="stack">
  <label for="owner-name">Your name, so your assistants know who you are (optional)</label>
  <input id="owner-name" name="name" maxlength="80" autocomplete="name">
  <p class="setup-actions">${v.restore === 'offer' ? html`<span class="meta">Coming back? <a href="/welcome?restore=1">I have a saved BrainAI folder</a></span>` : ''}<button type="submit" class="primary">Next</button></p>
</form>`);
  }
  if (v.step === 2) {
    return setupFrame(2, v.models ? modelsStep(v.models) : html`<h1>How BrainAI finds things</h1><p>BrainAI searches by keywords, and its models are ready as they are on this install.</p><p class="setup-actions"><a class="button primary" href="/welcome?step=3">Next</a></p>`);
  }
  if (v.step === 3) {
    const any = v.tools.some((t) => t.installed);
    return setupFrame(3, html`<h1>Connect your assistants</h1>
${v.restored ? ('refused' in v.restored
    ? html`<p class="notice error" role="alert">${v.restored.refused}</p>`
    : html`<p class="notice" role="status">Your saved brain is back: ${factsAndPages(v.restored.facts, v.restored.pages)}.</p>${(v.restored.pictures_missing ?? 0) > 0
      ? html`<p class="notice" role="status">${v.restored.pictures_missing} ${v.restored.pictures_missing === 1 ? 'picture was' : 'pictures were'} not in the backup file: their pages kept their text.</p>` : ''}`) : ''}
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${any ? html`<p>Found on ${thisComputer()}:</p>` : html`<p>No coding tools found on ${thisComputer()}. You can connect them later from Settings › Tools on ${thisComputer()}.</p>`}
<ul class="group tools">${v.tools.filter((t) => t.installed).map((t) => toolRow(t, 'welcome'))}${chatgptRow(v.windows)}</ul>
<p class="meta">For each coding tool, Connect adds BrainAI and its short rules to the tool's instructions, and the tool signs in once: your browser asks you to Allow. You can undo it in Settings.</p>
${v.modelsLine ?? ''}
<p class="setup-actions"><a class="button primary" href="/welcome?step=4">Next</a></p>`);
  }
  const added = v.tools.filter((t) => t.installed && t.state === 'connected');
  const sentence = 'Save a note in BrainAI that I set it up today.';
  if (added.length === 0) {
    return setupFrame(4, html`<h1>Try it</h1>
<p class="notice" role="status">No assistant is added yet. <a href="/welcome?step=3">Go back and connect one</a>, or open your brain and do it later.</p>
${v.modelsLine ?? ''}
<form method="post" action="/welcome/done" class="setup-actions"><button type="submit" class="primary">Open my brain</button></form>`);
  }
  // Only the tools that have not signed in yet need a hint; when all have, the list is the whole set.
  const hintFor = (added.some((t) => t.signedIn === false) ? added.filter((t) => t.signedIn === false) : added).map((t) => SIGN_IN_HINT[t.id]);
  return setupFrame(4, html`<h1>Try it</h1>
<p>Open one of the assistants you connected and say:</p>
${copyBox(sentence, 'the sentence')}
<p class="conn-setup" data-setup-status="/welcome/first">Waiting for your first memory…</p>
<p class="meta" data-nothing-yet hidden>Nothing yet? Check that the tool signed in. ${hintFor.join(' ')}</p>
<p>Then ask another assistant: <em>what do you know about me?</em></p>
${v.modelsLine ?? ''}
<form method="post" action="/welcome/done" class="setup-actions"><button type="submit" class="primary">Open my brain</button></form>`);
}

/** The welcome's waiting line: the first thing an assistant saved, or suggested. */
export function firstLine(v: { memory: { by: string; content: string } | null; suggestion: { by: string; content: string } | null }): SafeHtml {
  if (v.memory) return html`<span class="ok">Saved by ${v.memory.by}: ${v.memory.content}</span>`;
  if (v.suggestion) return html`<span class="ok">${v.suggestion.by} suggested: ${v.suggestion.content} It waits for your approval on Projects.</span>`;
  return html`<span class="attention">Waiting for your first memory…</span>`;
}

export interface SearchSectionInput {
  status: ModelStatus;
  installed: ModelId[];
  keySaved: boolean;
  /** What the last action said, once. */
  said: string | null;
  dataDir?: string;
}

/** Settings › Search (local mode): the pair in use, the same lists as step 2, Online and its key, what is downloaded. */
export function searchSection(v: SearchSectionInput): SafeHtml {
  const c = v.status.choice;
  const online = c?.rerank === 'online' ? ONLINE_MODELS.find((m) => m.id === c.online?.model) : undefined;
  const rerankName = c === null ? 'none yet' : c.rerank === null ? 'none' : c.rerank === 'online' ? `online (${online?.label ?? 'OpenRouter'})` : byId(c.rerank).label;
  const current = c === null ? html`<p class="quiet">No search models chosen yet: search works on keywords.</p>`
    : c.rerank === null
      ? html`<p>In use: <strong>${byId(c.search).label}</strong> search model, no reranker.</p>`
      : html`<p>In use: <strong>${byId(c.search).label}</strong> search model, <strong>${rerankName}</strong> reranker.</p>`;
  const checked: GroupsInput['rerank'] = c?.rerank === 'online' ? (c.online ? `online:${c.online.model}` : 'none') : c?.rerank ?? 'none';
  const fallback = (id: ModelId) => c?.rerank === 'online' && id === 'mminilm';
  const inUse = (id: ModelId) => c?.search === id || c?.rerank === id;
  const present = CATALOGUE.filter((m) => m.label !== 'Strong' && v.installed.includes(m.id));
  const missing = CATALOGUE.filter((m) => m.label !== 'Strong' && !v.installed.includes(m.id));
  const problem = v.status.onlineProblem === undefined ? '' : html`<p class="notice error" role="alert">Online reranking: ${v.status.onlineProblem}. Searches kept their local order meanwhile.</p>`;
  return html`<section id="search" class="panel">
  <div class="panel-head"><h2>Search</h2></div>
  <p class="meta">The search model finds memories by meaning; the reranker puts the right one first. Both run on ${thisComputer()} unless you choose Online.</p>
  ${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
  ${current}
  ${modelsLine(v.status, { dataDir: v.dataDir })}
  ${problem}
  <form method="post" action="/settings/search/models" class="stack">
    ${modelGroups({ search: c?.search ?? 'gemma', rerank: checked, installed: v.installed, online: { keySaved: v.keySaved } })}
    <p><button type="submit" class="primary">Use these models</button> <span class="meta">What is not on ${thisComputer()} downloads first; a new search model re-reads your memories in the background.</span></p>
  </form>
  <h3 id="search-key">OpenRouter key</h3>
  <p class="meta">Needed only for Online. It stays on ${thisComputer()}, in BrainAI's data folder: never in your brain or in a saved copy.</p>
  ${v.keySaved ? html`<p>A key is saved.</p>
  <details class="models-all"><summary>Replace<span class="chev"></span></summary>
    <form method="post" action="/settings/search/key" class="stack"><label for="search-key-new">New key</label><input id="search-key-new" type="password" name="key" autocomplete="off" spellcheck="false" required>
    <p><button type="submit">Replace the key</button></p></form></details>
  <form method="post" action="/settings/search/key/remove" class="inline"><button type="submit" class="secondary">Remove</button></form>`
    : html`<form method="post" action="/settings/search/key" class="stack"><label for="search-key-new">Key</label><input id="search-key-new" type="password" name="key" autocomplete="off" spellcheck="false" required>
    <p><button type="submit">Save the key</button></p></form>`}
  <h3 id="search-downloaded">On ${thisComputer()}</h3>
  ${present.length === 0 ? html`<p class="quiet">No models downloaded yet.</p>` : html`<ul class="group tools">${present.map((m) => html`<li class="tool"><div><strong>${m.label}</strong> <span class="meta">${mb(m)} MB · ${m.kind === 'search' ? 'search model' : 'reranker'}</span></div>
    <div>${inUse(m.id) ? html`<span class="meta">In use</span>` : fallback(m.id) ? html`<span class="meta">In use as the fallback</span>` : html`<form method="post" action="/settings/search/remove" class="inline"><input type="hidden" name="model" value="${m.id}"><button type="submit" class="secondary" aria-label="Remove ${m.label}">Remove</button></form>`}</div></li>`)}</ul>`}
  ${missing.length === 0 ? '' : html`<details class="models-all"><summary>Load model files from a folder<span class="chev"></span></summary>
    <p class="meta">When neither download source works: choose the folder that holds a model's files. Each file is checked against its pin before anything is copied; a wrong file is refused.</p>
    <form method="post" action="/settings/search/load" class="stack">
      <label for="search-load-model">Model</label>
      <select id="search-load-model" name="model">${missing.map((m) => html`<option value="${m.id}">${m.label} (${m.kind === 'search' ? 'search model' : 'reranker'})</option>`)}</select>
      <label for="search-load-folder">Folder (the full path)</label><input id="search-load-folder" name="folder" autocomplete="off" required>
      <p><button type="submit">Load model files</button></p>
    </form></details>`}
</section>`;
}
