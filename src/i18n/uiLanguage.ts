import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pseudoEnabled, type AnyLocale, type Locale } from './core.js';
import { localeFromAcceptLanguage } from './accept.js';

/** The owner's choice, in brain_switches. */
export const UI_LANGUAGE_SWITCH = 'ui_language';
export type UiLanguage = 'auto' | Locale;
export const UI_LANGUAGES: readonly UiLanguage[] = ['auto', 'en', 'es'];
export const isUiLanguage = (v: unknown): v is UiLanguage => typeof v === 'string' && (UI_LANGUAGES as readonly string[]).includes(v);

/** The stored choice (default auto; anything unreadable reads as auto). */
export function storedChoice(value: string | null): UiLanguage {
  return isUiLanguage(value) ? value : 'auto';
}

/** The setting beats the header; auto follows Accept-Language. The pseudo-locale only when tests enabled it. */
export function chooseLocale(stored: string | null, acceptLanguage: string | undefined | null, systemLocale?: string | undefined | null): AnyLocale {
  if (stored === 'xx' && pseudoEnabled()) return 'xx';
  const c = storedChoice(stored);
  if (c !== 'auto') return c;
  // The operating system's language (local mode, set by the desktop shell) beats the web view's header when it names one of ours.
  if (systemLocale) {
    const tag = systemLocale.replace(/_/g, '-').trim();
    const sys = localeFromAcceptLanguage(tag);
    if (sys === 'es' || /^en\b/i.test(tag)) return sys;
  }
  return localeFromAcceptLanguage(acceptLanguage);
}

/**
 * The file the desktop shell reads at start, so the owner's choice wins in the tray menu and dialogs too (stage S3).
 * <dataDir>/ui-language.json = {"language":"auto"|"en"|"es","updatedAt":ISO}. Local mode only; the caller checks that.
 */
export const UI_LANGUAGE_FILE = 'ui-language.json';
export function writeUiLanguageFile(dataDir: string, choice: UiLanguage, at: Date): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, UI_LANGUAGE_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ language: choice, updatedAt: at.toISOString() }) + '\n');
  renameSync(tmp, file);
}
