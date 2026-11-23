import { RateLimiterMemory } from 'rate-limiter-flexible';

const GLOBAL_KEY = 'global';
export const LOCAL_GLOBAL_CAP = 30;
export const DOOR_GLOBAL_CAP = 60;

export class LoginLimiter {
  private perIp = new RateLimiterMemory({ points: 5, duration: 15 * 60 });
  // The bucket shared by all addresses is split by where the attempt came from, so failures from the internet (through the
  // public door) can never block logins on this computer; the door's has a cap of its own.
  private global = new RateLimiterMemory({ points: LOCAL_GLOBAL_CAP, duration: 60 * 60 });
  private doorGlobal = new RateLimiterMemory({ points: DOOR_GLOBAL_CAP, duration: 60 * 60 });

  /**
   * Read-only: does not consume points. A known device (a browser the owner logged in from before) skips the limit
   * shared by all addresses, so failures from elsewhere cannot lock the owner out; its own address's limit still applies.
   */
  async check(ip: string, o: { knownDevice?: boolean; door?: boolean } = {}): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const [a, g] = await Promise.all([this.perIp.get(ip), this.bucket(o.door).get(GLOBAL_KEY)]);
    let retryMs = 0;
    if (a && a.consumedPoints >= 5) retryMs = Math.max(retryMs, a.msBeforeNext);
    if (!o.knownDevice && g && g.consumedPoints >= (o.door ? DOOR_GLOBAL_CAP : LOCAL_GLOBAL_CAP)) retryMs = Math.max(retryMs, g.msBeforeNext);
    return retryMs > 0 ? { allowed: false, retryAfterSec: Math.ceil(retryMs / 1000) } : { allowed: true, retryAfterSec: 0 };
  }

  private bucket(door?: boolean): RateLimiterMemory {
    return door ? this.doorGlobal : this.global;
  }

  async fail(ip: string, o: { door?: boolean } = {}): Promise<void> {
    await Promise.all([this.perIp.penalty(ip, 1), this.bucket(o.door).penalty(GLOBAL_KEY, 1)]);
  }

  /** Resets only the per-IP counter; the global one keeps counting. */
  async succeed(ip: string): Promise<void> {
    await this.perIp.delete(ip);
  }
}
