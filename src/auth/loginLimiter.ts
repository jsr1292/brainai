import { RateLimiterMemory } from 'rate-limiter-flexible';

const GLOBAL_KEY = 'global';

export class LoginLimiter {
  private perIp = new RateLimiterMemory({ points: 5, duration: 15 * 60 });
  private global = new RateLimiterMemory({ points: 30, duration: 60 * 60 });

  /**
   * Read-only: does not consume points. A known device (a browser the owner logged in from before) skips the limit
   * shared by all addresses, so failures from elsewhere cannot lock the owner out; its own address's limit still applies.
   */
  async check(ip: string, o: { knownDevice?: boolean } = {}): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const [a, g] = await Promise.all([this.perIp.get(ip), this.global.get(GLOBAL_KEY)]);
    let retryMs = 0;
    if (a && a.consumedPoints >= 5) retryMs = Math.max(retryMs, a.msBeforeNext);
    if (!o.knownDevice && g && g.consumedPoints >= 30) retryMs = Math.max(retryMs, g.msBeforeNext);
    return retryMs > 0 ? { allowed: false, retryAfterSec: Math.ceil(retryMs / 1000) } : { allowed: true, retryAfterSec: 0 };
  }

  async fail(ip: string): Promise<void> {
    await Promise.all([this.perIp.penalty(ip, 1), this.global.penalty(GLOBAL_KEY, 1)]);
  }

  /** Resets only the per-IP counter; the global one keeps counting. */
  async succeed(ip: string): Promise<void> {
    await this.perIp.delete(ip);
  }
}
