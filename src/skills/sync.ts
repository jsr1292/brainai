/**
 * The Mac skills sync (round 2 §17c). A device reports its Claude Code skills; the brain answers what content it needs
 * and what to write or remove there. The brain decides everything from one link per (skill, device) holding the hashes
 * both sides last agreed on; the device applies an action only when its folder still has the expected hash. A device
 * can report and upload, but nothing it sends ever changes a brain skill: Share and "Take the Mac's version" are the
 * owner's.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { SkillError, type SkillService } from './service.js';
import { findSecret } from '../memory/secrets.js';
import { MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, MAX_SKILL_NAME, SKILL_NAME_RE, type Skill, type SkillFile } from './types.js';

export interface ReportItem { name: string; description: string; hash: string; files: number; bytes: number; shareable: string | null }
export type SyncAction = { kind: 'write'; name: string; expect: string | null; files: SkillFile[] } | { kind: 'remove'; name: string; expect: string };
export interface DeviceSkill { deviceId: string; name: string; description: string; hash: string; files: number; bytes: number; shareable: string | null; hasContent: boolean; reportedAt: string }
export type LinkState = 'same' | 'mac_changed' | 'pending' | 'own_copy';

/** sha256 over the files sorted by path (code-unit order, as Python's sorted()): path, NUL, UTF-8 text, NUL. */
export function contentHash(files: readonly SkillFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path, 'utf8'); h.update('\0'); h.update(f.text, 'utf8'); h.update('\0');
  }
  return h.digest('hex');
}

/** A SKILL.md's frontmatter name and description (plain, quoted, or folded with > or |) and its body. */
export function parseSkillMd(text: string): { name: string | null; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: null, description: '', body: text.trim() };
  const lines = m[1]!.split(/\r?\n/);
  const field = (key: string): string | null => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i < 0) return null;
    const v = lines[i]!.slice(key.length + 1).trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const more: string[] = [];
      for (const l of lines.slice(i + 1)) { if (!/^\s+/.test(l)) break; more.push(l.trim()); }
      return more.join(v.startsWith('>') ? ' ' : '\n');
    }
    if (v.startsWith('"')) { try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); } }
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  };
  return { name: field('name'), description: field('description') ?? '', body: m[2]!.replace(/^\s*\n/, '').trim() };
}

interface LinkRow { skill_id: string; device_id: string; mac_name: string; mac_hash: string; brain_hash: string; force_write: number }
interface DeviceSkillRow { device_id: string; name: string; description: string; hash: string; files: number; bytes: number; shareable: string | null; content: string | null; reported_at: string }

const HASH_RE = /^[0-9a-f]{64}$/;

export class SkillSync {
  constructor(private readonly db: DB, private readonly now: Clock, private readonly skills: SkillService) {}

  private ts(): string { return this.now().toISOString(); }
  /** A brain skill's files as the Mac holds them: SKILL.md first, then its own. */
  brainFiles(s: Skill): SkillFile[] { return [{ path: 'SKILL.md', text: this.skills.skillMd(s) }, ...s.files]; }
  private brainHash(s: Skill): string { return contentHash(this.brainFiles(s)); }

  private links(deviceId: string): LinkRow[] { return this.db.prepare('SELECT * FROM skill_links WHERE device_id = ?').all(deviceId) as LinkRow[]; }
  private link(skillId: string, deviceId: string): LinkRow | undefined {
    return this.db.prepare('SELECT * FROM skill_links WHERE skill_id = ? AND device_id = ?').get(skillId, deviceId) as LinkRow | undefined;
  }
  private setLink(l: { skill_id: string; device_id: string; mac_name: string; mac_hash: string; brain_hash: string; force_write?: number }): void {
    this.db.prepare(`INSERT INTO skill_links(skill_id, device_id, mac_name, mac_hash, brain_hash, force_write, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id, device_id) DO UPDATE SET mac_name = excluded.mac_name, mac_hash = excluded.mac_hash, brain_hash = excluded.brain_hash, force_write = excluded.force_write`)
      .run(l.skill_id, l.device_id, l.mac_name, l.mac_hash, l.brain_hash, l.force_write ?? 0, this.ts());
  }
  private dropLink(skillId: string, deviceId: string): void { this.db.prepare('DELETE FROM skill_links WHERE skill_id = ? AND device_id = ?').run(skillId, deviceId); }
  private row(deviceId: string, name: string): DeviceSkillRow | undefined {
    return this.db.prepare('SELECT * FROM device_skills WHERE device_id = ? AND name = ?').get(deviceId, name) as DeviceSkillRow | undefined;
  }
  /** A live skill by id, deleted ones included (their links still need answering). */
  private skillRow(id: string): { deleted: boolean; skill: Skill | undefined } {
    const live = this.skills.get(id);
    return { deleted: live === undefined, skill: live };
  }

  /** A device's report: store what it holds, ask for changed content, and say what to write or remove there. */
  report(deviceId: string, items: ReportItem[]): { want: string[]; actions: SyncAction[] } {
    for (const it of items) {
      if (it.name.length > MAX_SKILL_NAME || !SKILL_NAME_RE.test(it.name) || !HASH_RE.test(it.hash)) throw new SkillError('invalid', `Not a skill report: ${String(it.name).slice(0, 64)}`);
    }
    return this.db.transaction(() => {
      const t = this.ts();
      const seen = new Map(items.map((it) => [it.name, it]));
      const want: string[] = [];
      for (const it of items) {
        const old = this.row(deviceId, it.name);
        const keep = old && old.hash === it.hash ? old.content : null;
        this.db.prepare(`INSERT INTO device_skills(device_id, name, description, hash, files, bytes, shareable, content, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id, name) DO UPDATE SET description = excluded.description, hash = excluded.hash, files = excluded.files, bytes = excluded.bytes,
          shareable = excluded.shareable, content = excluded.content, reported_at = excluded.reported_at`)
          .run(deviceId, it.name, it.description.slice(0, 1024), it.hash, it.files | 0, it.bytes | 0, it.shareable, keep, t);
        if (it.shareable === null && keep === null) want.push(it.name);
      }
      const gone = (this.db.prepare('SELECT name FROM device_skills WHERE device_id = ?').all(deviceId) as { name: string }[]).filter((r) => !seen.has(r.name));
      for (const r of gone) this.db.prepare('DELETE FROM device_skills WHERE device_id = ? AND name = ?').run(deviceId, r.name);

      const actions: SyncAction[] = [];
      const linked = new Set<string>();
      for (const l of this.links(deviceId)) {
        linked.add(l.skill_id);
        const { skill: s } = this.skillRow(l.skill_id);
        const mac = seen.get(l.mac_name);
        const fromHere = s?.origin === `device:${deviceId}`;
        // Deleted, or a brain-made skill turned Off: it leaves the device (moved aside there). A skill shared from the
        // device is never removed from it: Off only keeps it from assistants elsewhere, and it stays in step both ways;
        // deleted, its link goes and the device keeps its folder.
        if (!s && fromHereOf(this.db, l.skill_id, deviceId)) { this.dropLink(l.skill_id, deviceId); continue; }
        if (!s || (!s.enabled && !fromHere)) {
          // The link stays until the device reports the folder gone, so a lost answer is asked again (audit F04).
          // The folder is the brain's own when it holds what was agreed, or what the brain wrote and the device hasn't
          // confirmed yet (turned Off within one report of a write).
          const ours = mac && (mac.hash === l.mac_hash || mac.hash === l.brain_hash || (s !== undefined && mac.hash === this.brainHash(s)));
          if (mac && ours) actions.push({ kind: 'remove', name: l.mac_name, expect: mac.hash });
          if (!mac) this.dropLink(l.skill_id, deviceId);
          continue;
        }
        const bh = this.brainHash(s);
        // A write counts as done only when the device reports the brain's hash back: until then the link keeps the
        // hashes both sides last agreed on, and the write is sent again with the same expect (a lost answer, a
        // skipped action or a crash on the device never turns into a false "changed on the Mac").
        if (!mac) {
          // The folder went from the device: a skill shared from there unlinks; a brain-made one that is On comes back.
          if (fromHere) { this.dropLink(l.skill_id, deviceId); continue; }
          actions.push({ kind: 'write', name: l.mac_name, expect: null, files: this.brainFiles(s) });
          continue;
        }
        if (mac.hash === bh) { this.setLink({ ...l, mac_hash: bh, brain_hash: bh, force_write: 0 }); continue; }
        // Keep this one: the brain's version goes over the device's, until the device reports it.
        if (l.force_write === 1) { actions.push({ kind: 'write', name: l.mac_name, expect: mac.hash, files: this.brainFiles(s) }); continue; }
        const macChanged = mac.hash !== l.mac_hash;
        const brainChanged = bh !== l.brain_hash;
        if (!macChanged && brainChanged) actions.push({ kind: 'write', name: l.mac_name, expect: mac.hash, files: this.brainFiles(s) });
        // Changed on the device (alone or both): nothing is written; the skill page offers the owner's choice.
      }
      // Skills that are On reach a device that has neither them nor a folder of the same name of its own.
      for (const s of this.skills.listOn()) {
        if (linked.has(s.id) || s.origin === `device:${deviceId}` || seen.has(s.name)) continue;
        // Linked now, with nothing agreed on the device yet (mac_hash ''): pending until the device reports it.
        actions.push({ kind: 'write', name: s.name, expect: null, files: this.brainFiles(s) });
        this.setLink({ skill_id: s.id, device_id: deviceId, mac_name: s.name, mac_hash: '', brain_hash: this.brainHash(s) });
      }
      return { want, actions };
    })();
  }

  /** Content the brain asked for: kept beside the report, never applied to a brain skill. */
  upload(deviceId: string, items: { name: string; hash: string; files: SkillFile[] }[]): void {
    this.db.transaction(() => {
      for (const it of items) {
        const r = this.row(deviceId, it.name);
        if (!r || r.hash !== it.hash) throw new SkillError('invalid', `${String(it.name).slice(0, 64)} was not reported with that hash.`);
        if (contentHash(it.files) !== it.hash) throw new SkillError('invalid', `The content of ${it.name} does not match its hash.`);
        if (r.shareable !== null) throw new SkillError('invalid', `${it.name} can't be shared: ${r.shareable}.`);
        // The same limits as a skill in the brain (SKILL.md and up to 20 files), checked before anything is kept.
        const own = it.files.filter((f) => f.path !== 'SKILL.md');
        const total = it.files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0);
        if (own.length > MAX_SKILL_FILES) throw new SkillError('invalid', `${it.name} has too many files.`);
        if (it.files.some((f) => Buffer.byteLength(f.text, 'utf8') > MAX_SKILL_FILE_BYTES) || total > MAX_SKILL_BYTES + MAX_SKILL_FILE_BYTES) throw new SkillError('invalid', `${it.name} is too big.`);
        // A file that looks like it holds a key is never kept: the skill shows as not shareable, with the reason.
        const secret = it.files.map((f) => ({ f, found: findSecret(f.text) })).find((x) => x.found);
        if (secret) {
          this.db.prepare('UPDATE device_skills SET content = NULL, shareable = ? WHERE device_id = ? AND name = ?')
            .run(`looks like it holds a secret (${secret.found!.reason} in ${secret.f.path})`, deviceId, it.name);
          continue;
        }
        this.db.prepare('UPDATE device_skills SET content = ? WHERE device_id = ? AND name = ?').run(JSON.stringify(it.files), deviceId, it.name);
      }
    })();
  }

  private contentOf(deviceId: string, name: string): { row: DeviceSkillRow; files: SkillFile[] } {
    const row = this.row(deviceId, name);
    if (!row) throw new SkillError('not_found', `${name} is not on that device.`);
    if (row.shareable !== null) throw new SkillError('invalid', `${name} can't be shared: ${row.shareable}.`);
    if (row.content === null) throw new SkillError('invalid', 'Not yet: the Mac sends it with its next report (within 15 minutes).');
    return { row, files: JSON.parse(row.content) as SkillFile[] };
  }
  private parsed(name: string, files: SkillFile[]) {
    const md = files.find((f) => f.path === 'SKILL.md');
    const p = parseSkillMd(md?.text ?? '');
    return { name, description: p.description || `Use when ${name} applies.`, body: p.body, files: files.filter((f) => f.path !== 'SKILL.md') };
  }

  /** The owner shares a device's skill: a new brain skill, Off, linked to that device. */
  share(deviceId: string, name: string): Skill {
    return this.db.transaction(() => {
      const { row, files } = this.contentOf(deviceId, name);
      const s = this.skills.create(this.parsed(name, files), 'owner', `device:${deviceId}`);
      this.setLink({ skill_id: s.id, device_id: deviceId, mac_name: name, mac_hash: row.hash, brain_hash: this.brainHash(s) });
      return s;
    })();
  }

  /** The owner takes the device's version: the brain skill becomes it, and both sides agree again. */
  takeMac(skillId: string, deviceId: string): Skill {
    return this.db.transaction(() => {
      const l = this.link(skillId, deviceId);
      const s = this.skills.get(skillId);
      if (!l || !s) throw new SkillError('not_found', 'That skill is not linked to that device.');
      const { row, files } = this.contentOf(deviceId, l.mac_name);
      if (row.hash === l.mac_hash) throw new SkillError('invalid', 'The copy on that device has not changed: there is nothing to take.');
      const p = this.parsed(s.name, files);
      const next = this.skills.update(s.id, { base: s.version, description: p.description, body: p.body, files: p.files }, 'owner');
      this.setLink({ ...l, mac_hash: row.hash, brain_hash: this.brainHash(next), force_write: 0 });
      return next;
    })();
  }

  /** The owner keeps the brain's version: the next report writes it over the device's. */
  keepBrain(skillId: string, deviceId: string): void {
    const l = this.link(skillId, deviceId);
    if (!l) throw new SkillError('not_found', 'That skill is not linked to that device.');
    this.setLink({ ...l, force_write: 1 });
  }

  /** A device's reported skills that no brain skill links to or shares a name with: the From this Mac list. */
  fromDevice(deviceId: string): DeviceSkill[] {
    const rows = this.db.prepare('SELECT * FROM device_skills WHERE device_id = ? ORDER BY name').all(deviceId) as DeviceSkillRow[];
    const linkedNames = new Set(this.links(deviceId).map((l) => l.mac_name));
    const brainNames = new Set(this.skills.list().map((s) => s.name));
    return rows.filter((r) => !linkedNames.has(r.name) && !brainNames.has(r.name)).map((r) => ({
      deviceId: r.device_id, name: r.name, description: r.description, hash: r.hash, files: r.files, bytes: r.bytes, shareable: r.shareable, hasContent: r.content !== null, reportedAt: r.reported_at,
    }));
  }

  /** How each device's copy of a skill stands, for its page. */
  stateFor(skillId: string): { deviceId: string; state: LinkState; reportedAt: string | null }[] {
    const s = this.skills.get(skillId);
    if (!s) return [];
    const out: { deviceId: string; state: LinkState; reportedAt: string | null }[] = [];
    const linkRows = this.db.prepare('SELECT * FROM skill_links WHERE skill_id = ?').all(skillId) as LinkRow[];
    for (const l of linkRows) {
      const r = this.row(l.device_id, l.mac_name);
      const bh = this.brainHash(s);
      const state: LinkState = !r || l.force_write === 1 ? 'pending'
        : r.hash === bh || (r.hash === l.mac_hash && bh === l.brain_hash) ? 'same'
        : r.hash !== l.mac_hash ? 'mac_changed' : 'pending';
      out.push({ deviceId: l.device_id, state, reportedAt: r?.reported_at ?? null });
    }
    const linkedDevices = new Set(linkRows.map((l) => l.device_id));
    for (const r of this.db.prepare('SELECT * FROM device_skills WHERE name = ?').all(s.name) as DeviceSkillRow[]) {
      if (!linkedDevices.has(r.device_id)) out.push({ deviceId: r.device_id, state: 'own_copy', reportedAt: r.reported_at });
    }
    return out;
  }
}

/** Whether a deleted skill was shared from this device (its origin), read from the row the delete kept. */
function fromHereOf(db: DB, skillId: string, deviceId: string): boolean {
  const r = db.prepare('SELECT origin FROM skills WHERE id = ?').get(skillId) as { origin: string } | undefined;
  return r?.origin === `device:${deviceId}`;
}
