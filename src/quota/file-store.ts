/**
 * Quota store that survives a restart.
 *
 * WHY IT HAS TO BE DURABLE. The counter is the only thing standing between a
 * shared provider key and an unbounded bill. If it lives only in memory, then a
 * crash-loop, a redeploy, or an OOM kill hands every member a brand-new daily
 * allowance — and the failure is invisible, because from the outside the
 * gateway just kept working.
 *
 * TWO DEFECTS THIS FILE IS SHAPED AROUND:
 *
 * 1. LOST UPDATE. Every mutation is a read-modify-write of one JSON file, and
 *    the read is `await`ed. Two concurrent `reserve` calls would both read
 *    `used: 49`, both write `50`, and 51 requests would get through a limit of
 *    50. So every operation — reads included — is queued onto ONE promise chain
 *    (`enqueue`) and runs strictly one at a time. This is the defect the
 *    concurrency test hunts for; it is not theoretical, it is what a page with
 *    six parallel requests produces on the first try.
 *
 * 2. TORN WRITE. A process killed mid-`writeFile` leaves a truncated file that
 *    is not valid JSON — and on some inputs, worse, a file that IS valid JSON
 *    but holds half the counters. So writes go to a temp file in the SAME
 *    directory and are then `rename`d over the target. `rename` within one
 *    filesystem is atomic: a reader sees either the whole old file or the whole
 *    new one, never a prefix. Same directory matters — a cross-device rename is
 *    a copy, and a copy is not atomic.
 *
 * A MISSING OR CORRUPT FILE STARTS EMPTY RATHER THAN THROWING. The two failure
 * directions are not symmetric: refusing to start means the household loses the
 * service over a counter file, while starting empty means at most one day's
 * allowance is granted twice. This module deliberately takes no logger and says
 * nothing — it has no dependency but zod and `node:fs`, which is what lets the
 * quota layer be unit-tested with no wiring at all. The caller that opens the
 * file at boot is the right place to notice and log a reset.
 *
 * ONE WRITER PER FILE. The chain serialises this process, not the machine. Two
 * gateway processes pointed at the same file will still lose updates to each
 * other; that deployment needs a real database, not this store.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { QuotaStore, ReserveResult } from './types.js';

/** Days kept on write. Bounds the file: members × 7 entries, whatever the uptime. */
const RETENTION_DAYS = 7;

/**
 * `{ days: { "2026-08-19": { "alex": 12 } } }`. Anything that fails this — a
 * truncated file, a hand-edit, a negative or fractional count — is treated as
 * absent. Partial recovery is not worth it: a half-trusted counter is a counter
 * nobody can reason about.
 */
const StateSchema = z.object({
  days: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
});

type State = z.infer<typeof StateSchema>;

const EMPTY_STATE: State = { days: {} };

/** Lowest day key still worth keeping, given the day currently being written. */
function retentionCutoff(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** Drops day entries outside the retention window. `YYYY-MM-DD` sorts chronologically. */
function prune(state: State, currentDay: string): State {
  const cutoff = retentionCutoff(currentDay);
  if (cutoff === '') return state;
  const days: State['days'] = {};
  for (const [day, members] of Object.entries(state.days)) {
    if (day >= cutoff) days[day] = members;
  }
  return { days };
}

export function createFileQuotaStore(filePath: string): QuotaStore {
  const directory = dirname(filePath);
  let tempCounter = 0;

  /**
   * THE LOCK. Every operation appends to this chain, so operation N+1 cannot
   * read the file until operation N has renamed its write into place. The
   * `catch` keeps a rejected operation from poisoning the chain for everyone
   * behind it — the rejection still reaches its own caller through `result`.
   */
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation);
    chain = result.catch(() => undefined);
    return result;
  }

  async function read(): Promise<State> {
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch {
      return EMPTY_STATE;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      return EMPTY_STATE;
    }
    const parsed = StateSchema.safeParse(raw);
    return parsed.success ? parsed.data : EMPTY_STATE;
  }

  async function write(state: State): Promise<void> {
    await mkdir(directory, { recursive: true });
    // Temp file in the SAME directory, so the rename below stays within one
    // filesystem and therefore stays atomic. The pid and counter keep two
    // instances in one process from colliding on the temp name.
    tempCounter += 1;
    const temporaryPath = join(directory, `.quota-${process.pid}-${tempCounter}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }

  return {
    reserve(memberId: string, day: string, limit: number): Promise<ReserveResult> {
      return enqueue(async () => {
        const state = await read();
        const current = state.days[day]?.[memberId] ?? 0;
        if (current >= limit) {
          // Covers `limit <= 0`: a member with no allowance never spends one.
          // No write, so a hammering over-quota client does not churn the disk.
          return { ok: false as const, used: current, limit };
        }
        const next = current + 1;
        const pruned = prune(state, day);
        pruned.days[day] = { ...pruned.days[day], [memberId]: next };
        await write(pruned);
        return { ok: true as const, used: next, limit };
      });
    },

    release(memberId: string, day: string): Promise<void> {
      return enqueue(async () => {
        const state = await read();
        const current = state.days[day]?.[memberId];
        if (current === undefined) return;
        const pruned = prune(state, day);
        // Floor at zero: a double release must not mint allowance out of nothing.
        pruned.days[day] = { ...pruned.days[day], [memberId]: Math.max(0, current - 1) };
        await write(pruned);
      });
    },

    used(memberId: string, day: string): Promise<number> {
      // Queued like the mutations, so a read never lands between another
      // operation's read and its rename and reports a count about to change.
      return enqueue(async () => {
        const state = await read();
        return state.days[day]?.[memberId] ?? 0;
      });
    },
  };
}
