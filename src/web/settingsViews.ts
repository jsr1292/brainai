import type { Health } from '../health/health.js';
import { healthBlock, profileBlock, quietAppsBlock, type ProfileHealth } from './healthViews.js';
import type { QuietApp } from '../health/quietApps.js';
import type { GrantInfo } from '../auth/provider.js';
import type { SessionInfo } from '../auth/sessions.js';
import type { BackupStatus } from '../backupStatus.js';
import type { CopyResult } from '../desktop/backupCopy.js';
import type { Device } from '../folders/devices.js';
import { DAY_MS } from '../folders/match.js';
import { timeOfDay } from '../timezone.js';
import { searchSection, type SearchSectionInput } from './desktopViews.js';
import { backupsPanel, errorBlock, grantCards, plural, sessionCards, when } from './dashboardViews.js';

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
import { basename } from 'node:path';
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { needsLook, type ConnStatus } from './connStatus.js';
import { setupApps } from '../setup/texts.js';
import { thisComputer } from '../desktop/computer.js';
import { spaceBlock, spaceTotalText } from './spaceViews.js';
import type { SpaceBreakdown } from '../diskSpace.js';
import { versionPanel, type VersionPanelInput } from './versionViews.js';

/** "This iPhone", "This Mac"… from a deviceLabel ("iPhone · Safari"), for the section round 2 §11 fills. */
export function thisDevice(label: string): string {
  if (label.startsWith('iPhone')) return 'This iPhone';
  if (label.startsWith('iPad')) return 'This iPad';
  if (label.startsWith('Mac')) return 'This Mac';
  if (label.startsWith('Windows')) return 'This computer';
  return 'This device';
}

/**
 * Settings: only what keeps the brain running, on shelves named for what people look for. The app: this Mac,
 * Assistants, Search, Backups and copies (with Brain health at its end), Other computers, Your login, Remove BrainAI.
 * A server: Assistants, Backups and copies, Other computers, Your login.
 * The Mac gets the left section list; the phone gets an index, each row with a one-line status.
 */
export function settingsView(v: {
  grants: GrantInfo[];
  /** Guided setup (§17b): each live connection's setup text and tool-list status. */
  connStatus?: Map<string, ConnStatus>;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  /** The desktop app: Connections links to Settings › Tools on this Mac. */
  localMode?: boolean;
  /** The app only: Settings › Search. */
  search?: SearchSectionInput;
  projects: string[];
  /** C2: when the owner paused every assistant save (ISO time); null while saving is on. */
  savesPausedSince?: string | null;
  backups?: { status: BackupStatus; health: { ok: boolean; problems: string[] }; offsite: boolean; jobs?: boolean };
  /** The fact/project/page counts line, kept under Backups and health. */
  counts: { facts: number; projects: number; pages: number };
  /** The brain's own address, for the Mac installer command. */
  brainUrl?: string;
  /** The running brain and its database schema, so an update can be checked. */
  version?: { brain: string; database: number };
  /** The Version panel: what runs, the last update check and Check for updates (versionViews). */
  versionPanel?: VersionPanelInput;
  /** Live pictures (ImageStore.totals), for the pictures line under Backups and health. */
  pictures?: { count: number; bytes: number; unused: number };
  devices: Device[];
  /** The viewer's own device, from the request's user agent (deviceLabel): names the first section. */
  device: string;
  /** For how old a device's last report is; without it no report is marked late. */
  now?: Date;
  /** Just after adding a device: its token, shown this once. */
  created?: { name: string; token: string };
  error?: string;
  /** B1: brain health, first in Brain health and backups. */
  health?: Health;
  /** A4: the profile's size and near-identical entries, shown in Brain health. */
  profile?: ProfileHealth;
  /** B1: apps that read the memory a lot this week and saved nothing; `local`: this computer has Settings › Tools. */
  quiet?: { apps: QuietApp[]; local: boolean };
  /** The app only: the second backup folder, how the last copy went, and a synced folder waiting for a yes. */
  copy?: { keep: number; folder: string | null; last: CopyResult | null; ask?: { folder: string; cloud: string }; /** A folder the window's folder picker just chose: put in the box, not saved until the owner presses Save. */ picked?: string };
  /** The app only: whether Reach (phone and web) is on, for the Assistants shelf. */
  reach?: { on: boolean };
  /** The app only: how much space BrainAI uses here; null while it is being worked out; absent on a server. */
  space?: SpaceBreakdown | null;
  /** The app only: Back up now and Show in Finder/Explorer are offered (the shell and the backup folder exist). */
  backupNow?: boolean;
  /** What Back up now and the second folder's form just did, said once (settingsSaid). */
  said?: { backupNow: string | null; copy: string | null };
}): SafeHtml {
  const here = thisComputer();
  const device = thisDevice(v.device);
  // The app: This Mac, Assistants, Search, Backups and copies, Other computers, Your login, Remove. A server has no
  // "this device", Search or Remove: Assistants, Backups and copies, Other computers, Your login. The ids stay as
  // other pages link them (#connections, #health, #setup, #devices, #search, #login).
  const sections: [string, string][] = v.localMode
    ? [['this-device', device], ['connections', 'Assistants'], ...(v.search ? [['search', 'Search'] as [string, string]] : []), ['health', 'Backups and copies'], ...(v.versionPanel ? [['version', 'Version'] as [string, string]] : []), ['devices', 'Other computers'], ['login', 'Your login'], ['remove', `Remove BrainAI from ${here}`]]
    : [['connections', 'Assistants'], ['health', 'Backups and copies'], ...(v.versionPanel ? [['version', 'Version'] as [string, string]] : []), ['devices', 'Other computers'], ['login', 'Your login'], ['this-device', 'This browser']];
  const assistants = v.grants.filter((g) => !g.revokedAt).length;
  const liveDevices = v.devices.filter((x) => x.revokedAt === null).length;
  // Backups only: a dot and the nightly's time when all is well; a dot that needs a look otherwise; nothing set up yet.
  // The content scores (Up to date, Ready, Waiting on you) are under Brain health in the section, never in this line.
  const healthStatus: SafeHtml = v.backups === undefined
    ? html`Not set up`
    : v.backups.health.ok
      ? html`<span class="st-dot ok" aria-hidden="true">●</span> Backups: all fine · ${timeOfDay(v.backups.status.nightly!.at)}`
      : html`<span class="st-dot${v.backups.status.nightly && !v.backups.status.nightly.ok ? ' failed' : ' looks'}" aria-hidden="true">●</span> Backups: needs a look`;
  const statuses: Record<string, SafeHtml> = {
    'this-device': v.localMode ? html`<span data-space-status>${[v.version ? `BrainAI ${v.version.brain}` : '', spaceTotalText(v.space)].filter(Boolean).join(' · ')}</span>` : html``,
    connections: [...(v.connStatus?.values() ?? [])].some(needsLook)
      ? html`<span class="st-dot looks" aria-hidden="true">●</span> Needs a look`
      // On the app, tools can be added without being signed in yet (the page says so after its own check): "None" would be wrong, so nothing is said.
      : html`${assistants === 0 ? (v.localMode ? '' : 'None') : plural(assistants, 'assistant', 'assistants')}`,
    search: html`${v.search ? searchStatus(v.search) : ''}`,
    devices: html`${liveDevices === 0 ? 'None yet' : plural(liveDevices, 'computer', 'computers')}`,
    health: healthStatus,
    version: html`${v.version ? `BrainAI ${v.version.brain}` : ''}`,
    login: html`${v.sessions.length} ${v.sessions.length === 1 ? 'browser' : 'browsers'} signed in`,
    remove: html``,
  };
   const indexRow = ([id, label]: [string, string]) =>
    html`<li${!v.localMode && id === 'this-device' ? html` class="desk-only"` : ''}><a class="row" href="#${id}"><span class="txt">${label}</span><span class="st">${statuses[id]}</span><span class="chev"></span></a></li>`;
  // Pictures (round 2 section 12): once the nightly backup counts them, where they are kept and last night's check.
  // The Review line shows whenever a picture is unused, nightly or not (a nightly without a picture count). Each
  // sentence is one <span>, because .meta is a flex row that would otherwise split it at its link or time.
  const nightly = v.backups?.status.nightly;
  const pics = v.pictures;
  const keptLine = nightly?.counts?.images !== undefined && pics
    ? html`<p class="meta"><span>Pictures: ${pics.count} · ${sizeText(pics.bytes)}. Kept next to the database, in the nightly backups and in the weekly off-site copy. The git export links to them but doesn't hold them. Last checked ${when(nightly.at)}: ${nightly.pictures && nightly.pictures.missing > 0 ? `${nightly.pictures.missing} missing` : `all ${pics.count} present`}.</span></p>`
    : '';
  const reviewLine = pics && pics.unused > 0
    ? html`<p class="meta"><span>${plural(pics.unused, 'picture', 'pictures')} no current page shows <a href="/settings/pictures">Review</a></span></p>`
    : '';
  const picturesLine = html`${keptLine}${reviewLine}`;
  const counts = html`<p class="meta">${plural(v.counts.facts, 'fact', 'facts')} · ${plural(v.counts.projects, 'project', 'projects')} · ${plural(v.counts.pages, 'page', 'pages')}</p>`;
  const saveRow = v.localMode ? '' : html`<ul class="group"><li><a class="row nolead" href="/import"><span class="txt">Import<span class="sub">Bring in ChatGPT, Claude or Gemini memory, project folders, or a file</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/save"><span class="txt">Save a copy of everything<span class="sub">Every memory and page, to keep or take elsewhere</span></span><span class="chev"></span></a></li></ul>`;
  const saidLine = (text: string | null | undefined): SafeHtml => (text ? html`<p class="notice" role="status">${text}</p>` : html``);
  const copyLast = !v.copy?.last ? ''
    : v.copy.last.ok ? html`<p class="meta"><span>Last copy: ${when(v.copy.last.at)}</span></p>`
    : html`<p class="error" role="alert">Last copy failed: ${basename(v.copy.last.folder) || v.copy.last.folder} (${when(v.copy.last.at)}). ${v.copy.last.reason} The normal backup was still made.</p>`;
  const copySection = !v.copy ? '' : v.copy.ask
    ? html`<h3 id="backup-copy">Also keep the daily backups in</h3>
<p class="error" role="alert">This folder syncs to ${v.copy.ask.cloud}: every memory will be stored there in clear text.</p>
<p class="meta"><span class="path">${v.copy.ask.folder}</span></p>
<form method="post" action="/settings/backup-copy" class="stack">
  <input type="hidden" name="folder" value="${v.copy.ask.folder}"><input type="hidden" name="confirm" value="1">
  <p><button type="submit" name="action" value="save" class="primary">Keep it</button> <a href="/settings#backup-copy">Choose another</a></p>
</form>`
    : html`<h3 id="backup-copy">Also keep the daily backups in</h3>
${saidLine(v.said?.copy)}
${v.copy.folder
    ? html`<p class="meta">A second folder, such as an external drive. Each daily backup is copied there once it is made. It keeps the newest ${v.copy.keep} memory-….db files there and removes older ones; nothing else in the folder is touched.</p>`
    : html`<p class="meta">Right now every backup is on ${here}. If the disk fails, they go with it. Pick a folder that syncs elsewhere (OneDrive, Dropbox) or an external drive. Each daily backup is copied there once it is made. It keeps the newest ${v.copy.keep} memory-….db files there and removes older ones; nothing else in the folder is touched.</p>`}
<form method="post" action="/settings/backup-copy" class="stack">
  <label for="backup-copy-folder">Folder (the full path)</label>
  ${v.copy.picked !== undefined ? html`<p class="notice" role="status">Chosen just now, not saved yet. Press Save to use it.</p>${v.copy.folder ? html`<p class="meta"><span>Saved now: <span class="path">${v.copy.folder}</span></span></p>` : ''}` : ''}
  <div class="folder-pick"><input id="backup-copy-folder" name="folder" value="${v.copy.picked ?? v.copy.folder ?? ''}" autocomplete="off" required><a class="button secondary" href="/app/choose-folder" data-choose-folder data-desk-native>Choose folder…</a></div>
  <p><button type="submit" name="action" value="save" class="primary">Save</button>${v.copy.folder ? html` <button type="submit" name="action" value="off" formnovalidate>Turn off</button>` : ''}</p>
</form>
${copyLast}`;
  // Brain health (7.2): how well the content is kept, apart from the backups above it.
  const brainHealth = html`<h3 id="brain-health">Brain health</h3>
<p class="meta">How well the memories are kept: not about the backups.</p>
${healthBlock(v.health)}
${profileBlock(v.profile) ?? ''}
${quietAppsBlock(v.quiet?.apps, v.quiet?.local ?? false) ?? ''}`;
  // Pictures sit with the counts: the nightly backup counts them.
  const sizeLines = html`${counts}${picturesLine}`;
  const restoreLine = html`<p class="meta"><span>To get a backup back: install BrainAI, choose <em>I have a saved BrainAI folder</em> on the welcome, and pick the file.</span></p>`;
  const serverOnly = html`<p class="meta"><span>Off-site and git copies are for a server: <a href="https://github.com/jsr1292/brainai/blob/main/docs/RUNBOOK.md" target="_blank" rel="noopener">see the runbook</a>.</span></p>`;
  const dailyLine = (): SafeHtml => {
    const n = v.backups?.status.nightly;
    const state = !n ? html`<span class="quiet">not yet</span>`
      : n.ok ? html`${when(n.at)} <span class="place">✓</span>` : html`${when(n.at)} <span class="place bad">failed ✗</span>`;
    return html`<p class="daily"><span class="label-inline">Daily backup:</span> ${state}</p><p class="meta">Every night, in BrainAI's own folder on ${here}.</p>${v.backups && !v.backups.health.ok ? html`<ul class="problems">${v.backups.health.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}`;
  };
  const backupActions = v.backupNow
    ? html`${saidLine(v.said?.backupNow)}<div class="bk-actions"><form method="post" action="/settings/backup-now"><button type="submit">Back up now</button></form><a class="button secondary" href="/app/reveal-backups" data-reveal-backups data-desk-native>Show in ${v.device.startsWith('Windows') ? 'Explorer' : 'Finder'}</a></div>`
    : '';
  const localRows = html`<ul class="group"><li><a class="row nolead" href="/import"><span class="txt">Import<span class="sub">Bring in ChatGPT, Claude or Gemini memory, project folders, or a file</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/save"><span class="txt">Save a copy of everything<span class="sub">Every memory and page, to keep or take elsewhere</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/move"><span class="txt">Move to a server<span class="sub">Take every memory to a home or rented server, always on</span></span><span class="chev"></span></a></li></ul>`;
  // On a server there is no second-folder block; a link to #backup-copy (the first steps' backup step) lands on Backups and copies.
  const copyAnchor = v.localMode ? '' : html`<span id="backup-copy"></span>`;
  const health = v.localMode
    ? html`<section id="health" class="panel backups${!v.backups || v.backups.health.ok ? '' : ' attention'}">
  <div class="panel-head"><h2>Backups and copies</h2></div>
  ${v.backups ? dailyLine() : html`<p class="quiet">No backup folder is set up.</p>`}
  ${backupActions}
  ${copySection}
  ${localRows}
  ${restoreLine}
  ${serverOnly}
  ${sizeLines}
  ${brainHealth}
</section>`
    : v.backups
      ? backupsPanel(v.backups, { id: 'health', title: 'Backups and copies', extra: html`${copyAnchor}${saveRow}`, after: html`${sizeLines}${brainHealth}` })
      : html`<section id="health" class="panel"><div class="panel-head"><h2>Backups and copies</h2></div>${copyAnchor}${saveRow}${sizeLines}${brainHealth}</section>`;
  const reachOn = v.reach?.on === true;
  const assistantsBody = v.localMode
    ? html`<p class="meta">The AI apps that can use your brain.</p>
  <div data-added-tools="/settings/tools/added"></div>
  <h3 id="assistants-here">On ${here} · one click, no Reach needed</h3>
  <ul class="group"><li><a class="row nolead" href="/settings/tools"><span class="txt">Tools on ${here}<span class="sub">Connect Claude Code, Codex, OpenCode, Cursor and Claude's desktop app in one click</span></span><span class="chev"></span></a></li></ul>
  <h3 id="assistants-web">On the web and phone · needs Reach</h3>
  <ul class="group"><li><a class="row nolead" href="/settings/reach"><span class="txt">Claude · ChatGPT · Grok<span class="sub">They run in the cloud and can't see ${here} until Reach is on. Reach is ${reachOn ? 'on' : 'off'}.</span></span><span class="chev"></span></a></li></ul>
  <p><a class="button${reachOn ? ' secondary' : ''}" href="/settings/reach">${reachOn ? 'Reach settings' : 'Turn on Reach'}</a></p>
  <h3 id="setup">Set up an app</h3>
  <p class="meta">Connecting from another computer, or by hand? Pick the app.</p>`
    : html`<p class="meta">The assistants that can use the brain, and what each may do.</p>
  <h3 id="setup">Set up an app</h3>`;
  const pauseSwitch = v.savesPausedSince
    ? html`<h3 id="pause-saves">Saves from assistants</h3>
  <p class="notice" role="status">Saving is paused since ${when(v.savesPausedSince)}: every assistant that tries to save, change or forget something is told so and nothing is saved. Reading still works.</p>
  <form method="post" action="/settings/pause/resume"><button type="submit" class="primary">Resume saves</button></form>`
    : html`<h3 id="pause-saves">Saves from assistants</h3>
  <p class="meta">Stops every assistant from saving, changing or forgetting anything until you resume. They can still read, and are told what to do.</p>
  <form method="post" action="/settings/pause"><button type="submit" class="secondary">Pause all saves from assistants</button></form>`;
  const connectionsList = html`${pauseSwitch}<h3 id="connections-list">Connections</h3>
  ${grantCards({ grants: v.grants, projects: v.projects, status: v.connStatus })}`;
  // On a server this is only the home of desk.js's two switches (keyboard shortcuts, things beside the list): a wide window's.
  const thisDeviceSection = !v.localMode ? html`<section id="this-device" class="panel desk-only">
  <div class="panel-head"><h2>This browser</h2></div>
  <p class="meta">What this browser does when the window is wide.</p>
</section>` : html`<section id="this-device" class="panel">
  <div class="panel-head"><h2>${device}</h2></div>
  <p class="meta">BrainAI runs here, in the menu bar or tray. Its data, backups and search models live in its own folder on ${here}.</p>
  ${v.space === undefined ? '' : spaceBlock(v.space)}
</section>`;
  const removeSection = !v.localMode ? '' : html`<section id="remove" class="panel danger-zone">
  <div class="panel-head"><h2>Remove BrainAI from ${here}</h2></div>
  <p class="meta">Save a copy, then disconnect your tools and finish.</p>
  <p><a class="button danger-link" href="/settings/remove">Remove BrainAI from ${here}…</a></p>
</section>`;
  return html`<div class="settings wide">
<nav class="settings-nav" aria-label="Settings">${sections.map(([id, label]) => html`<a href="#${id}"${id === 'remove' ? html` class="warn"` : ''}>${label}</a>`)}</nav>
<div class="settings-body">
<h1>Settings</h1>
<p class="lede">Everything that keeps the brain running. You only need to come here when something asks for you.</p>
${errorBlock(v.error)}
<ul class="group settings-index">${sections.map(indexRow)}</ul>
${v.localMode ? thisDeviceSection : ''}
<section id="connections" class="panel">
  <div class="panel-head"><h2>Assistants</h2></div>
  ${assistantsBody}
  <ul class="group">${setupApps().map((a) => html`<li><a class="row nolead" href="/settings/setup/${a.slug}"><span class="txt">${a.name}</span><span class="chev"></span></a></li>`)}</ul>
  ${connectionsList}
</section>
${v.search ? searchSection(v.search) : ''}
${health}
${v.versionPanel ? versionPanel(v.versionPanel) : ''}
${devicesSection(v.devices, v.created, v.now, v.brainUrl)}
<section id="login" class="panel">
  <div class="panel-head"><h2>Your login</h2></div>
  ${sessionCards({ sessions: v.sessions, currentSessionId: v.currentSessionId })}
</section>
${v.localMode ? '' : thisDeviceSection}
${removeSection}
</div>
</div>`;
}

/** Settings › Other computers: the Mac and anything else allowed to send folder reports; a new token is shown once. */
function devicesSection(devices: Device[], created?: { name: string; token: string }, now?: Date, brainUrl = 'https://your-brain.example'): SafeHtml {
  // A report more than a day old: the reporter may have stopped (python broken, token replaced), and the projects'
  // git state is that old too.
  const late = (iso: string): SafeHtml => {
    const days = now ? Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS) : 0;
    return days >= 1 ? html` <strong class="late-text">no report for ${plural(days, 'day', 'days')}: is the reporter still running?</strong>` : html``;
  };
  const live = devices.filter((x) => x.revokedAt === null);
  return html`<section id="devices" class="panel">
  <div class="panel-head"><h2>Other computers</h2></div>
  <p class="meta">Add a computer so BrainAI knows which project folders are on it, and so the skills you turn on reach it. Each one gets a token that can only send folder reports and receive those skills.</p>
  ${created ? html`<div class="token-once"><p><strong>Copy this token now. It is shown once.</strong> On the Mac, in your copy of the BrainAI repository, run:</p>
  <pre><code>scripts/mac/install-folder-report.sh --url ${brainUrl} <span class="token-arg">TOKEN</span></code></pre><p>with this token for “${created.name}”:</p><code class="token">${created.token}</code></div>` : ''}
  ${live.length === 0 ? html`<p class="quiet">No other computers yet.</p>` : html`<ul class="rows devices">${live.map((x) => html`<li><span class="dev-name">${x.name}</span>
    ${metaLine([html`added ${when(x.createdAt)}`, x.lastReportAt ? html`last report ${when(x.lastReportAt)}` : 'never reported'])}${x.lastReportAt ? late(x.lastReportAt) : ''}
    <form method="post" action="/settings/devices/${x.id}/revoke"><button type="submit" class="secondary" aria-label="Revoke the computer ${x.name}">Revoke</button></form></li>`)}</ul>`}
  <form method="post" action="/settings/devices" class="add-device"><label>Name <input name="name" maxlength="60" value="Mac" required></label><button type="submit">Add a computer</button></form>
</section>`;
}

/** The phone index's one-line status for Search. */
function searchStatus(v: SearchSectionInput): string {
  const s = v.status;
  if (s.onlineProblem !== undefined || s.problem !== undefined) return 'Needs a look';
  if (s.choice === null) return 'Not set up';
  return s.searchReady ? 'Ready' : 'Getting ready';
}
