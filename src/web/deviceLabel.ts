const MAX_RAW = 60;

/** A short, human label for a user agent ("iPhone · Safari"); the raw agent cut to 60 characters when nothing is recognised. */
export function deviceLabel(userAgent: string | null): string {
  const ua = (userAgent ?? '').trim();
  if (ua === '') return 'Unknown device';
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X|\bMac\b/.test(ua) ? 'Mac'
    : /Linux|X11/.test(ua) ? 'Linux'
    : undefined;
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : undefined;
  const parts = [os, browser].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(' · ') : ua.slice(0, MAX_RAW);
}
