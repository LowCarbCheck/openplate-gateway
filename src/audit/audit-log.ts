/**
 * The audit log: images into the bucket, records into the JSONL file, and the
 * three admin operations over them (list, erase, sweep).
 *
 * ── IT NEVER GATES A COMPLETION ─────────────────────────────────────────────
 * `record` is called after the member already has their answer, and its
 * rejection is logged and dropped by the caller. That ordering is the product
 * decision: an org gateway whose bucket is unreachable must keep answering, or
 * one S3 outage becomes a clinic-wide outage of the thing people actually use.
 * The cost is stated plainly in ADR-0003 and again here — an audit trail that
 * cannot block is an audit trail with gaps.
 *
 * ── PARTIAL RECORDS ARE EXPECTED, AND THE ORDER DECIDES WHICH KIND ──────────
 * Images are uploaded FIRST, then the record is appended. So:
 *
 *   upload fails            → nothing recorded, some objects may be orphaned
 *   record append fails     → objects in the bucket with no record pointing at
 *                             them
 *   process dies in between → the same
 *
 * The other order (record first, then images) would produce the worse artefact:
 * a record listing keys that do not exist, which reads to an auditor as
 * "evidence was deleted". Orphaned objects read as "storage was not tidied up",
 * which is true and harmless. NEITHER IS CLEANED UP AUTOMATICALLY: the retention
 * sweep walks records, so an orphan outlives its retention period. That is a
 * named limitation, not an oversight — see docs/org-mode.md.
 *
 * ── NOTHING HERE LOGS A BODY ────────────────────────────────────────────────
 * Same rule as the rest of the service, and it is sharper here because this is
 * the one module that legitimately HOLDS images. What it logs: counts, keys,
 * member ids, byte totals. `logger.ts`'s field type will not accept a Buffer,
 * and an object KEY is a name we generated, not content.
 */
import { describeError } from '../scrub.js';
import type { Logger } from '../logger.js';
import { auditObjectKey } from './request-images.js';
import type { AuditRecordFile } from './record-file.js';
import type {
  AuditDeletion,
  AuditLog,
  AuditPage,
  AuditQuery,
  AuditRecord,
  AuditWriteInput,
  ObjectStore,
} from './types.js';

const MS_PER_DAY = 86_400_000;

/** The list endpoint's page size when the caller names none, and the ceiling when they name a bigger one. */
export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 500;

export interface CreateAuditLogOptions {
  readonly records: AuditRecordFile;
  readonly objects: ObjectStore;
  readonly retentionDays: number;
  readonly logger: Logger;
}

export function createAuditLog(options: CreateAuditLogOptions): AuditLog {
  const { records, objects, retentionDays, logger } = options;

  /**
   * Deletes objects one key at a time and keeps going past a failure. A bucket
   * that refuses one object must not leave the remaining ones — and their
   * records — in place: a half-finished erasure that reports failure is worse
   * for the operator than one that removes what it can and says how many.
   */
  async function deleteObjects(keys: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      try {
        await objects.delete(key);
        deleted += 1;
      } catch (error) {
        logger.warn('Could not delete an audit object', { key, error: describeError(error) });
      }
    }
    return deleted;
  }

  async function removeMatching(
    shouldRemove: (record: AuditRecord) => boolean,
  ): Promise<AuditDeletion> {
    const removed = await records.remove(shouldRemove);
    const keys = removed.flatMap((record) => [...record.imageKeys]);
    const objectCount = await deleteObjects(keys);
    return { records: removed.length, objects: objectCount };
  }

  return {
    async record(input: AuditWriteInput): Promise<void> {
      const at = new Date(input.ts);
      const imageKeys: string[] = [];
      let storedBytes = 0;
      for (const [index, image] of input.images.entries()) {
        const key = auditObjectKey({
          memberId: input.memberId,
          requestId: input.requestId,
          index,
          mediaType: image.mediaType,
          at,
        });
        await objects.put({ key, body: image.bytes, contentType: image.mediaType });
        imageKeys.push(key);
        storedBytes += image.bytes.byteLength;
      }

      await records.append({
        ts: input.ts,
        memberId: input.memberId,
        requestId: input.requestId,
        model: input.model,
        imageKeys,
        responseText: input.responseText,
      });

      // Counts and keys. The key is a name this process generated; the bytes it
      // points at are not in this line and never will be.
      logger.info('Audit record written', {
        memberId: input.memberId,
        requestId: input.requestId,
        images: imageKeys.length,
        storedBytes,
        responseCaptured: input.responseText !== null,
      });
    },

    async list(query: AuditQuery): Promise<AuditPage> {
      const matching = await findMatching(records, query, logger);
      const limit = clampLimit(query.limit);
      const offset = Math.max(0, query.offset ?? 0);
      return {
        records: matching.slice(offset, offset + limit),
        total: matching.length,
        limit,
        offset,
      };
    },

    find(query: AuditQuery): Promise<readonly AuditRecord[]> {
      return findMatching(records, query, logger);
    },

    /**
     * An erasure request, and the reason the object key starts with the member
     * id. Removes the records first, then their objects: if the process dies in
     * between, the surviving artefact is an unreferenced object rather than a
     * record pointing at bytes that are gone.
     */
    eraseMember(memberId: string): Promise<AuditDeletion> {
      return removeMatching((record) => record.memberId === memberId);
    },

    sweep(now: Date): Promise<AuditDeletion> {
      const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
      return removeMatching((record) => isExpired(record, cutoff));
    },
  };
}

/**
 * A record whose timestamp is older than the cutoff. AN UNPARSEABLE TIMESTAMP IS
 * NEVER SWEPT: `NaN < cutoff` is false, so a row nobody can date survives for an
 * admin to look at rather than being deleted by a comparison that silently said
 * "very old".
 */
function isExpired(record: AuditRecord, cutoffMs: number): boolean {
  const at = Date.parse(record.ts);
  return Number.isFinite(at) && at < cutoffMs;
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_AUDIT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.trunc(requested)), MAX_AUDIT_PAGE_SIZE);
}

/**
 * Filtering in code, over the whole file. Honest about what it is: an audit log
 * is append-only and read rarely, and a household- or clinic-sized one is
 * kilobytes. An index would be a second thing to keep correct, and the failure
 * mode of a stale index on an audit trail is answering "no records" to somebody
 * who needs the records.
 */
async function findMatching(
  records: AuditRecordFile,
  query: AuditQuery,
  logger: Logger,
): Promise<readonly AuditRecord[]> {
  const { records: all, skippedLines } = await records.all();
  if (skippedLines > 0) {
    // A count, so a torn tail is visible to an operator rather than silent.
    logger.warn('Skipped unreadable audit log lines', { skippedLines });
  }

  const from = query.from === undefined ? null : startOfRange(query.from);
  const to = query.to === undefined ? null : endOfRange(query.to);

  return all.filter((record) => {
    if (query.memberId !== undefined && record.memberId !== query.memberId) return false;
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at)) return from === null && to === null;
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  });
}

/** `NaN` propagates as "no bound" — a malformed filter is rejected at the route, not here. */
function startOfRange(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A bare `YYYY-MM-DD` covers the WHOLE of that UTC day. `?to=2026-08-23` meaning
 * "up to 00:00 on the 23rd" would silently exclude every record from the day the
 * admin actually asked about, which is the day something happened.
 */
function endOfRange(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return isBareDate ? parsed + MS_PER_DAY - 1 : parsed;
}
