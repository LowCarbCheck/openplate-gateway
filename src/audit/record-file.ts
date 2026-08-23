/**
 * The audit records on disk: ONE JSON OBJECT PER LINE, appended.
 *
 * WHY JSONL AND NOT `store/atomic-json-file.ts`. The other three stores hold a
 * roster — tens of rows, rewritten in full on every change. This file grows by
 * one row per completion and is never edited in place, so the whole-file
 * read-modify-write those stores do would re-serialise the entire audit history
 * on every proxied request. An append is O(1) and is also the shape the export
 * endpoint hands back verbatim.
 *
 * IT KEEPS THE TWO DEFENCES THAT MATTER, in the two places they apply:
 *
 *  - THE LOCK. Every operation is queued onto one promise chain, exactly as
 *    `atomic-json-file.ts` does. An append and a retention sweep interleaving
 *    would drop the appended row on the sweep's rewrite.
 *  - THE ATOMIC REWRITE. Deletions (erasure, retention) cannot be appends, so
 *    they write a temp file in the SAME directory and `rename` it over the
 *    target. A process killed mid-rewrite leaves the old file intact, which for
 *    a deletion is the safe direction to fail in.
 *
 * SINGLE PROCESS, like every other store here. The chain serialises this
 * process, not the machine; two gateways pointed at one state directory need a
 * database, not this file.
 *
 * A TORN LAST LINE IS SKIPPED, NOT FATAL — the one place this file's policy
 * differs from the member store's, and deliberately. An append is not atomic, so
 * a crash mid-write leaves a half-written final line; refusing to read the whole
 * log because of it would take the entire audit trail away from the admin who
 * came to read it, over one row. Skipped lines are COUNTED and reported to the
 * caller, so the loss is visible rather than silent.
 */
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AuditRecord } from './types.js';

const AuditRecordSchema = z.object({
  ts: z.string().min(1),
  memberId: z.string().min(1),
  requestId: z.string().min(1),
  model: z.string().min(1),
  imageKeys: z.array(z.string().min(1)),
  responseText: z.string().nullable(),
});

export interface AuditRecordsRead {
  readonly records: readonly AuditRecord[];
  /** Lines that did not parse — a torn tail, or a hand-edited file. */
  readonly skippedLines: number;
}

export interface AuditRecordFile {
  append(record: AuditRecord): Promise<void>;
  all(): Promise<AuditRecordsRead>;
  /**
   * Removes every record the predicate accepts and rewrites the file. Returns
   * what was removed, so the caller can delete the matching objects.
   */
  remove(shouldRemove: (record: AuditRecord) => boolean): Promise<readonly AuditRecord[]>;
}

export function createAuditRecordFile(filePath: string): AuditRecordFile {
  const directory = dirname(filePath);
  let temporaryCounter = 0;

  /** THE LOCK. See the module header — an append must not interleave with a sweep. */
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = chain.then(operation);
    // A rejected operation must not poison the chain for everyone behind it; the
    // rejection still reaches its own caller through `result`.
    chain = result.catch(() => undefined);
    return result;
  }

  async function readUnlocked(): Promise<AuditRecordsRead> {
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      // Absent is the normal state until the first audited request.
      if (isFileNotFound(error)) return { records: [], skippedLines: 0 };
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read the audit log at ${filePath}: ${reason}`, { cause: error });
    }

    const records: AuditRecord[] = [];
    let skippedLines = 0;
    for (const line of contents.split('\n')) {
      if (line.trim().length === 0) continue;
      const record = parseLine(line);
      if (record === null) {
        skippedLines += 1;
        continue;
      }
      records.push(record);
    }
    return { records, skippedLines };
  }

  async function writeAllUnlocked(records: readonly AuditRecord[]): Promise<void> {
    await mkdir(directory, { recursive: true });
    temporaryCounter += 1;
    const temporaryPath = join(directory, `.audit-log-${process.pid}-${temporaryCounter}.tmp`);
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    await writeFile(temporaryPath, body, 'utf8');
    await rename(temporaryPath, filePath);
  }

  return {
    append(record: AuditRecord): Promise<void> {
      return enqueue(async () => {
        await mkdir(directory, { recursive: true });
        await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      });
    },

    all(): Promise<AuditRecordsRead> {
      return enqueue(readUnlocked);
    },

    remove(shouldRemove: (record: AuditRecord) => boolean): Promise<readonly AuditRecord[]> {
      return enqueue(async () => {
        const { records } = await readUnlocked();
        const removed = records.filter((record) => shouldRemove(record));
        if (removed.length === 0) return removed;
        await writeAllUnlocked(records.filter((record) => !shouldRemove(record)));
        return removed;
      });
    },
  };
}

/** `null` for a line that is not a complete, well-shaped record. */
function parseLine(line: string): AuditRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = AuditRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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
