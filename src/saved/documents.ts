/** Where the saved folder goes by default: the Documents folder, and whether a cloud service keeps a copy of it. */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';

export interface DocumentsEnv {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Windows: the My Documents path, read by the caller with `[Environment]::GetFolderPath('MyDocuments')`. */
  myDocuments?: string;
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

function insideWindows(path: string, folder: string | undefined): boolean {
  if (!folder) return false;
  const rel = win32.relative(win32.resolve(folder), win32.resolve(path));
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
}

export function documentsFolder(e: DocumentsEnv): { path: string; synced: 'iCloud' | 'OneDrive' | null } {
  if (e.platform === 'win32') {
    const path = e.myDocuments ?? win32.join(e.home, 'Documents');
    const onedrive = [e.env.OneDrive, e.env.OneDriveCommercial, e.env.OneDriveConsumer].some((f) => insideWindows(path, f));
    return { path, synced: onedrive ? 'OneDrive' : null };
  }
  const path = join(e.home, 'Documents');
  if (e.platform !== 'darwin') return { path, synced: null };
  const cloud = join(e.home, 'Library', 'Mobile Documents');
  const rel = posix.relative(real(cloud), real(path));
  const inside = !rel.startsWith('..') && !isAbsolute(rel) && rel !== '';
  return { path, synced: existsSync(join(cloud, 'com~apple~CloudDocs', 'Documents')) || inside ? 'iCloud' : null };
}

const insidePosix = (path: string, folder: string | undefined): boolean => {
  if (!folder) return false;
  const rel = posix.relative(real(folder), real(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Whether `path` is inside iCloud Drive or OneDrive, whose service then keeps a copy of whatever is written there. */
export function syncedCloud(path: string, e: DocumentsEnv): 'iCloud' | 'OneDrive' | null {
  const oneDrive = [e.env.OneDrive, e.env.OneDriveCommercial, e.env.OneDriveConsumer];
  if (e.platform === 'win32') return oneDrive.some((f) => insideWindows(path, f)) ? 'OneDrive' : null;
  if (insidePosix(path, join(e.home, 'Library', 'Mobile Documents'))) return 'iCloud';
  if (oneDrive.some((f) => insidePosix(path, f)) || insidePosix(path, join(e.home, 'OneDrive'))) return 'OneDrive';
  const cloudStorage = join(e.home, 'Library', 'CloudStorage');
  const rel = posix.relative(real(cloudStorage), real(path));
  return !rel.startsWith('..') && !isAbsolute(rel) && rel !== '' && rel.split('/')[0]!.startsWith('OneDrive') ? 'OneDrive' : null;
}
