import type { Clock } from '../clock.js';
import type { MemoryService } from '../memory/service.js';
import { validFolder, type ProjectStore } from '../projects/store.js';
import { ideaName } from '../projects/service.js';
import { PROJECT_RE } from '../memory/service.js';
import type { Project } from '../projects/types.js';
import type { DeviceService } from './devices.js';
import { folderKey, type FolderState } from './report.js';

export interface FolderMatch {
  /** The latest report's folder for each project it matched, by project name. */
  byProject: Map<string, FolderState>;
  /** Folders no project matched and the owner hasn't ignored: "Not in the brain yet". */
  unmatched: FolderState[];
  receivedAt: string | null;
  device: string | null;
}

export const DAY_MS = 86_400_000;

/** Work that isn't on any remote: unpushed commits, or uncommitted changes a day after the last commit. */
export function notPushed(f: FolderState, now: Date): boolean {
  if (!f.git) return false;
  if (f.unpushed !== null && f.unpushed > 0) return true;
  return f.uncommitted !== null && f.uncommitted > 0 && f.lastCommit !== null && now.getTime() - Date.parse(f.lastCommit) > DAY_MS;
}

/**
 * Folders to projects: a project's folder field first, then its name, then an alias, all compared by folderKey.
 * Two folders that reach the same project (Pine Lodge and pine-lodge): the one named exactly as the project's
 * folder field or name wins, else the first, and the other is listed as unmatched so it is never silently dropped.
 */
export function matchFolders(folders: FolderState[], projects: Project[], aliases: { alias: string; project: string }[], ignored: Set<string>): FolderMatch {
  const byFolderField = new Map(projects.filter((p) => p.folder).map((p) => [folderKey(p.folder!), p.name]));
  const byName = new Map(projects.map((p) => [folderKey(p.name), p.name]));
  const byAlias = new Map(aliases.map((a) => [folderKey(a.alias), a.project]));
  // A project that names its folder explicitly is not also matched by its own name, as long as that folder is in
  // the report; when it isn't, the project still claims the folder with its own name.
  const keys = new Set(folders.map((f) => folderKey(f.name)));
  const claimed = new Set([...byFolderField].filter(([k]) => keys.has(k)).map(([, name]) => name));
  const exact = new Map(projects.map((p) => [p.name, new Set([p.name, p.folder].filter((x): x is string => !!x).map((x) => x.normalize('NFC')))]));
  const byProject = new Map<string, FolderState>();
  const unmatched: FolderState[] = [];
  for (const f of folders) {
    const key = folderKey(f.name);
    const nameMatch = byName.get(key);
    const project = byFolderField.get(key) ?? (nameMatch && !claimed.has(nameMatch) ? nameMatch : undefined) ?? byAlias.get(key);
    if (project === undefined) {
      if (!ignored.has(key)) unmatched.push(f);
      continue;
    }
    const held = byProject.get(project);
    if (held === undefined) {
      byProject.set(project, f);
      continue;
    }
    const isExact = (x: FolderState) => exact.get(project)?.has(x.name.normalize('NFC')) ?? false;
    const loser = !isExact(held) && isExact(f) ? held : f;
    if (loser === held) byProject.set(project, f);
    if (!ignored.has(key)) unmatched.push(loser);
  }
  return { byProject, unmatched, receivedAt: null, device: null };
}

/** The latest folder report matched against the registry, and the owner's actions on unmatched folders. */
export class FolderService {
  constructor(private devices: DeviceService, private registry: ProjectStore, private memories: MemoryService, private now: Clock) {}

  match(): FolderMatch {
    const latest = this.devices.latestReport();
    if (!latest) return { byProject: new Map(), unmatched: [], receivedAt: null, device: null };
    const m = matchFolders(latest.folders, this.registry.list(), this.memories.aliases(), this.devices.ignored());
    // Each matched folder carries its report's time, so a project can say when its git state is old.
    const byProject = new Map([...m.byProject].map(([p, f]) => [p, { ...f, reportedAt: latest.receivedAt }]));
    return { ...m, byProject, receivedAt: latest.receivedAt, device: latest.device.name };
  }

  private unmatchedNamed(name: string, m: FolderMatch = this.match()): FolderState {
    const want = name.normalize('NFC');
    const f = m.unmatched.find((x) => x.name.normalize('NFC') === want);
    if (!f) throw new Error(`No folder ${name} waiting in the latest report`);
    return f;
  }

  /**
   * Adds an unmatched folder as an open project: the name made into a valid project name ("example.com" →
   * example-com), the folder recorded as macOS shows it. Everything is checked before anything is created.
   */
  add(name: string): Project {
    const m = this.match();
    const f = this.unmatchedNamed(name, m);
    const folder = f.name.normalize('NFC');
    // A duplicate of a matched folder (Pine Lodge and pine-lodge): a project for it would take both folders
    // away from the project that has them now, since folders are matched by folderKey.
    const key = folderKey(folder);
    const holder = [...m.byProject].find(([, held]) => folderKey(held.name) === key);
    if (holder) {
      throw new Error(`“${folder}” reads as the same folder as ${holder[0]}'s “${holder[1].name}”: rename or remove one of the two on the Mac`);
    }
    if (!validFolder(folder)) {
      throw new Error(`“${folder}” can't be used as a project folder: rename it to letters, digits, spaces, dots, hyphens and underscores, or add the project by hand`);
    }
    const project = ideaName(folder);
    if (!PROJECT_RE.test(project)) throw new Error(`“${folder}” doesn't make a project name: add the project by hand`);
    if (this.registry.get(project)) throw new Error(`A project named ${project} already exists: set its folder in the project's details instead`);
    this.registry.create(project, { state: 'open' }, 'owner');
    return this.registry.setInfo(project, { folder }, 'owner');
  }

  ignore(name: string): void {
    this.unmatchedNamed(name);
    this.devices.ignore(name);
  }
}
