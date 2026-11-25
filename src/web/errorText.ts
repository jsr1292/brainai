import { t, tKey, type Key } from '../i18n/core.js';
import { MemoryError } from '../memory/service.js';
import { SayableError } from '../i18n/errors.js';
import { fmt } from '../i18n/fmt.js';

/** The limits whose English text always grouped digits ("100,000"); other `max` values print as plain numbers. */
const GROUPED_MAX = new Set<string>(['err.disc.len.title', 'err.disc.len.question', 'err.disc.len.reply', 'err.disc.len.decision', 'err.disc.len.note', 'err.disc.fileTooBig', 'err.disc.filesTotal', 'err.file.long', 'err.skill.bodyMax']);

/**
 * The text of an error for a dashboard page, in the owner's language. An error that carries a catalog key (`key`, `params`:
 * a MemoryError or a SayableError such as PageError) shows `t(key, params)`; any other error shows its `.message`, which stays
 * English (it is what assistants read through MCP). Routes call `errorText(e)` where they used `e.message`. Never use it for
 * text that is stored or sent to assistants.
 */
export function errorText(e: unknown): string {
  if ((e instanceof MemoryError || e instanceof SayableError) && e.key !== undefined) {
    // A refusal's `reason` (a secret or instruction-like code the service stores in English) is worded in the owner's language.
    let params = e.params;
    if (params?.reason !== undefined && typeof params.reason === 'string') params = { ...params, reason: reasonText(params.reason) };
    // Limits travel as plain numbers (MCP text formats its own); the screen groups digits the way its language does.
    if (typeof params?.max === 'number' && GROUPED_MAX.has(e.key)) params = { ...params, max: fmt.number(params.max) };
    return tKey(e.key, params);
  }
  return e instanceof Error ? e.message : String(e);
}

/** The fact form's field a refusal is about, so the screen can show it under that field. `undefined`: no single field. */
export type FactField = 'content' | 'tags' | 'project' | 'keys';
export function errorField(e: unknown): FactField | undefined {
  const key = e instanceof MemoryError ? e.key : undefined;
  if (key === undefined) return undefined;
  if (key === 'err.secret' || key.startsWith('err.fact.content')) return 'content';
  if (key.startsWith('err.fact.tag')) return 'tags';
  if (key === 'err.fact.project') return 'project';
  if (key.startsWith('err.fact.keys') || key === 'err.keysSecret' || key === 'err.keysInstruction') return 'keys';
  return undefined;
}

/** The stored English reasons of a held save or a refused line (instruction-like, mixed source, close to, deleted, replaced) as catalog keys. */
const HELD_REASONS: Record<string, Key> = {
  'asks to ignore instructions': 'data.reason.ignore', 'speaks to the assistant directly': 'data.reason.speaks', 'keeps something from the owner': 'data.reason.secret',
  "skips the owner's confirmation": 'data.reason.skips', 'runs a downloaded script': 'data.reason.script', 'sends data to a web address': 'data.reason.web',
  'sends data to an email address': 'data.reason.email', 'sets a standing rule for assistants': 'data.reason.rule',
  'is close to a memory the owner already has': 'inbox.card.reason.close', 'matches a fact that was replaced by a newer one': 'inbox.card.reason.replaced',
  "Marked as your words but reads like it includes an assistant's suggestion": 'err.reason.mixed',
  'private key': 'secret.reason.privateKey', 'API key': 'secret.reason.apiKey', 'GitHub token': 'secret.reason.githubToken', 'AWS access key': 'secret.reason.awsKey',
  'Slack token': 'secret.reason.slackToken', JWT: 'secret.reason.jwt', 'credential assignment': 'secret.reason.credential',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A stored "2 Nov 2026" (deletedDay, en-GB, UTC) in the owner's language; a text that is not that shape is shown as stored. */
function storedDay(day: string): string {
  const m = /^(\d{1,2}) (\w{3}) (\d{4})$/.exec(day.trim());
  const month = m ? MONTHS.indexOf(m[2]!) : -1;
  return m && month >= 0 ? fmt.date(new Date(Date.UTC(Number(m[3]), month, Number(m[1]), 12))) : day;
}

/** One stored reason (several joined with " and ") in the owner's language; a reason that is not known is shown as stored. For screens only. */
export function reasonText(reason: string): string {
  const one = (r: string): string => {
    const key = HELD_REASONS[r];
    if (key !== undefined) return tKey(key);
    const m = /^is close to a fact you deleted on (.+)$/.exec(r);
    return m ? t('inbox.card.reason.deleted', { day: storedDay(m[1]!) }) : r;
  };
  return reason.split(' and ').map(one).join(tKey('err.reason.and'));
}

/** A failed copy's code (see CopyWhy) in the owner's language, without paths. */
export function copyWhyText(why: string): string {
  return tKey((['folder', 'brainFolder', 'pictures', 'write', 'stuck', 'timeout', 'busy'].includes(why) ? `backup.why.${why}` : 'backup.why.other') as 'backup.why.other');
}

/** The backup problems (`backupHealth`) in the owner's language; a health value without keys shows its English sentences. */
export function backupProblems(h: { problems: string[]; say?: { key: Key; params?: Record<string, string | number> }[] }): string[] {
  return h.problems.map((p, i) => {
    const say = h.say?.[i];
    if (!say) return p;
    const params = { ...say.params };
    if (params.error === '') params.error = t('backup.p.logDefault');
    if (say.key === 'backup.p.copyFailed') params.reason = copyWhyText(String(params.reason));
    if (say.key === 'backup.p.copy') params.result = tKey(params.result === 'skipped' ? 'backup.p.result.skipped' : 'backup.p.result.failed');
    if (say.key === 'backup.p.jobFailed' || say.key === 'backup.p.jobOld') params.name = tKey(params.name === 'git copy' ? 'backup.p.gitCopy' : 'backup.p.mdExport');
    return tKey(say.key, params);
  });
}
