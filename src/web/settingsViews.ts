import type { Say } from '../i18n/errors.js';
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
import { backupsPanel, errorBlock, okMark, grantCards, sessionCards, when } from './dashboardViews.js';

import { basename } from 'node:path';
import { fmt } from '../i18n/fmt.js';
import { t, tKey } from '../i18n/core.js';
import { UI_LANGUAGES, type UiLanguage } from '../i18n/uiLanguage.js';
import { THEME_CHOICES, type ThemeChoice } from './theme.js';
import { html, raw, type SafeHtml } from './html.js';
import { metaLine } from './metaLine.js';
import { needsLook, type ConnStatus } from './connStatus.js';
import { setupApps } from '../setup/texts.js';
import { computerName } from '../desktop/computer.js';
import { backupProblems, copyWhyText } from './errorText.js';
import { tHtml } from '../i18n/tHtml.js';
import { spaceBlock, spaceTotalText } from './spaceViews.js';
import type { SpaceBreakdown } from '../diskSpace.js';
import { versionPanel, type VersionPanelInput } from './versionViews.js';

const sizeText = (bytes: number) => fmt.size(bytes);

/** "This iPhone", "This Mac"… from a deviceLabel ("iPhone · Safari"), for the section round 2 §11 fills. */
export function thisDevice(label: string): string {
  if (label.startsWith('iPhone')) return t('settings.thisIphone');
  if (label.startsWith('iPad')) return t('settings.thisIpad');
  if (label.startsWith('Mac')) return t('settings.thisMac');
  if (label.startsWith('Windows')) return t('settings.thisComputer');
  return t('settings.thisDevice');
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
  backups?: { status: BackupStatus; health: { ok: boolean; problems: string[]; say?: Say[] }; offsite: boolean; jobs?: boolean };
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
  /** Settings › Language: the owner's stored choice (auto, English or Español). */
  language?: { choice: UiLanguage };
  /** Settings › Appearance: this browser's choice of look (the `theme` cookie). */
  appearance?: { choice: ThemeChoice };
  /** Settings › Developer coaching: whether the brain-wide switch is on. */
  coaching?: { on: boolean };
  /** Desktop app only: whether the Monday notification is on. */
  weekNotice?: { on: boolean };
}): SafeHtml {
  const here = computerName();
  const device = thisDevice(v.device);
  // The app: This Mac, Assistants, Search, Backups and copies, Other computers, Your login, Remove. A server has no
  // "this device", Search or Remove: Assistants, Backups and copies, Other computers, Your login. The ids stay as
  // other pages link them (#connections, #health, #setup, #devices, #search, #login).
  const sections: [string, string][] = v.localMode
    ? [['this-device', device], ['connections', t('settings.sec.assistants')], ...(v.search ? [['search', t('settings.sec.search')] as [string, string]] : []), ['health', t('settings.sec.backups')], ...(v.versionPanel ? [['version', t('settings.sec.version')] as [string, string]] : []), ['devices', t('settings.sec.devices')], ['login', t('settings.sec.login')], ['language', t('lang.title')], ['appearance', t('theme.title')], ['coaching', t('coaching.title')], ['remove', t('settings.sec.remove', { here })]]
    : [['connections', t('settings.sec.assistants')], ['health', t('settings.sec.backups')], ...(v.versionPanel ? [['version', t('settings.sec.version')] as [string, string]] : []), ['devices', t('settings.sec.devices')], ['login', t('settings.sec.login')], ['language', t('lang.title')], ['appearance', t('theme.title')], ['coaching', t('coaching.title')], ['this-device', t('settings.thisBrowser')]];
  const assistants = v.grants.filter((g) => !g.revokedAt).length;
  const liveDevices = v.devices.filter((x) => x.revokedAt === null).length;
  // Backups only: a dot and the nightly's time when all is well; a dot that needs a look otherwise; nothing set up yet.
  // The content scores (Up to date, Ready, Waiting on you) are under Brain health in the section, never in this line.
  const healthStatus: SafeHtml = v.backups === undefined
    ? html`${t('settings.st.notSetUp')}`
    : v.backups.health.ok
      ? html`<span class="st-dot ok" aria-hidden="true">●</span> ${t('settings.st.backupsFine')} · ${timeOfDay(v.backups.status.nightly!.at)}`
      : html`<span class="st-dot${v.backups.status.nightly && !v.backups.status.nightly.ok ? ' failed' : ' looks'}" aria-hidden="true">●</span> ${t('settings.st.backupsLook')}`;
  const statuses: Record<string, SafeHtml> = {
    'this-device': v.localMode ? html`<span data-space-status>${[v.version ? `BrainAI ${v.version.brain}` : '', spaceTotalText(v.space)].filter(Boolean).join(' · ')}</span>` : html``,
    connections: [...(v.connStatus?.values() ?? [])].some(needsLook)
      ? html`<span class="st-dot looks" aria-hidden="true">●</span> ${t('settings.st.needsLook')}`
      // On the app, tools can be added without being signed in yet (the page says so after its own check): "None" would be wrong, so nothing is said.
      : html`${assistants === 0 ? (v.localMode ? '' : t('settings.st.none')) : t('settings.n.assistants', { count: assistants })}`,
    search: html`${v.search ? searchStatus(v.search) : ''}`,
    devices: html`${liveDevices === 0 ? t('settings.st.noneYet') : t('settings.n.computers', { count: liveDevices })}`,
    health: healthStatus,
    version: html`${v.version ? `BrainAI ${v.version.brain}` : ''}`,
    login: html`${t('settings.n.browsers', { count: v.sessions.length })}`,
    language: html`${v.language ? languageName(v.language.choice) : ''}`,
    appearance: html`<span data-theme-status>${themeName(v.appearance?.choice ?? 'auto')}</span>`,
    coaching: html`${v.coaching?.on ? t('coaching.status.on') : t('coaching.status.off')}`,
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
    ? html`<p class="meta"><span>${tHtml('settings.pics.kept', { n: pics.count, size: sizeText(pics.bytes), when: when(nightly.at), result: nightly.pictures && nightly.pictures.missing > 0 ? t('settings.pics.missing', { n: nightly.pictures.missing }) : t('settings.pics.allPresent', { n: pics.count }) })}</span></p>`
    : '';
  const reviewLine = pics && pics.unused > 0
    ? html`<p class="meta"><span>${tHtml('settings.pics.unused', { count: pics.unused, link: html`<a href="/settings/pictures">${t('settings.pics.review')}</a>` })}</span></p>`
    : '';
  const picturesLine = html`${keptLine}${reviewLine}`;
  const counts = html`<p class="meta">${t('settings.n.facts', { count: v.counts.facts })} · ${t('settings.n.projects', { count: v.counts.projects })} · ${t('settings.n.pages', { count: v.counts.pages })}</p>`;
  const saveRow = v.localMode ? '' : html`<ul class="group"><li><a class="row nolead" href="/import"><span class="txt">${t('settings.row.import')}<span class="sub">${t('settings.row.importSub')}</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/save"><span class="txt">${t('settings.row.save')}<span class="sub">${t('settings.row.saveSub')}</span></span><span class="chev"></span></a></li></ul>`;
  const saidLine = (text: string | null | undefined): SafeHtml => (text ? html`<p class="notice" role="status">${text}</p>` : html``);
  const copyLast = !v.copy?.last ? ''
    : v.copy.last.ok ? html`<p class="meta"><span>${tHtml('settings.copy.last', { when: when(v.copy.last.at) })}</span></p>`
    : html`<p class="error" role="alert">${tHtml('settings.copy.failed', { folder: basename(v.copy.last.folder) || v.copy.last.folder, when: when(v.copy.last.at), reason: copyWhyText(v.copy.last.why) })}</p>`;
  const copySection = !v.copy ? '' : v.copy.ask
    ? html`<h3 id="backup-copy">${t('settings.copy.title')}</h3>
<p class="error" role="alert">${t('settings.copy.cloud', { cloud: v.copy.ask.cloud })}</p>
<p class="meta"><span class="path">${v.copy.ask.folder}</span></p>
<form method="post" action="/settings/backup-copy" class="stack">
  <input type="hidden" name="folder" value="${v.copy.ask.folder}"><input type="hidden" name="confirm" value="1">
  <p><button type="submit" name="action" value="save" class="primary">${t('settings.copy.keepIt')}</button> <a href="/settings#backup-copy">${t('settings.copy.another')}</a></p>
</form>`
    : html`<h3 id="backup-copy">${t('settings.copy.title')}</h3>
${saidLine(v.said?.copy)}
<p class="meta">${t('settings.copy.clear')}</p>
${v.copy.folder
    ? html`<p class="meta">${t('settings.copy.about', { keep: v.copy.keep })}</p>`
    : html`<p class="meta">${t('settings.copy.aboutNone', { here, keep: v.copy.keep })}</p>`}
<form method="post" action="/settings/backup-copy" class="stack">
  <label for="backup-copy-folder">${t('settings.copy.folder')}</label>
  ${v.copy.picked !== undefined ? html`<p class="notice" role="status">${t('settings.copy.picked')}</p>${v.copy.folder ? html`<p class="meta"><span>${tHtml('settings.copy.savedNow', { path: html`<span class="path">${v.copy.folder}</span>` })}</span></p>` : ''}` : ''}
  <div class="folder-pick"><input id="backup-copy-folder" name="folder" value="${v.copy.picked ?? v.copy.folder ?? ''}" autocomplete="off" required><a class="button secondary" href="/app/choose-folder" data-choose-folder data-desk-native>${t('settings.copy.choose')}</a></div>
  <p><button type="submit" name="action" value="save" class="primary">${t('settings.save')}</button>${v.copy.folder ? html` <button type="submit" name="action" value="off" formnovalidate>${t('settings.copy.off')}</button>` : ''}</p>
</form>
${copyLast}`;
  // Brain health (7.2): how well the content is kept, apart from the backups above it.
  const brainHealth = html`<h3 id="brain-health">${t('settings.bh.title')}</h3>
<p class="meta">${t('settings.bh.about')}</p>
${healthBlock(v.health)}
${profileBlock(v.profile) ?? ''}
${quietAppsBlock(v.quiet?.apps, v.quiet?.local ?? false) ?? ''}`;
  // Pictures sit with the counts: the nightly backup counts them.
  const sizeLines = html`${counts}${picturesLine}`;
  const restoreLine = html`<p class="meta"><span>${tHtml('settings.restore', { choice: html`<em>${t('settings.restore.choice')}</em>` })}</span></p>`;
  const serverOnly = html`<p class="meta"><span>${tHtml('settings.serverOnly', { link: html`<a href="https://github.com/jsr1292/brainai/blob/main/docs/RUNBOOK.md" target="_blank" rel="noopener">${t('settings.runbook')}</a>` })}</span></p>`;
  const dailyLine = (): SafeHtml => {
    const n = v.backups?.status.nightly;
    const state = !n ? html`<span class="quiet">${t('settings.daily.notYet')}</span>`
      : n.ok ? html`${when(n.at)} <span class="place">${okMark('copied')}</span>` : html`${when(n.at)} <span class="place bad"><span aria-hidden="true">✗</span> ${t('settings.daily.failed')}</span>`;
    return html`<p class="daily"><span class="label-inline">${t('settings.daily.label')}</span> ${state}</p><p class="meta">${tHtml('settings.daily.where', { here: computerName() })}</p>${v.backups && !v.backups.health.ok ? html`<ul class="problems">${backupProblems(v.backups.health).map((p) => html`<li>${p}</li>`)}</ul>` : ''}`;
  };
  const backupActions = v.backupNow
    ? html`${saidLine(v.said?.backupNow)}<div class="bk-actions"><form method="post" action="/settings/backup-now"><button type="submit">${t('settings.backupNow')}</button></form><a class="button secondary" href="/app/reveal-backups" data-reveal-backups data-desk-native>${v.device.startsWith('Windows') ? t('settings.showExplorer') : t('settings.showFinder')}</a></div>`
    : '';
  const localRows = html`<ul class="group"><li><a class="row nolead" href="/import"><span class="txt">${t('settings.row.import')}<span class="sub">${t('settings.row.importSub')}</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/save"><span class="txt">${t('settings.row.save')}<span class="sub">${t('settings.row.saveSub')}</span></span><span class="chev"></span></a></li><li><a class="row nolead" href="/settings/move"><span class="txt">${t('settings.row.move')}<span class="sub">${t('settings.row.moveSub')}</span></span><span class="chev"></span></a></li></ul>`;
  // On a server there is no second-folder block; a link to #backup-copy (the first steps' backup step) lands on Backups and copies.
  const copyAnchor = v.localMode ? '' : html`<span id="backup-copy"></span>`;
  const health = v.localMode
    ? html`<section id="health" class="panel backups${!v.backups || v.backups.health.ok ? '' : ' attention'}">
  <div class="panel-head"><h2>${t('settings.sec.backups')}</h2></div>
  ${v.backups ? dailyLine() : html`<p class="quiet">${t('settings.noBackupFolder')}</p>`}
  ${backupActions}
  ${copySection}
  ${localRows}
  ${restoreLine}
  ${serverOnly}
  ${sizeLines}
  ${brainHealth}
</section>`
    : v.backups
      ? backupsPanel(v.backups, { id: 'health', title: t('settings.sec.backups'), extra: html`${copyAnchor}${saveRow}`, after: html`${sizeLines}${brainHealth}` })
      : html`<section id="health" class="panel"><div class="panel-head"><h2>${t('settings.sec.backups')}</h2></div>${copyAnchor}${saveRow}${sizeLines}${brainHealth}</section>`;
  const reachOn = v.reach?.on === true;
  const assistantsBody = v.localMode
    ? html`<p class="meta">${t('settings.as.lede')}</p>
  <div data-added-tools="/settings/tools/added"></div>
  <h3 id="assistants-here">${t('settings.as.here', { here })}</h3>
  <ul class="group"><li><a class="row nolead" href="/settings/tools"><span class="txt">${t('settings.as.toolsOn', { here })}<span class="sub">${t('settings.as.toolsSub')}</span></span><span class="chev"></span></a></li></ul>
  <h3 id="assistants-web">${t('settings.as.web')}</h3>
  <ul class="group"><li><a class="row nolead" href="/settings/reach"><span class="txt">Claude · ChatGPT · Grok<span class="sub">${reachOn ? tHtml('settings.as.cloudOn', { here: computerName() }) : tHtml('settings.as.cloudOff', { here: computerName() })}</span></span><span class="chev"></span></a></li></ul>
  <p><a class="button${reachOn ? ' secondary' : ''}" href="/settings/reach">${reachOn ? t('settings.as.reachSettings') : t('settings.as.reachOn')}</a></p>
  <h3 id="setup">${t('settings.as.setup')}</h3>
  <p class="meta">${t('settings.as.setupAbout')}</p>`
    : html`<p class="meta">${t('settings.as.ledeServer')}</p>
  <h3 id="setup">${t('settings.as.setup')}</h3>`;
  const pauseSwitch = v.savesPausedSince
    ? html`<h3 id="pause-saves">${t('settings.as.pauseTitle')}</h3>
  <p class="notice" role="status">${tHtml('settings.as.paused', { when: when(v.savesPausedSince) })}</p>
  <form method="post" action="/settings/pause/resume"><button type="submit" class="primary">${t('settings.as.resume')}</button></form>`
    : html`<h3 id="pause-saves">${t('settings.as.pauseTitle')}</h3>
  <p class="meta">${t('settings.as.pauseAbout')}</p>
  <form method="post" action="/settings/pause"><button type="submit" class="secondary">${t('settings.as.pause')}</button></form>`;
  const connectionsList = html`${pauseSwitch}<h3 id="connections-list">${t('settings.as.connections')}</h3>
  ${grantCards({ grants: v.grants, projects: v.projects, status: v.connStatus })}`;
  // On a server this is only the home of desk.js's two switches (keyboard shortcuts, things beside the list): a wide window's.
  const thisDeviceSection = !v.localMode ? html`<section id="this-device" class="panel desk-only">
  <div class="panel-head"><h2>${t('settings.thisBrowser')}</h2></div>
  <p class="meta">${t('settings.dev.browserAbout')}</p>
</section>` : html`<section id="this-device" class="panel">
  <div class="panel-head"><h2>${device}</h2></div>
  <p class="meta">${t('settings.dev.appAbout', { here })}</p>
  ${v.space === undefined ? '' : spaceBlock(v.space)}
</section>`;
  const removeSection = !v.localMode ? '' : html`<section id="remove" class="panel danger-zone">
  <div class="panel-head"><h2>${t('settings.sec.remove', { here })}</h2></div>
  <p class="meta">${t('settings.rm.about')}</p>
  <p><a class="button danger-link" href="/settings/remove">${t('settings.rm.link', { here })}</a></p>
</section>`;
  return html`<div class="settings wide">
<nav class="settings-nav" aria-label="${t('shell.nav.settings')}">${sections.map(([id, label]) => html`<a href="#${id}"${id === 'remove' ? html` class="warn"` : ''}>${label}</a>`)}</nav>
<div class="settings-body">
<h1>${t('shell.nav.settings')}</h1>
<p class="lede">${t('settings.lede')}</p>
${errorBlock(v.error)}
<ul class="group settings-index">${sections.map(indexRow)}</ul>
${v.localMode ? thisDeviceSection : ''}
<section id="connections" class="panel">
  <div class="panel-head"><h2>${t('settings.sec.assistants')}</h2></div>
  ${assistantsBody}
  <ul class="group">${setupApps().map((a) => html`<li><a class="row nolead" href="/settings/setup/${a.slug}"><span class="txt">${a.name}</span><span class="chev"></span></a></li>`)}</ul>
  ${connectionsList}
</section>
${v.search ? searchSection(v.search) : ''}
${health}
${v.versionPanel ? versionPanel(v.versionPanel) : ''}
${devicesSection(v.devices, v.created, v.now, v.brainUrl)}
<section id="login" class="panel">
  <div class="panel-head"><h2>${t('settings.sec.login')}</h2></div>
  ${sessionCards({ sessions: v.sessions, currentSessionId: v.currentSessionId })}
</section>
${languagePanel(v.language?.choice ?? 'auto')}
${appearancePanel(v.appearance?.choice ?? 'auto', v.localMode === true, v.weekNotice)}
${coachingPanel(v.coaching?.on ?? false)}
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
    return days >= 1 ? html` <strong class="late-text">${t('settings.oc.late', { count: days })}</strong>` : html``;
  };
  const live = devices.filter((x) => x.revokedAt === null);
  return html`<section id="devices" class="panel">
  <div class="panel-head"><h2>${t('settings.sec.devices')}</h2></div>
  <p class="meta">${t('settings.oc.about')}</p>
  ${created ? html`<div class="token-once"><p><strong>${t('settings.oc.copyNow')}</strong> ${t('settings.oc.copyRun')}</p>
  <pre><code>scripts/mac/install-folder-report.sh --url ${brainUrl} <span class="token-arg">TOKEN</span></code></pre><p>${t('settings.oc.withToken', { name: created.name })}</p><code class="token">${created.token}</code></div>` : ''}
  ${live.length === 0 ? html`<p class="quiet">${t('settings.oc.none')}</p>` : html`<ul class="rows devices">${live.map((x) => html`<li><span class="dev-name">${x.name}</span>
    ${metaLine([tHtml('settings.oc.added', { when: when(x.createdAt) }), x.lastReportAt ? tHtml('settings.oc.lastReport', { when: when(x.lastReportAt) }) : t('settings.oc.never')])}${x.lastReportAt ? late(x.lastReportAt) : ''}
    <form method="post" action="/settings/devices/${x.id}/revoke"><button type="submit" class="secondary" aria-label="${t('settings.oc.revokeLabel', { name: x.name })}">${t('settings.oc.revoke')}</button></form></li>`)}</ul>`}
  <form method="post" action="/settings/devices" class="add-device"><label>${t('settings.oc.name')} <input name="name" maxlength="60" value="Mac" required></label><button type="submit">${t('settings.oc.add')}</button></form>
</section>`;
}

/** The phone index's one-line status for Search. */
function searchStatus(v: SearchSectionInput): string {
  const s = v.status;
  if (s.onlineProblem !== undefined || s.problem !== undefined) return t('settings.st.needsLook');
  if (s.choice === null) return t('settings.st.notSetUp');
  return s.searchReady ? t('settings.st.ready') : t('settings.st.gettingReady');
}

/** A language in its own words, whatever the screen's language: "English", "Español"; auto is the one word that is translated. */
const languageName = (c: UiLanguage): string => tKey(c === 'auto' ? 'lang.status.auto' : (`lang.name.${c}` as const));

/**
 * Settings › Language: Automatic (the browser's language) / English / Español. Owner-only POST /settings/language; the page
 * after it is in the new language.
 */
function languagePanel(choice: UiLanguage): SafeHtml {
  return html`<section id="language" class="panel">
  <div class="panel-head"><h2>${t('lang.title')}</h2></div>
  <p class="meta">${t('lang.lede')}</p>
  <form method="post" action="/settings/language" class="stack">
    <fieldset class="choices"><legend class="visually-hidden">${t('lang.title')}</legend>
    ${UI_LANGUAGES.map((c) => html`<p><label class="choice"><input type="radio" name="language" value="${c}"${c === choice ? raw(' checked') : ''}> ${languageName(c)}${c === 'auto' ? html`<span class="sub"> · ${t('lang.autoSub')}</span>` : ''}</label></p>`)}
    </fieldset>
    <p><button type="submit" class="secondary">${t('lang.save')}</button></p>
  </form>
</section>`;
}

const themeName = (c: ThemeChoice): string => tKey(`theme.${c}` as const);

/**
 * Settings › Appearance: Automatic / Light / Dark, per browser (the `theme` cookie, not brain data). With scripts, a choice
 * applies at once (theme.js); without, Save posts to the owner-only /settings/theme, which sets the cookie.
 */
function appearancePanel(choice: ThemeChoice, inApp: boolean, weekNotice?: { on: boolean }): SafeHtml {
  return html`<section id="appearance" class="panel">
  <div class="panel-head"><h2>${t('theme.title')}</h2></div>
  <p class="meta">${t(inApp ? 'theme.lede' : 'theme.ledeBrowser')}</p>
  <form method="post" action="/settings/theme" class="stack" data-theme-form>
    <fieldset class="choices"><legend class="visually-hidden">${t('theme.title')}</legend>
    ${THEME_CHOICES.map((c) => html`<p><label class="choice"><input type="radio" name="theme" value="${c}"${c === choice ? raw(' checked') : ''}> ${themeName(c)}</label></p>`)}
    </fieldset>
    <p data-theme-save><button type="submit" class="secondary">${t('theme.save')}</button></p>
  </form>
  ${weekNotice ? html`<form method="post" action="/settings/week-notice" class="stack">
    <p><label class="choice"><input type="checkbox" name="weekNotice" value="on"${weekNotice.on ? raw(' checked') : ''}> ${t('weekNotice.label')}<span class="sub"> · ${t('weekNotice.sub')}</span></label></p>
    <p><button type="submit" class="secondary">${t('weekNotice.save')}</button></p>
  </form>` : ''}
</section>`;
}

/** Settings › Developer coaching: one brain-wide switch, owner-only POST /settings/coaching. Off leaves the data alone. */
function coachingPanel(on: boolean): SafeHtml {
  return html`<section id="coaching" class="panel">
  <div class="panel-head"><h2>${t('coaching.title')}</h2></div>
  <p class="meta">${t('coaching.lede')}</p>
  <form method="post" action="/settings/coaching" class="stack">
    <p><label class="choice"><input type="checkbox" name="coaching" value="on"${on ? raw(' checked') : ''}> ${t('coaching.label')}</label></p>
    <p><button type="submit" class="secondary">${t('coaching.save')}</button></p>
  </form>
</section>`;
}
