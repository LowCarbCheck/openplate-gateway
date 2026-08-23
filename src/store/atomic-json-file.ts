/**
 * One JSON file, read and written safely — the primitive the member store and
 * the invite store are both built on.
 *
 * This is `quota/file-store.ts`'s two defences, lifted out so a second and third
 * writable file do not have to re-derive them. `quota/file-store.ts` itself is
 * deliberately NOT refactored onto this: it is the one file guarding money, its
 * contract is pinned by a concurrency test that hunts for a specific defect, and
 * "while I was here" is how that kind of test starts passing for the wrong
 * reason. The duplication is small and the blast radius of the alternative is not.
 *
 * THE TWO DEFECTS THIS EXISTS TO PREVENT:
 *
 * 1. LOST UPDATE. Every mutation is a read-modify-write, and the read is
 *    `await`ed. Two concurrent redemptions of the same invite would both read
 *    it as unredeemed and both create a member. So every operation — reads
 *    included — is queued onto ONE promise chain and runs strictly one at a
 *    time. `update` is therefore the only mutation entry point: it hands the
 *    caller the current state and takes the next one back, inside the lock.
 *
 * 2. TORN WRITE. A process killed mid-`writeFile` leaves a truncated file.
 *    Writes go to a temp file in the SAME directory and are then `rename`d over
 *    the target; `rename` within one filesystem is atomic, so a reader sees
 *    either the whole old file or the whole new one. Same directory matters — a
 *    cross-device rename is a copy, and a copy is not atomic.
 *
 * A MISSING FILE READS AS EMPTY, A CORRUPT ONE THROWS. This is the one place the
 * policy differs from the quota store, and deliberately: an unreadable quota
 * file costs at most one day's extra allowance, while an unreadable MEMBER file
 * that silently read as empty would authenticate nobody and — worse — let the
 * next write replace a registry that was merely unparseable with an empty one.
 * Losing every member's identity to a stray byte is not a recoverable state, so
 * a file that exists and does not parse stops the caller instead.
 *
 * ONE WRITER PER FILE. The chain serialises this process, not the machine. Two
 * gateway processes pointed at one file will still lose updates to each other.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

export interface AtomicJsonFile<T> {
  /** The parsed contents, or the empty value if the file does not exist yet. */
  read(): Promise<T>;
  /**
   * Read, transform, write — all inside the lock, so no other operation on this
   * file can interleave. The value `mutate` returns is what gets written; the
   * value it resolves to in `result` is what the caller gets back.
   */
  update<R>(mutate: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>): Promise<R>;
}

export interface CreateAtomicJsonFileOptions<T> {
  filePath: string;
  schema: z.ZodType<T>;
  /** Returned when the file is absent. A fresh copy each time — never a shared mutable. */
  empty: () => T;
  /** Names the file in the error a corrupt read throws, e.g. "member store". */
  label: string;
  /** Prefix for the temp file written next to the target. Distinct per store. */
  temporaryPrefix: string;
}

export function createAtomicJsonFile<T>(options: CreateAtomicJsonFileOptions<T>): AtomicJsonFile<T> {
  const { filePath, schema, empty, label, temporaryPrefix } = options;
  const directory = dirname(filePath);
  let temporaryCounter = 0;

  /**
   * THE LOCK. Every operation appends to this chain, so operation N+1 cannot
   * read the file until operation N has renamed its write into place. The
   * `catch` keeps a rejected operation from poisoning the chain for everyone
   * behind it — the rejection still reaches its own caller through `result`.
   */
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = chain.then(operation);
    chain = result.catch(() => undefined);
    return result;
  }

  async function readUnlocked(): Promise<T> {
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      // Absent is the normal first-boot state. Anything else — a permission
      // error, a directory where a file should be — is a real fault and must
      // not be mistaken for "no members yet".
      if (isFileNotFound(error)) return empty();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read ${label} at ${filePath}: ${reason}`, { cause: error });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `The ${label} at ${filePath} is not valid JSON. Refusing to overwrite it — ` +
          'move it aside if you meant to start fresh.',
        { cause: error },
      );
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `The ${label} at ${filePath} does not match the expected shape. Refusing to ` +
          'overwrite it — move it aside if you meant to start fresh.',
      );
    }
    return parsed.data;
  }

  async function writeUnlocked(state: T): Promise<void> {
    await mkdir(directory, { recursive: true });
    // Temp file in the SAME directory, so the rename below stays within one
    // filesystem and therefore stays atomic. The pid and counter keep two
    // instances in one process from colliding on the temp name.
    temporaryCounter += 1;
    const temporaryPath = join(directory, `.${temporaryPrefix}-${process.pid}-${temporaryCounter}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }

  return {
    read(): Promise<T> {
      // Queued like the mutations, so a read never lands between another
      // operation's read and its rename.
      return enqueue(readUnlocked);
    },

    update<R>(
      mutate: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>,
    ): Promise<R> {
      return enqueue(async () => {
        const current = await readUnlocked();
        const { next, result } = await mutate(current);
        await writeUnlocked(next);
        return result;
      });
    },
  };
}

/** `ENOENT` and nothing else. Narrowed from `unknown` because `catch` gives no guarantees. */
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
