import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/** The viewer's choice of look: a cookie on this browser, not brain data. Anything but `light` or `dark` means Automatic. */
export const THEME_COOKIE = 'theme';
export type ThemeChoice = 'auto' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['auto', 'light', 'dark'];
export const isThemeChoice = (v: unknown): v is ThemeChoice => typeof v === 'string' && (THEME_CHOICES as readonly string[]).includes(v);
/** The phone bar's colour per forced theme: the page background of each (style.css --bg). */
export const THEME_COLOURS = { light: '#faf9f6', dark: '#0f1320' } as const;
/** A year, in milliseconds (express's maxAge). */
export const THEME_COOKIE_MAX_AGE = 365 * 86_400_000;

const store = new AsyncLocalStorage<'light' | 'dark' | null>();

/** The forced theme of this request, or null for Automatic (or outside a request). */
export const currentTheme = (): 'light' | 'dark' | null => store.getStore() ?? null;

/** Runs `fn` as a request with this forced theme; used by the middleware and by tests. */
export const runWithTheme = <T>(theme: 'light' | 'dark' | null, fn: () => T): T => store.run(theme, fn);

/** The forced theme in a Cookie header (junk or absent is null). */
export function themeFromCookie(header: string | undefined): 'light' | 'dark' | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === THEME_COOKIE) {
      const v = part.slice(eq + 1).trim();
      return v === 'light' || v === 'dark' ? v : null;
    }
  }
  return null;
}

/** One middleware, early: every page this request renders carries the viewer's forced theme. */
export function themeMiddleware(): RequestHandler {
  return (req, _res, next) => runWithTheme(themeFromCookie(req.headers.cookie), next);
}
