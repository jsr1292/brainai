import { isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';
import { viaDoor } from '../desktop/publicDoor.js';

/** Express app setting read by clientIp. */
export const TRUST_CF_SETTING = 'trust cf-connecting-ip';

/**
 * The caller's address. cf-connecting-ip is trusted when the only way in is the cloudflared tunnel; createApp sets
 * TRUST_CF_SETTING to false when there is no tunnel (work mode), because then any local program could fake it.
 */
export function clientIp(req: Request): string {
  const trusted = req.app?.get(TRUST_CF_SETTING) !== false;
  return (trusted && req.get('cf-connecting-ip')) || req.socket.remoteAddress || 'unknown';
}

/** The eight 16-bit groups of a valid IPv6 address (an embedded dotted IPv4 tail is folded into the last two). */
function ipv6Groups(addr: string): number[] {
  let a = addr;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
    a = a.slice(0, v4.index) + `${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const parse = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const [head = '', tail] = a.split('::');
  if (tail === undefined) return parse(head);
  const h = parse(head);
  const t = parse(tail);
  return [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/**
 * Rate-limit key for an address. IPv4 is used as is; IPv6 is keyed by its /64 prefix, because one subscriber
 * usually holds a whole /64 and could otherwise rotate addresses to dodge the limits. IPv4-mapped IPv6 counts as IPv4.
 */
export function ipKey(ip: string): string {
  const addr = ip.split('%')[0]!;
  if (!isIPv6(addr)) return isIPv4(addr) ? addr : ip;
  const g = ipv6Groups(addr.toLowerCase());
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The key every rate limiter uses for the caller (OAuth endpoints and the login limiter). Everything through the
 * desktop app's public door shares one key of its own (D4 review): it all arrives from 127.0.0.1, and a stranger
 * using up the limits must not block the apps on the Mac. X-Forwarded-For is not used: a client can set it.
 */
export function rateLimitKey(req: Request): string {
  if (viaDoor(req)) return 'public-door';
  return ipKey(clientIp(req));
}
