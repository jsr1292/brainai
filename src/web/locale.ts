import type { RequestHandler } from 'express';
import { runWithLocale } from '../i18n/core.js';
import { chooseLocale, UI_LANGUAGE_SWITCH } from '../i18n/uiLanguage.js';

/**
 * Endpoints that talk to programs (assistants, the desktop shell, the browser's scripts), not to the owner. They always
 * answer in English: a tool reply with a Spanish weekday would reach an assistant that did not ask for it, and OAuth and
 * device messages are protocol text. `/authorize` is NOT here: its consent page is for the owner and is localised.
 */
/** Endpoints that browsers' scripts, the desktop shell and OAuth clients call (CSRF-exempt, no Origin). `/authorize` is for the owner. */
export const CLIENT_ENDPOINTS = ['/mcp', '/authorize', '/token', '/register', '/revoke', '/app/hello', '/app/bridge-hello', '/app/ticket', '/app/removed/ready', '/app/removed/cancel', '/app/backup-now', '/welcome/restore/find', '/api/folder-report', '/api/image-upload', '/api/skills/report', '/api/skills/upload'];
/** Machine paths: every client endpoint except /authorize, plus the files and APIs a browser or program fetches. */
const MACHINE_PATHS = [...CLIENT_ENDPOINTS.filter((p) => p !== '/authorize'), '/api', '/static', '/images', '/.well-known', '/sw.js', '/favicon.ico', '/app/open'];
const escapeRe = (p: string): string => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MACHINE = new RegExp('^(' + MACHINE_PATHS.map(escapeRe).join('|') + ')(/|$)');
export const isMachinePath = (path: string): boolean => MACHINE.test(path);

/**
 * One middleware, early: the language of this request. Machine endpoints are English. Otherwise the owner's choice in
 * Settings › Language (brain_switches `ui_language`) wins; in local mode `auto` first follows BRAINAI_SYSTEM_LOCALE (the
 * desktop shell passes the operating system's language, because the web view's Accept-Language can say `en-US` on a
 * Spanish Mac), then Accept-Language; otherwise English. A failed read of the switch means auto, never an error page.
 */
export function localeMiddleware(read: (name: string) => string | null, opts: { localMode?: boolean; systemLocale?: () => string | undefined } = {}): RequestHandler {
  return (req, _res, next) => {
    if (isMachinePath(req.path)) return runWithLocale('en', next);
    let stored: string | null = null;
    try { stored = read(UI_LANGUAGE_SWITCH); } catch { /* a database that is closing reads as auto */ }
    const system = opts.localMode ? opts.systemLocale?.() : undefined;
    runWithLocale(chooseLocale(stored, req.get('accept-language'), system), next);
  };
}
