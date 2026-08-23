/**
 * A per-member sliding-window burst limit, sitting on top of the daily quota.
 *
 * WHY BOTH. The daily quota is the spend control: it decides how much of the
 * shared provider key a member may burn in a UTC day. It says nothing about
 * WHEN. Without a burst guard, a loop in a client — or a member's script that
 * retries on every error — spends the whole day's allowance in ten seconds, and
 * the first thing anybody notices is a member who is inexplicably out of
 * requests at 09:00. This limiter turns that into a visible `429` while the
 * allowance is still there.
 *
 * SLIDING WINDOW, NOT FIXED WINDOWS. A fixed window lets a caller spend a full
 * minute's budget in the last second of one window and the whole next budget in
 * the first second of the next — twice the intended burst, at the one moment
 * the guard was supposed to be watching. Keeping the timestamps and counting
 * only the ones inside the trailing 60 seconds costs a short array per member
 * and has no such seam.
 *
 * KEYED ON THE RESOLVED MEMBER, SO ORDER OF WIRING MATTERS: this must run AFTER
 * `createMemberAuth`. Keying on the IP instead would put a whole household
 * behind one NAT into a single bucket, which is the opposite of the fairness we
 * want; and it would let an unauthenticated caller consume a real member's
 * budget.
 *
 * In-memory and single-process, deliberately: one container, no Redis in a
 * self-hoster's compose file. The durable counter — the one that guards money —
 * is the quota store, and that one persists.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooManyRequests, unauthorized } from '../errors.js';
import { getMemberIdentity } from './member-auth.js';

const WINDOW_MS = 60_000;

/**
 * How often the whole map is swept for members who have gone quiet. Amortised
 * across requests rather than run on a timer: a `setInterval` would keep a
 * handle alive, need unref-ing, and make the module untestable without a real
 * clock. The injected `now` drives this too.
 */
const SWEEP_INTERVAL_MS = WINDOW_MS;

/** The middleware shape this module produces. Named so call sites can hold one in a typed field. */
export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
}

export interface CreateRateLimitOptions {
  /** Requests allowed per member in any trailing 60-second window. */
  perMinute: number;
  /** Injectable clock so tests do not sleep. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * What the window is counted against. Defaults to the authenticated member's
   * id, which is the only correct key for the spend endpoint.
   *
   * Two call sites need something else, and both sit in FRONT of their
   * authentication rather than behind it: the admin API and the public invite
   * redemption. Both are guessing surfaces — one for the admin token, one for
   * an invite token — so the thing worth limiting is attempts by an
   * unauthenticated caller, which only an IP can identify. A member-keyed
   * limiter mounted after auth would never see the guesses at all.
   *
   * Returning `null` fails the request closed with a 401.
   */
  keyOf?: (req: Request) => string | null;
}

/**
 * Keys on the caller's address.
 *
 * `req.ip` honours Express's `trust proxy` setting, which this service leaves
 * off by default — behind a reverse proxy every caller would otherwise share
 * the proxy's address and one guessing client would lock out the household. The
 * fallback string is a single shared bucket, which is the safe direction: it
 * over-limits rather than under-limits.
 */
export function remoteAddressKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown-remote';
}

/** Drops timestamps that have fallen out of the trailing window. Mutates in place — this is the hot path. */
function pruneExpired(timestamps: number[], windowStartMs: number): void {
  let firstLive = 0;
  while (firstLive < timestamps.length && (timestamps[firstLive] ?? 0) <= windowStartMs) {
    firstLive += 1;
  }
  if (firstLive > 0) timestamps.splice(0, firstLive);
}

/**
 * Seconds until the oldest in-window request ages out — i.e. until one slot
 * frees. Floored at 1: a `Retry-After: 0` invites an immediate retry that is
 * guaranteed to fail again.
 */
function secondsUntilSlotFrees(oldestMs: number, currentMs: number): number {
  return Math.max(1, Math.ceil((oldestMs + WINDOW_MS - currentMs) / 1000));
}

export function createRateLimit(options: CreateRateLimitOptions): RequestHandler {
  const limit = options.perMinute;
  const now = options.now ?? (() => Date.now());
  const keyOf = options.keyOf ?? ((req: Request): string | null => getMemberIdentity(req)?.memberId ?? null);
  /** key -> timestamps of its in-window requests, oldest first. */
  const windows = new Map<string, number[]>();
  let lastSweepMs = now();

  /**
   * Bounded memory. Without this, one entry per member id that ever called
   * survives for the life of the process — small per entry, unbounded in
   * aggregate, and it never shows up in testing because a test has three
   * members. Members are few, so the sweep is cheap; it exists so the map's
   * size tracks ACTIVE members rather than every member since boot.
   */
  function sweep(currentMs: number): void {
    if (currentMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = currentMs;
    const windowStartMs = currentMs - WINDOW_MS;
    for (const [key, timestamps] of windows) {
      pruneExpired(timestamps, windowStartMs);
      if (timestamps.length === 0) windows.delete(key);
    }
  }

  return function enforceRateLimit(req: Request, _res: Response, next: NextFunction): void {
    const key = keyOf(req);
    if (key === null) {
      // FAIL CLOSED. Reaching here means the limiter was mounted before (or
      // without) `createMemberAuth` — a wiring bug, not a client error. Letting
      // the request through "because we cannot key it" would silently disable
      // both the burst guard and, since the quota layer keys on the same
      // identity, the spend control behind it.
      next(unauthorized('Member token required.'));
      return;
    }

    const currentMs = now();
    sweep(currentMs);

    const windowStartMs = currentMs - WINDOW_MS;
    const timestamps = windows.get(key) ?? [];
    pruneExpired(timestamps, windowStartMs);

    if (timestamps.length >= limit) {
      // Non-null: the branch is only reachable with `limit >= 1` and at least
      // one live timestamp, and a `limit` of 0 is rejected by the config schema.
      const oldestMs = timestamps[0] ?? currentMs;
      windows.set(key, timestamps);
      next(
        tooManyRequests(
          // Says "for this member" no matter what the key is: an IP-keyed
          // limiter that named the IP would put a caller-supplied value into a
          // response, and the wording difference would also tell an admin-token
          // guesser which limiter they had tripped.
          `Rate limit reached: ${limit} requests per minute for this member.`,
          secondsUntilSlotFrees(oldestMs, currentMs),
        ),
      );
      return;
    }

    timestamps.push(currentMs);
    windows.set(key, timestamps);
    next();
  };
}
