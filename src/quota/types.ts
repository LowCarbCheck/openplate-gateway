/**
 * The quota contract: one shared provider key, several members, a hard cap each.
 *
 * WHY THIS LAYER IS THE CAREFUL ONE. Every other part of this service can fail
 * loudly and cost nothing. This one guards a credit card. An off-by-one here is
 * not a bug report, it is a bill — so the contract is written so a store CANNOT
 * quietly allow one more request than it was told to.
 *
 * The unit is ONE REQUEST, not tokens. Requests are the only thing the gateway
 * can count before it forwards, and a cap you can only evaluate after the spend
 * is not a cap. A member with `dailyLimit: 50` gets 50 upstream calls per UTC
 * day, whatever they cost.
 *
 * RESERVE-THEN-RELEASE, NOT COUNT-AFTERWARDS. The caller reserves BEFORE the
 * upstream call and releases only if the call never reached the provider. The
 * reverse order — forward first, count after — has a window in which N parallel
 * requests all see the old count and all go through. The window is small and it
 * is exactly what an unattended script hits.
 */

/** The outcome of trying to spend one request against a member's daily allowance. */
export type ReserveResult =
  | { readonly ok: true; readonly used: number; readonly limit: number }
  | { readonly ok: false; readonly used: number; readonly limit: number };

export interface QuotaStore {
  /**
   * Atomically reserve ONE unit for `memberId` on `day`, up to `limit`.
   * Must be safe against concurrent callers: N parallel reserves against a
   * limit of L yield exactly min(N, L) successes, never L+1.
   *
   * On success `used` is the count INCLUDING this reservation, so the caller can
   * put it straight into an `X-Quota-Used` header. On refusal `used` is the
   * unchanged current count, which for a refusal always equals `limit` (or the
   * limit is zero or negative, and nothing was ever spendable).
   */
  reserve(memberId: string, day: string, limit: number): Promise<ReserveResult>;
  /**
   * Give a reserved unit back — the upstream call failed before any spend happened.
   *
   * Only call this when the provider was NOT reached (connect error, our own
   * timeout before bytes, a 429 from the provider's edge). A 500 from the model
   * still burned the money; releasing it would hand out a free retry loop.
   *
   * Never goes below zero, and never invents an entry for a member that has none.
   */
  release(memberId: string, day: string): Promise<void>;
  /** Units used by `memberId` on `day`. */
  used(memberId: string, day: string): Promise<number>;
}

/**
 * The UTC day key, `YYYY-MM-DD`. Exported so callers and tests agree on it.
 *
 * DAY BOUNDARIES ARE UTC, DELIBERATELY. A household can span time zones, and a
 * local-midnight reset means the member in the later zone crosses their own
 * midnight while the counter still thinks it is yesterday — a second allowance
 * for one member, for free, every single day. One global instant for the reset
 * is the only version where every member gets exactly one allowance per day.
 * It also makes the key sort lexicographically, which is what the file store's
 * retention pruning relies on.
 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
