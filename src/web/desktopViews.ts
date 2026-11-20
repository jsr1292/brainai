/** The Mac app's pages (D3): Settings › Tools on this Mac. */
import { detailText, toolName, type ToolState } from '../desktop/tools.js';
import { updateLine, type UpdateFile } from '../desktop/updateState.js';
import { html, memoryName, raw, type SafeHtml } from './html.js';
import { catalogOf, t, tKey, type Key, type PlainKey } from '../i18n/core.js';
import { tHtml } from '../i18n/tHtml.js';
import { computerName } from '../desktop/computer.js';
import { copyBox } from './setupViews.js';
import { factsAndPagesText } from './savedViews.js';
import { CATALOGUE, ONLINE_MODELS, type CatalogueModel, type ModelId } from '../models/catalogue.js';
import type { Hardware } from '../models/hardware.js';
import { suggest } from '../models/hardware.js';
import type { ModelStatus } from '../models/manager.js';
import { RERANK_POOL } from '../memory/reranker.js';

/** The catalogue's English model names and sentences, in the request's language (the catalogue itself stays English). */
export const modelLabel = (m: Pick<CatalogueModel, 'label'>): string => tKey(`setup.model.label.${m.label}` as Key);
/** The same without the pseudo-locale brackets, for a parameter of another t(). */
export const modelLabelPlain = (m: Pick<CatalogueModel, 'label'>): string => tKey(`setup.model.label.${m.label}` as Key);
const measuredOf = (m: CatalogueModel): string => (catalogOf('en')[`setup.model.measured.${m.id}`] === undefined ? m.measured : tKey(`setup.model.measured.${m.id}` as Key));
const ONLINE_POLICY: Record<string, PlainKeyWithLabel> = { 'voyageai/rerank-2.5': 'setup.online.policy.voyage', 'qwen/qwen3-reranker-8b': 'setup.online.policy.qwen' };
type PlainKeyWithLabel = 'setup.online.policy.voyage' | 'setup.online.policy.qwen';

function toolRow(tool: ToolState, back: 'welcome' | null = null): SafeHtml {
  const backField = back ? html`<input type="hidden" name="back" value="${back}">` : html``;
  const action = (what: 'connect' | 'disconnect', label: string, extra = html``, cls = 'secondary') =>
    html`<form method="post" action="/settings/tools/${tool.id}/${what}" class="inline">${backField}${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const status = !tool.installed ? html`<span class="meta">${t('setup.tool.notOn', { computer: computerName() })}</span>`
    : tool.state === 'not-connected' && tool.detail ? html`<span class="attention">${t('setup.tool.again')}</span>`
    : tool.state === 'connected' && tool.signedIn === false ? html`<span class="attention"><span class="dot attention" aria-hidden="true"></span> ${t('setup.tool.added', { signIn: tKey(`tools.signIn.${tool.id}`) })}</span>`
    : tool.state === 'connected' ? html`<span class="ok">${t('setup.tool.connected')}</span>`
    : tool.state === 'other-brainai' ? html`<span class="attention">${t('setup.tool.other', { detail: detailText(tool) })}</span>`
    : html`<span class="meta">${t('setup.tool.notConnected')}</span>`;
  const buttons = !tool.installed ? html``
    : tool.state === 'connected' ? action('disconnect', t('setup.tool.disconnect'))
    : tool.state === 'other-brainai' ? action('connect', t('setup.tool.replace'), html`<input type="hidden" name="replace" value="1">`)
    : action('connect', t('setup.tool.connect'), html``, 'primary');
  const note = tool.id === 'claude-desktop' && tool.installed ? html`<br><span class="meta">${t('setup.tool.desktopNote')}</span>` : '';
  // B1: the save reminders (hooks) of tools that have them; the others rely on the rules alone.
  const reminders = !tool.installed || tool.state !== 'connected' || tool.hooks === undefined ? ''
    : tool.hooks === 'on' ? html`<br><span class="meta">${t('setup.tool.remindersOn')}</span>`
    : tool.hooks === 'off' ? html`<br><span class="meta">${t('setup.tool.remindersOff')} </span><form method="post" action="/settings/tools/${tool.id}/reminders" class="inline"><button type="submit" class="secondary">${t('setup.tool.addReminders')}</button></form>`
    : html`<br><span class="meta">${t('setup.tool.noReminders')}</span>`;
  return html`<li class="tool"><div><strong>${toolName(tool)}</strong><br>${status}${note}${reminders}</div><div>${buttons}</div></li>`;
}

/** Information only: ChatGPT's app cannot reach a brain that lives on this computer, so there is nothing to connect. */
function chatgptRow(windows: boolean): SafeHtml {
  const next = windows ? tHtml('setup.chatgpt.windows', { link: html`<a href="/settings/move">${t('setup.chatgpt.server')}</a>` })
    : tHtml('setup.chatgpt.mac', { link: html`<a href="/settings/reach">${t('setup.reach.title')}</a>` });
  return html`<li class="tool"><div><strong>ChatGPT</strong><br><span class="meta note">${tHtml('setup.chatgpt.note', { next })}</span></div><div></div></li>`;
}

export function toolsPage(v: { tools: ToolState[]; windows: boolean; said: string | null; cursorRules: string }): SafeHtml {
  const cursor = v.tools.find((x) => x.id === 'cursor');
  return html`<div class="narrow">
<h1>${t('setup.toolsOn', { computer: computerName() })}</h1>
<p class="lede">${t('setup.tools.lede')}</p>
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
<ul class="group tools">${v.tools.map((x) => toolRow(x))}${chatgptRow(v.windows)}</ul>
<p class="meta">${tHtml('setup.tools.note', { code: html`<code class="nowrap">.brainai-backup</code>` })}</p>
${cursor?.installed ? html`<h2>${t('setup.tools.cursorHead')}</h2><p>${t('setup.tools.cursorHow')}</p>${copyBox(v.cursorRules, 'setup.copy.cursorRules')}` : ''}
</div>`;
}

const GB = 1024 ** 3;
const mb = (m: CatalogueModel) => Math.round(m.bytes / 1e6);
const byId = (id: ModelId) => CATALOGUE.find((m) => m.id === id)!;

/** "Apple M-series chip" or "64-bit Intel/AMD", memory and free space, in plain words. */
export function describeComputer(hw: Hardware): string {
  const chip = hw.arch === 'arm64' && hw.platform === 'darwin' ? tKey('setup.hw.apple') : hw.arch === 'arm64' ? tKey('setup.hw.arm') : tKey('setup.hw.intel');
  return t('setup.hw.line', { chip, memory: Math.round(hw.memoryBytes / GB), free: Math.round(hw.freeDiskBytes / GB) });
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
    const problem = (dataDir ? s.problem.replaceAll(dataDir, tKey('setup.dataFolder')) : s.problem).replace(/[.\s]+$/, '');
    const failed = (text: string): ModelsProgress => ({ text, busy: false, failed: true, bar: null, ready: false });
    if (s.problemWith === 'check') {
      return failed(t('setup.models.checkFailed', { computer: computerName(), problem: problem.replace(/^.*test search on this computer failed: /, '') }));
    }
    if (s.searchReady && s.problemWith === 'rerank') {
      const r = s.choice?.rerank;
      const name = r === 'online' ? ONLINE_MODELS.find((m) => m.id === s.choice?.online?.model)?.label ?? tKey('setup.models.onlineWord') : r ? modelLabelPlain(byId(r)) : null;
      return failed(name ? t('setup.models.rerankFailedNamed', { name, problem }) : t('setup.models.rerankFailed', { problem }));
    }
    if (s.searchReady && s.problemWith === 'search' && s.choice) {
      return failed(t('setup.models.searchFailed', { model: modelLabelPlain(byId(s.choice.search)), problem }));
    }
    return failed(t('setup.models.failed', { problem }));
  }
  const reread = s.rereading === true;
  const active = s.progress.filter((p) => p.state !== 'failed');
  const busy = reread || active.some((p) => p.state !== 'done') || (s.choice !== null && !s.searchReady);
  if (!busy) {
    const idle = (text: string, ready = false): ModelsProgress => ({ text, busy: false, failed: false, bar: null, ready });
    if (s.choice !== null && s.searchReady && s.checked) return idle(t('setup.models.working', { computer: computerName(), ms: s.checked.ms }), true);
    return idle(s.choice !== null && s.searchReady ? t('setup.models.ready') : '');
  }
  const total = active.reduce((n, p) => n + p.totalBytes, 0);
  const done = active.reduce((n, p) => n + Math.min(p.doneBytes, p.totalBytes), 0);
  const downloading = active.some((p) => p.state === 'downloading' || p.state === 'waiting');
  const under = (text: string, bar: { value: number | null }): ModelsProgress => ({ text, busy, failed: false, bar, ready: false });
  if (downloading && total > 0) {
    const pct = Math.min(100, Math.floor((done / total) * 100));
    const small = total < 10_000_000;
    return under(t('setup.models.downloading', { done: megabytes(done, small), total: megabytes(total, small), pct }), { value: pct });
  }
  if (reread) return under(t('setup.models.reread'), { value: null });
  return under(t('setup.models.getting'), { value: null });
}

/** The progress line on steps 3 and 4 and Home: filled in by app.js every 2 s while anything is under way. */
export function modelsLine(s: ModelStatus, o: { onlyWhenBusy?: boolean; dataDir?: string } = {}): SafeHtml {
  const p = modelsProgress(s, o.dataDir);
  if (p.text === '' || (o.onlyWhenBusy && !p.busy && !p.failed)) return html``;
  const bar = p.bar === null ? ''
    : p.bar.value === null ? html`<progress class="models-bar" max="100" aria-label="${t('setup.models.barLabel')}"></progress>`
    : html`<progress class="models-bar" max="100" value="${p.bar.value}" aria-label="${t('setup.models.barLabel')}"></progress>`;
  return html`<div class="conn-setup models-line" role="status" data-models-progress="/models/progress"${p.busy ? raw(' data-busy') : raw('')}>${p.ready ? html`<span class="ok models-ok">✓</span>` : ''}<span class="models-text">${p.text}</span>${p.failed ? html` <a href="/settings#search">${t('setup.models.look')}</a>` : ''}${bar}</div>`;
}

/** The "- " lines of a release's notes, as plain strings (untrusted: only ever interpolated through `html`). */
export function noteItems(notes: string): string[] {
  // An indented line after a "- " line continues that item (manifests published before the notes were unwrapped).
  const joined: string[] = [];
  let inItem = false;
  for (const raw of notes.split('\n')) {
    if (raw.trimStart().startsWith('- ') && !/^\s{2,}/.test(raw)) { joined.push(raw.trim()); inItem = true; }
    else if (inItem && /^\s+\S/.test(raw)) joined[joined.length - 1] += ` ${raw.trim()}`;
    else { joined.push(raw.trim()); inItem = false; }
  }
  return joined.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l !== '');
}

/**
 * The update card on Home (the app only): the notes are untrusted plain text, shown only as list items from their
 * "- " lines (the html tag escapes them). While busy, app.js asks /app/update/state every second and swaps the text.
 */
export function updateCard(u: UpdateFile, later: string | null): SafeHtml {
  const line = updateLine(u);
  const offered = u.state === 'available' || u.state === 'ready';
  if (offered && later === u.version) return html``;
  const items = noteItems(u.notes);
  return html`<div class="conn-setup update-card" role="status"${line.busy ? raw(' data-busy') : raw('')} data-update-state="/app/update/state">
  <p><strong class="update-title">${line.title}</strong></p>
  <p class="update-text"${line.text === '' ? raw(' hidden') : raw('')}>${line.text}</p>
  ${items.length > 0 && !line.busy ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : ''}
  ${line.busy ? '' : html`<div class="update-actions">${u.state === 'blocked'
    // The app cannot replace itself where it runs: the release page (outside links open in the browser).
    ? html`<a class="button" href="https://github.com/jsr1292/brainai/releases/latest">${t('setup.update.download', { version: u.version })}</a>`
    : html`<a class="button" href="/app/update">${u.state === 'failed' ? t('setup.update.again') : u.state === 'ready' ? t('setup.update.restartNow') : t('setup.update.restart')}</a>`}
  ${offered ? html`<form method="post" action="/app/update/later" class="inline"><button type="submit">${t('setup.later')}</button></form>` : ''}</div>`}
</div>`;
}

/**
 * The small line on Home at the first start after an update (the app only): "Updated to 1.7.2 · What's new". What's new
 * opens the notes in place (untrusted plain text, list items escaped by `html`); Dismiss deletes just-updated.json.
 */
export function justUpdatedLine(j: { version: string; notes: string }): SafeHtml {
  const items = noteItems(j.notes);
  const said = html`<strong>${t('setup.update.justUpdated', { version: j.version })}</strong>`;
  return html`<div class="conn-setup just-updated" role="status">
  <div class="just-updated-line">${items.length > 0
    ? html`<details class="just-updated-notes"><summary>${said} · <span class="just-updated-more">${t('setup.update.whatsNew')}</span></summary><ul>${items.map((i) => html`<li>${i}</li>`)}</ul></details>`
    : html`<span>${said}</span>`}
  <form method="post" action="/app/update/dismiss" class="inline"><button type="submit">${t('setup.update.dismiss')}</button></form></div>
</div>`;
}

/** The quiet card on Home (the app only) while the only copies of the brain are on this disk. Later hides it for 30 days. */
export function offsiteCard(): SafeHtml {
  return html`<div class="conn-setup offsite-card" role="status">
  <p>${t('setup.offsite.text')}</p>
  <div class="update-actions"><a class="button" href="/settings#backup-copy">${t('setup.offsite.choose')}</a>
  <form method="post" action="/app/offsite/later" class="inline"><button type="submit">${t('setup.later')}</button></form></div>
</div>`;
}

export interface ModelsStepInput { hardware: Hardware; installed: ModelId[] }

const downloadLabel = (search: ModelId, rerank: ModelId | null, installed: ModelId[]) => {
  const need = [search, ...(rerank ? [rerank] : [])].filter((id) => !installed.includes(id));
  return need.length === 0 ? t('setup.models.continue') : t('setup.models.download', { mb: need.reduce((n, id) => n + mb(byId(id)), 0) });
};

function modelOption(m: CatalogueModel, name: string, checked: boolean, recommended: boolean, installed: ModelId[]): SafeHtml {
  const id = `${name}-${m.id}`;
  return html`<li class="model-opt"><input type="radio" id="${id}" name="${name}" value="${m.id}" data-mb="${installed.includes(m.id) ? 0 : mb(m)}"${checked ? raw(' checked') : raw('')}>
  <label for="${id}"><span class="model-name"><strong>${modelLabel(m)}</strong>${recommended ? html` <span class="model-rec">${t('setup.models.recShort')}</span>` : ''}</span>
  <span class="meta">${mb(m)} MB · ${measuredOf(m)} · ${m.licenceUrl ? html`<a href="${m.licenceUrl}" target="_blank" rel="noopener">${m.licence}</a>` : m.licence}</span></label></li>`;
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
        <span class="meta">${t('setup.online.send', { pool: RERANK_POOL })} ${ONLINE_POLICY[m.id] ? t(ONLINE_POLICY[m.id]!, { label: m.label }) : `${m.label} ${m.policy}.`}</span></label></li>`;
  };
  return html`<fieldset class="model-group"><legend>${t('setup.models.searchModel')} <span class="meta">${t('setup.models.searchModelHint')}</span></legend>
      <ul class="model-list">${search.map((m) => modelOption(m, 'search', m.id === o.search, m.id === rec?.search, o.installed))}</ul></fieldset>
    <fieldset class="model-group"><legend>${t('setup.models.reranker')} <span class="meta">${t('setup.models.rerankerHint')}</span></legend>
      <ul class="model-list">
        <li class="model-opt"><input type="radio" id="rerank-none" name="rerank" value="none" data-mb="0"${o.rerank === 'none' ? raw(' checked') : raw('')}>
          <label for="rerank-none"><span class="model-name"><strong>${t('setup.models.none')}</strong>${rec && rec.rerank === null ? html` <span class="model-rec">${t('setup.models.recShort')}</span>` : ''}</span><span class="meta">${t('setup.models.noneHint')}</span></label></li>
        ${rerank.map((m) => modelOption(m, 'rerank', m.id === o.rerank, m.id === rec?.rerank, o.installed))}
      </ul></fieldset>
${o.online ? html`<fieldset class="model-group"><legend>${t('setup.models.orOnline')} <span class="meta">${t('setup.models.orOnlineHint')}</span></legend>
      <ul class="model-list">${ONLINE_MODELS.map(onlineOption)}</ul>${!o.online.keySaved ? html`<p class="meta">${t('setup.models.saveKey')}</p>` : ''}</fieldset>`
      : html`<p class="meta online-later">${t('setup.models.onlineLater')}</p>`}`;
}

/** Step 2: what the two models do, this computer, the suggested pair (one click) and the full list. */
function modelsStep(v: ModelsStepInput): SafeHtml {
  const pick = suggest(v.hardware);
  const nameOf = (id: ModelId) => modelLabelPlain(byId(id));
  return html`<h1>${t('setup.models.title')}</h1>
<p class="lede">${tHtml('setup.models.lede', { search: html`<strong>${t('setup.models.searchModelLc')}</strong>`, rerank: html`<strong>${t('setup.models.rerankerLc')}</strong>` })}</p>
<p class="meta">${t('setup.models.local', { computer: computerName() })}</p>
<p class="label">${t('setup.models.thisComputer')}</p>
<p class="computer">${describeComputer(v.hardware)}</p>
<form method="post" action="/welcome/models" class="stack models-suggest">
  <input type="hidden" name="mode" value="suggested">
  <p><strong>${t('setup.models.recommended')}</strong> ${pick.rerank ? t('setup.models.pairBoth', { search: nameOf(pick.search), rerank: nameOf(pick.rerank) }) : t('setup.models.pairNone', { search: nameOf(pick.search) })}</p>
  <p><button type="submit" class="primary">${downloadLabel(pick.search, pick.rerank, v.installed)}</button> <span class="meta">${t('setup.models.changeAny')}</span></p>
</form>
<p class="meta skip-models"><a href="/welcome?step=3">${t('setup.models.skip')}</a></p>
<details class="models-all">
  <summary>${t('setup.models.choose')}<span class="chev"></span></summary>
  <form method="post" action="/welcome/models" class="stack" data-models-form>
    <input type="hidden" name="mode" value="custom">
    ${modelGroups({ search: pick.search, rerank: pick.rerank ?? 'none', installed: v.installed, recommended: pick })}
    <p><button type="submit" class="primary" data-models-button>${downloadLabel(pick.search, pick.rerank, v.installed)}</button></p>
  </form>
</details>`;
}

/** The welcome for a new Mac install (D3), four steps as in the approved mockup. */
const SETUP_STEPS = ['setup.step1', 'setup.step2', 'setup.step3', 'setup.step4'] as const;
const CHECK = raw('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>');

/** The setup's frame on a desktop window: the brand and the four steps on the left (done, current, to come), the step on the right. */
function setupFrame(step: 1 | 2 | 3 | 4, body: SafeHtml): SafeHtml {
  const item = (label: PlainKey, i: number) => {
    const n = i + 1;
    const state = n < step ? 'done' : n === step ? 'current' : 'todo';
    return html`<li class="${state}"${n === step ? raw(' aria-current="step"') : ''}><span class="step-mark">${state === 'done' ? CHECK : String(n)}</span><span>${tKey(label)}</span>${state === 'done' ? html`<span class="visually-hidden"> ${t('setup.stepDone')}</span>` : ''}</li>`;
  };
  return html`<div class="setup-frame">
<aside class="setup-rail">
<p class="brand"><span class="brand-dot" aria-hidden="true"></span><span>${memoryName()}</span></p>
<ol class="setup-rail-steps" aria-label="${t('setup.stepsLabel')}">${SETUP_STEPS.map(item)}</ol>
</aside>
<div class="setup-main welcome">
<p class="meta step-count">${t('setup.stepCount', { step })}</p>
${step > 1 ? html`<p class="step-back"><a href="/welcome?step=${step - 1}">${t('setup.back')}</a></p>` : ''}
${body}
</div>
</div>`;
}

/** Where each tool signs in, in a few words, for step 4 when nothing has arrived yet. */
const SIGN_IN_HINT: Record<ToolState['id'], PlainKey> = {
  'claude-code': 'setup.hint.claude-code',
  codex: 'setup.hint.codex',
  opencode: 'setup.hint.opencode',
  cursor: 'setup.hint.cursor',
  gemini: 'setup.hint.gemini',
  'claude-desktop': 'setup.hint.claude-desktop',
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
    return setupFrame(1, html`<h1>${t('setup.restore.title')}</h1>
<p>${tHtml('setup.restore.choose', { saved: html`<code>brainai-saved-….tar.gz</code>`, backup: html`<code>memory-….db</code>` })}</p>
<form class="stack" data-restore-form>
  <label for="restore-file">${t('setup.restore.file')}</label>
  <input id="restore-file" type="file" accept=".gz,.db" required>
  <p class="notice error" role="alert" data-restore-error hidden></p>
  <p class="notice" role="status" data-restore-busy hidden>${t('setup.restore.busy')}</p>
  <p class="setup-actions"><a href="/welcome">${t('setup.restore.cancel')}</a> <button type="submit" class="primary">${t('setup.restore.go')}</button></p>
</form>`);
  }
  if (v.step === 1) {
    return setupFrame(1, html`<h1>${t('setup.name.title')}</h1>
<p class="lede">${t('setup.name.lede')}</p>
<p>${t('setup.name.local', { computer: computerName() })}</p>
<form method="post" action="/welcome/name" class="stack">
  <label for="owner-name">${t('setup.name.label')}</label>
  <input id="owner-name" name="name" maxlength="80" autocomplete="name">
  <p class="setup-actions">${v.restore === 'offer' ? html`<span class="meta">${tHtml('setup.name.coming', { link: html`<a href="/welcome?restore=1">${t('setup.name.haveFolder')}</a>` })}</span>` : ''}<button type="submit" class="primary">${t('setup.next')}</button></p>
</form>`);
  }
  if (v.step === 2) {
    return setupFrame(2, v.models ? modelsStep(v.models) : html`<h1>${t('setup.models.title')}</h1><p>${t('setup.models.keywordsOnly')}</p><p class="setup-actions"><a class="button primary" href="/welcome?step=3">${t('setup.next')}</a></p>`);
  }
  if (v.step === 3) {
    const any = v.tools.some((x) => x.installed);
    return setupFrame(3, html`<h1>${t('setup.connect.title')}</h1>
${v.restored ? ('refused' in v.restored
    ? html`<p class="notice error" role="alert">${v.restored.refused}</p>`
    : html`<p class="notice" role="status">${tHtml('setup.restore.back', { summary: factsAndPagesText(v.restored.facts, v.restored.pages) })}</p>${(v.restored.pictures_missing ?? 0) > 0
      ? html`<p class="notice" role="status">${t('setup.restore.pictures', { count: v.restored.pictures_missing ?? 0 })}</p>` : ''}`) : ''}
${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
${any ? html`<p>${t('setup.connect.found', { computer: computerName() })}</p>` : html`<p>${t('setup.connect.none', { computer: computerName() })}</p>`}
<ul class="group tools">${v.tools.filter((x) => x.installed).map((x) => toolRow(x, 'welcome'))}${chatgptRow(v.windows)}</ul>
<p class="meta">${t('setup.connect.note')}</p>
${v.modelsLine ?? ''}
<p class="setup-actions"><a class="button primary" href="/welcome?step=4">${t('setup.next')}</a></p>`);
  }
  const added = v.tools.filter((x) => x.installed && x.state === 'connected');
  const sentence = t('setup.try.sentence');
  if (added.length === 0) {
    return setupFrame(4, html`<h1>${t('setup.try.title')}</h1>
<p class="notice" role="status">${tHtml('setup.try.none', { link: html`<a href="/welcome?step=3">${t('setup.try.goBack')}</a>` })}</p>
${v.modelsLine ?? ''}
<form method="post" action="/welcome/done" class="setup-actions"><button type="submit" class="primary">${t('setup.try.open')}</button></form>`);
  }
  // Only the tools that have not signed in yet need a hint; when all have, the list is the whole set.
  const hintFor = (added.some((x) => x.signedIn === false) ? added.filter((x) => x.signedIn === false) : added).map((x) => tKey(SIGN_IN_HINT[x.id]));
  return setupFrame(4, html`<h1>${t('setup.try.title')}</h1>
<p>${t('setup.try.open1')}</p>
${copyBox(sentence, 'setup.copy.sentence')}
<p class="conn-setup" data-setup-status="/welcome/first"><span data-state="waiting">${t('setup.try.waiting')}</span></p>
<p class="meta" data-nothing-yet hidden>${t('setup.try.nothing')} ${hintFor.join(' ')}</p>
<p>${tHtml('setup.try.then', { phrase: html`<em>${t('setup.try.knowPhrase')}</em>` })}</p>
${v.modelsLine ?? ''}
<form method="post" action="/welcome/done" class="setup-actions"><button type="submit" class="primary">${t('setup.try.open')}</button></form>`);
}

/** The welcome's waiting line: the first thing an assistant saved, or suggested. */
export function firstLine(v: { memory: { by: string; content: string } | null; suggestion: { by: string; content: string } | null }): SafeHtml {
  if (v.memory) return html`<span class="ok">${t('setup.first.saved', { by: v.memory.by, content: v.memory.content })}</span>`;
  if (v.suggestion) return html`<span class="ok">${t('setup.first.suggested', { by: v.suggestion.by, content: v.suggestion.content })}</span>`;
  return html`<span class="attention" data-state="waiting">${t('setup.try.waiting')}</span>`;
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
  const rerankName = c === null ? '' : c.rerank === null ? '' : c.rerank === 'online' ? t('setup.search.onlineName', { label: online?.label ?? 'OpenRouter' }) : modelLabel(byId(c.rerank));
  const current = c === null ? html`<p class="quiet">${t('setup.search.noneYet')}</p>`
    : c.rerank === null
      ? html`<p>${tHtml('setup.search.inUseNone', { model: html`<strong>${modelLabel(byId(c.search))}</strong>` })}</p>`
      : html`<p>${tHtml('setup.search.inUse', { model: html`<strong>${modelLabel(byId(c.search))}</strong>`, rerank: html`<strong>${rerankName}</strong>` })}</p>`;
  const checked: GroupsInput['rerank'] = c?.rerank === 'online' ? (c.online ? `online:${c.online.model}` : 'none') : c?.rerank ?? 'none';
  const fallback = (id: ModelId) => c?.rerank === 'online' && id === 'mminilm';
  const inUse = (id: ModelId) => c?.search === id || c?.rerank === id;
  const present = CATALOGUE.filter((m) => m.label !== 'Strong' && v.installed.includes(m.id));
  const missing = CATALOGUE.filter((m) => m.label !== 'Strong' && !v.installed.includes(m.id));
  const problem = v.status.onlineProblem === undefined ? '' : html`<p class="notice error" role="alert">${t('setup.search.onlineProblem', { problem: v.status.onlineProblem })}</p>`;
  return html`<section id="search" class="panel">
  <div class="panel-head"><h2>${t('setup.search.head')}</h2></div>
  <p class="meta">${t('setup.search.intro', { computer: computerName() })}</p>
  ${v.said ? html`<p class="notice" role="status">${v.said}</p>` : ''}
  ${current}
  ${modelsLine(v.status, { dataDir: v.dataDir })}
  ${problem}
  <form method="post" action="/settings/search/models" class="stack">
    ${modelGroups({ search: c?.search ?? 'gemma', rerank: checked, installed: v.installed, online: { keySaved: v.keySaved } })}
    <p><button type="submit" class="primary">${t('setup.search.use')}</button> <span class="meta">${t('setup.search.useNote', { computer: computerName() })}</span></p>
  </form>
  <h3 id="search-key">${t('setup.search.keyHead')}</h3>
  <p class="meta">${t('setup.search.keyNote', { computer: computerName() })}</p>
  ${v.keySaved ? html`<p>${t('setup.search.keySaved')}</p>
  <details class="models-all"><summary>${t('setup.tool.replace')}<span class="chev"></span></summary>
    <form method="post" action="/settings/search/key" class="stack"><label for="search-key-new">${t('setup.search.newKey')}</label><input id="search-key-new" type="password" name="key" autocomplete="off" spellcheck="false" required>
    <p><button type="submit">${t('setup.search.replaceKey')}</button></p></form></details>
  <form method="post" action="/settings/search/key/remove" class="inline"><button type="submit" class="secondary">${t('setup.search.remove')}</button></form>`
    : html`<form method="post" action="/settings/search/key" class="stack"><label for="search-key-new">${t('setup.search.key')}</label><input id="search-key-new" type="password" name="key" autocomplete="off" spellcheck="false" required>
    <p><button type="submit">${t('setup.search.saveKey')}</button></p></form>`}
  <h3 id="search-downloaded">${t('setup.search.onComputer', { computer: computerName() })}</h3>
  ${present.length === 0 ? html`<p class="quiet">${t('setup.search.noModels')}</p>` : html`<ul class="group tools">${present.map((m) => html`<li class="tool"><div><strong>${modelLabel(m)}</strong> <span class="meta">${mb(m)} MB · ${m.kind === 'search' ? t('setup.search.kindSearch') : t('setup.search.kindRerank')}</span></div>
    <div>${inUse(m.id) ? html`<span class="meta">${t('setup.search.inUseShort')}</span>` : fallback(m.id) ? html`<span class="meta">${t('setup.search.fallback')}</span>` : html`<form method="post" action="/settings/search/remove" class="inline"><input type="hidden" name="model" value="${m.id}"><button type="submit" class="secondary" aria-label="${t('setup.search.removeModel', { model: modelLabelPlain(m) })}">${t('setup.search.remove')}</button></form>`}</div></li>`)}</ul>`}
  ${missing.length === 0 ? '' : html`<details class="models-all"><summary>${t('setup.search.loadHead')}<span class="chev"></span></summary>
    <p class="meta">${t('setup.search.loadNote')}</p>
    <form method="post" action="/settings/search/load" class="stack">
      <label for="search-load-model">${t('setup.search.model')}</label>
      <select id="search-load-model" name="model">${missing.map((m) => html`<option value="${m.id}">${modelLabel(m)} (${m.kind === 'search' ? t('setup.search.kindSearch') : t('setup.search.kindRerank')})</option>`)}</select>
      <label for="search-load-folder">${t('setup.search.folder')}</label><input id="search-load-folder" name="folder" autocomplete="off" required>
      <p><button type="submit">${t('setup.search.load')}</button></p>
    </form></details>`}
</section>`;
}
