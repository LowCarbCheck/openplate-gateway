/**
 * In-process quota store — the default for a single instance, and what the
 * tests measure the file store against.
 *
 * HOW IT IS CONCURRENCY-SAFE. `reserve` is declared `async` because the
 * interface is async, but its read-check-write is a single synchronous block
 * with no `await` inside it. Node runs one JavaScript task to completion, so no
 * other caller can observe the counter between the read and the write: N
 * parallel reserves against a limit of L yield exactly min(N, L) successes.
 *
 * That property is fragile in a way worth stating out loud — the first `await`
 * anyone adds between reading `current` and writing it back reintroduces the
 * lost update this store is trusted not to have. If this ever needs to await
 * something, it needs the file store's promise chain too.
 *
 * IT FORGETS ON RESTART, ON PURPOSE-ISH. A process restart hands everybody a
 * fresh allowance. That is fine for tests and for a single-process instance
 * that restarts rarely; it is not fine for anything that crash-loops, which is
 * what `createFileQuotaStore` exists for.
 */
import type { QuotaStore, ReserveResult } from './types.js';

/**
 * Days kept before an entry is dropped. Yesterday's counters are worth keeping
 * for a moment so a support question ("did I really use 50?") is answerable;
 * a week of them is nothing, and an unbounded map in a process meant to run for
 * months is a slow leak.
 */
const RETENTION_DAYS = 7;

/** Lowest day key still worth keeping, given the day currently being written. */
function retentionCutoff(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export function createMemoryQuotaStore(): QuotaStore {
  /** day -> memberId -> units used. Keyed by day first so pruning is one delete per day. */
  const days = new Map<string, Map<string, number>>();

  function prune(currentDay: string): void {
    const cutoff = retentionCutoff(currentDay);
    if (cutoff === '') return;
    // `YYYY-MM-DD` sorts lexicographically the same way it sorts chronologically.
    for (const day of days.keys()) {
      if (day < cutoff) days.delete(day);
    }
  }

  return {
    async reserve(memberId: string, day: string, limit: number): Promise<ReserveResult> {
      // --- no `await` from here to the write below; see the module header ---
      const members = days.get(day) ?? new Map<string, number>();
      const current = members.get(memberId) ?? 0;
      if (current >= limit) {
        // Covers `limit <= 0` too: a member with no allowance never spends one.
        return { ok: false, used: current, limit };
      }
      const next = current + 1;
      members.set(memberId, next);
      days.set(day, members);
      prune(day);
      // --- end of the atomic block ---
      return { ok: true, used: next, limit };
    },

    async release(memberId: string, day: string): Promise<void> {
      const members = days.get(day);
      if (!members) return;
      const current = members.get(memberId);
      if (current === undefined) return;
      // Floor at zero: a double release must not mint allowance out of nothing.
      members.set(memberId, Math.max(0, current - 1));
    },

    async used(memberId: string, day: string): Promise<number> {
      return days.get(day)?.get(memberId) ?? 0;
    },
  };
}
