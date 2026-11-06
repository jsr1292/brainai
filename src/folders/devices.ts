import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { folderKey, type FolderState } from './report.js';

/** A device the owner allowed to send folder reports (the Mac). Not an AI client: its token does nothing else. */
export interface Device { id: string; name: string; createdAt: string; lastReportAt: string | null; revokedAt: string | null }

interface DeviceRow { id: string; name: string; created_at: string; last_report_at: string | null; revoked_at: string | null }
const toDevice = (r: DeviceRow): Device => ({ id: r.id, name: r.name, createdAt: r.created_at, lastReportAt: r.last_report_at, revokedAt: r.revoked_at });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const PREFIX = 'brain_dev_';

/** Device tokens, their latest folder report, and the folder names the owner chose to ignore (migration 17). */
export class DeviceService {
  constructor(private db: DB, private now: Clock) {}

  private ts(): string {
    return this.now().toISOString();
  }

  /** A new device and its token, which is shown to the owner once; only its hash is kept. */
  create(name: string): { device: Device; token: string } {
    const n = name.trim();
    if (n === '' || n.length > 60) throw new Error('A device name is 1 to 60 characters');
    const token = PREFIX + randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.db.prepare('INSERT INTO device_tokens(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, n, hash(token), this.ts());
    return { device: this.list().find((d) => d.id === id)!, token };
  }

  list(): Device[] {
    return (this.db.prepare('SELECT * FROM device_tokens ORDER BY created_at DESC, rowid DESC').all() as DeviceRow[]).map(toDevice);
  }

  revoke(id: string): void {
    this.db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.ts(), id);
  }

  authenticate(token: string): Device | undefined {
    if (!token.startsWith(PREFIX)) return undefined;
    const r = this.db.prepare('SELECT * FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as DeviceRow | undefined;
    return r ? toDevice(r) : undefined;
  }

  storeReport(deviceId: string, folders: FolderState[]): void {
    const t = this.ts();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO folder_reports(device_id, received_at, folders) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET received_at = excluded.received_at, folders = excluded.folders')
        .run(deviceId, t, JSON.stringify(folders));
      this.db.prepare('UPDATE device_tokens SET last_report_at = ? WHERE id = ?').run(t, deviceId);
    })();
  }

  /** The newest report from a device that is not revoked. */
  latestReport(): { device: Device; receivedAt: string; folders: FolderState[] } | undefined {
    const r = this.db.prepare(
      `SELECT d.*, r.received_at AS r_at, r.folders AS r_folders FROM folder_reports r JOIN device_tokens d ON d.id = r.device_id
       WHERE d.revoked_at IS NULL ORDER BY r.received_at DESC LIMIT 1`,
    ).get() as (DeviceRow & { r_at: string; r_folders: string }) | undefined;
    return r ? { device: toDevice(r), receivedAt: r.r_at, folders: JSON.parse(r.r_folders) as FolderState[] } : undefined;
  }

  ignore(name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO ignored_folders(name, ignored_at) VALUES (?, ?)').run(folderKey(name), this.ts());
  }

  unignore(name: string): void {
    this.db.prepare('DELETE FROM ignored_folders WHERE name = ?').run(folderKey(name));
  }

  /** Ignored folders, by folderKey. */
  ignored(): Set<string> {
    return new Set((this.db.prepare('SELECT name FROM ignored_folders').all() as { name: string }[]).map((r) => r.name));
  }
}
