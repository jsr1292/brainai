import type { Health } from '../health/health.js';
import { healthBlock } from './healthViews.js';
import type { GrantInfo } from '../auth/provider.js';
import type { SessionInfo } from '../auth/sessions.js';
import type { BackupStatus } from '../backupStatus.js';
import type { Device } from '../folders/devices.js';
import { DAY_MS } from '../folders/match.js';
import { timeOfDay } from '../timezone.js';
import { backupsPanel, errorBlock, grantCards, plural, sessionCards, when } from './dashboardViews.js';

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
import { html, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { needsLook, type ConnStatus } from './connStatus.js';
import { setupApps } from '../setup/texts.js';
import { thisComputer } from '../desktop/computer.js';

/** "This iPhone", "This Mac"… from a deviceLabel ("iPhone · Safari"), for the section round 2 §11 fills. */
export function thisDevice(label: string): string {
  if (label.startsWith('iPhone')) return 'This iPhone';
  if (label.startsWith('iPad')) return 'This iPad';
  if (label.startsWith('Mac')) return 'This Mac';
  return 'This device';
}

/**
 * Settings: only what keeps the brain running. Five sections (four in work mode, which has no offline copy):
 * this device (a placeholder until round 2 §11), connections, devices, backups and health, your login.
 * The Mac gets the left section list; the phone gets a five-row index, each row with a one-line status.
 */
export function settingsView(v: {
  grants: GrantInfo[];
  /** Guided setup (§17b): each live connection's setup text and tool-list status. */
  connStatus?: Map<string, ConnStatus>;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  work: boolean;
  /** The desktop app: Connections links to Settings › Tools on this Mac. */
  localMode?: boolean;
  projects: string[];
  backups?: { status: BackupStatus; health: { ok: boolean; problems: string[] }; offsite: boolean; jobs?: boolean };
  /** The fact/project/page counts line, kept under Backups and health. */
  counts: { facts: number; projects: number; pages: number };
  /** The brain's own address, for the Mac installer command. */
  brainUrl?: string;
  /** The running brain and its database schema, so an update can be checked. */
  version?: { brain: string; database: number };
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
}): SafeHtml {
  const device = thisDevice(v.device);
  const sections: [string, string][] = v.work
    ? [['connections', 'Connections'], ['devices', 'Devices'], ['health', 'Brain health and backups'], ['login', 'Your login']]
    : [['this-device', device], ['connections', 'Connections'], ['devices', 'Devices'], ['health', 'Brain health and backups'], ['login', 'Your login']];
  const assistants = v.grants.filter((g) => !g.revokedAt).length;
  const liveDevices = v.devices.filter((x) => x.revokedAt === null).length;
  // Backups: a dot and the nightly's time when all is well; a dot that needs a look otherwise; nothing set up yet.
  const healthStatus: SafeHtml = v.backups === undefined
    ? html`Not set up`
    : v.backups.health.ok
      ? html`<span class="st-dot ok" aria-hidden="true">●</span> All fine · ${timeOfDay(v.backups.status.nightly!.at)}`
      : html`<span class="st-dot${v.backups.status.nightly && !v.backups.status.nightly.ok ? ' failed' : ' looks'}" aria-hidden="true">●</span> Needs a look`;
  const statuses: Record<string, SafeHtml> = {
    'this-device': html`Not set up yet`,
    connections: [...(v.connStatus?.values() ?? [])].some(needsLook)
      ? html`<span class="st-dot looks" aria-hidden="true">●</span> Needs a look`
      : html`${assistants === 0 ? 'None' : plural(assistants, 'assistant', 'assistants')}`,
    devices: html`${liveDevices === 0 ? 'None yet' : plural(liveDevices, 'device', 'devices')}`,
    health: healthStatus,
    login: html`${plural(v.sessions.length, 'device', 'devices')}`,
  };
  const indexRow = ([id, label]: [string, string]) =>
    html`<li><a class="row" href="#${id}"><span class="txt">${label}</span><span class="st">${statuses[id]}</span><span class="chev"></span></a></li>`;
  // Pictures (round 2 section 12): once the nightly backup counts them, where they are kept and last night's check.
  // The Review line shows whenever a picture is unused, nightly or not (the work brain has no picture count). Each
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
  const size = html`<p class="meta">${plural(v.counts.facts, 'fact', 'facts')} · ${plural(v.counts.projects, 'project', 'projects')} · ${plural(v.counts.pages, 'page', 'pages')}</p>${picturesLine}${v.version ? html`<p class="meta">BrainAI ${v.version.brain} · database ${v.version.database}</p>` : ''}`;
  const health = v.backups
    ? backupsPanel(v.backups, { id: 'health', title: 'Brain health and backups', extra: html`${healthBlock(v.health)}${size}` })
    : html`<section id="health" class="panel"><div class="panel-head"><h2>Brain health and backups</h2></div>${healthBlock(v.health)}${size}</section>`;
  return html`<div class="settings wide">
<nav class="settings-nav" aria-label="Settings">${sections.map(([id, label]) => html`<a href="#${id}">${label}</a>`)}</nav>
<div class="settings-body">
<h1>Settings</h1>
<p class="lede">Everything that keeps the brain running. You only need to come here when something asks for you.</p>
${errorBlock(v.error)}
<ul class="group settings-index">${sections.map(indexRow)}</ul>
${v.work ? '' : html`<section id="this-device" class="panel">
  <div class="panel-head"><h2>${device}</h2></div>
  <p class="quiet">Offline reading isn't here yet. When it comes, this is where you keep a copy of the brain on this ${device.slice(5)}.</p>
</section>`}
<section id="connections" class="panel">
  <div class="panel-head"><h2>Connections</h2></div>
  <p class="meta">The assistants that can use the brain, and what each may do.</p>
  ${grantCards({ grants: v.grants, work: v.work, projects: v.projects, status: v.connStatus })}
  ${v.localMode ? html`<ul class="group"><li><a class="row nolead" href="/settings/tools"><span class="txt">Tools on ${thisComputer()}</span><span class="meta">Connect Claude Code, Codex, OpenCode and Cursor in one click</span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/reach"><span class="txt">Reach from phone and web</span><span class="meta">Use this BrainAI from Claude, ChatGPT and Grok anywhere</span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/move"><span class="txt">Move to a server</span><span class="meta">Take every memory to a home or rented server</span><span class="chev"></span></a></li></ul>` : ''}
  <h3 id="setup">Set up an app</h3>
  <ul class="group">${setupApps(v.work ? 'work' : 'personal').map((a) => html`<li><a class="row nolead" href="/settings/setup/${a.slug}"><span class="txt">${a.name}</span><span class="chev"></span></a></li>`)}</ul>
</section>
${devicesSection(v.devices, v.created, v.now, v.brainUrl)}
${health}
<section id="login" class="panel">
  <div class="panel-head"><h2>Your login</h2></div>
  ${sessionCards({ sessions: v.sessions, currentSessionId: v.currentSessionId })}
</section>
</div>
</div>`;
}

/** Settings › Devices: the Mac and anything else allowed to send folder reports; a new token is shown once. */
function devicesSection(devices: Device[], created?: { name: string; token: string }, now?: Date, brainUrl = 'https://your-brain.example'): SafeHtml {
  // A report more than a day old: the reporter may have stopped (python broken, token replaced), and the projects'
  // git state is that old too.
  const late = (iso: string): SafeHtml => {
    const days = now ? Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS) : 0;
    return days >= 1 ? html` <strong class="late-text">no report for ${plural(days, 'day', 'days')}: is the reporter still running?</strong>` : html``;
  };
  const live = devices.filter((x) => x.revokedAt === null);
  return html`<section id="devices" class="panel">
  <div class="panel-head"><h2>Devices</h2></div>
  <p class="meta">Computers that report which folders are in ~/Projects and their git state, and keep the skills you share in step. A device token can only send those reports and receive the skills that are On.</p>
  ${created ? html`<div class="token-once"><p><strong>Copy this token now. It is shown once.</strong> On the Mac, in your copy of the BrainAI repository, run:</p>
  <pre><code>scripts/mac/install-folder-report.sh --url ${brainUrl} <span class="token-arg">TOKEN</span></code></pre><p>with this token for “${created.name}”:</p><code class="token">${created.token}</code></div>` : ''}
  ${live.length === 0 ? html`<p class="quiet">No devices yet.</p>` : html`<ul class="rows devices">${live.map((x) => html`<li><span class="dev-name">${x.name}</span>
    ${metaLine([html`added ${when(x.createdAt)}`, x.lastReportAt ? html`last report ${when(x.lastReportAt)}` : 'never reported'])}${x.lastReportAt ? late(x.lastReportAt) : ''}
    <form method="post" action="/settings/devices/${x.id}/revoke"><button type="submit" class="secondary" aria-label="Revoke the device ${x.name}">Revoke</button></form></li>`)}</ul>`}
  <form method="post" action="/settings/devices" class="add-device"><label>Name <input name="name" maxlength="60" value="Mac" required></label><button type="submit">Add a device</button></form>
</section>`;
}
