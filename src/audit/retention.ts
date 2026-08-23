/**
 * The retention sweep: delete audit records and their stored images once they
 * are older than `AUDIT_RETENTION_DAYS`.
 *
 * ONCE AT BOOT, THEN DAILY. The boot run is the important one: a gateway that
 * only swept on a timer would keep everything for a day after every restart, and
 * a container that restarts daily would never sweep at all. Retention that
 * depends on uptime is not retention.
 *
 * IT LOGS COUNTS AND NOTHING ELSE. Two numbers — records and objects removed.
 * Not the keys, not the member ids, not what was in them: a retention log that
 * named what it deleted would outlive the data it deleted, which defeats the
 * point of deleting it.
 *
 * A FAILING SWEEP IS LOGGED, NOT FATAL. An unreachable bucket must not kill a
 * gateway people are using; the next run tries again, and the records it could
 * not delete are still there to be swept.
 */
import { describeError } from '../scrub.js';
import type { Logger } from '../logger.js';
import type { AuditLog } from './types.js';

/** Daily. The unit of `AUDIT_RETENTION_DAYS` is a day, so a finer cadence buys nothing. */
export const AUDIT_SWEEP_INTERVAL_MS = 86_400_000;

export interface StartAuditRetentionOptions {
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly retentionDays: number;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

/** Stops the timer. Returned rather than assumed, so a test never leaves one running. */
export type StopAuditRetention = () => void;

export function startAuditRetention(options: StartAuditRetentionOptions): StopAuditRetention {
  const { audit, logger, retentionDays } = options;
  const now = options.now ?? ((): Date => new Date());
  const intervalMs = options.intervalMs ?? AUDIT_SWEEP_INTERVAL_MS;

  async function sweepQuietly(): Promise<void> {
    try {
      const deleted = await audit.sweep(now());
      if (deleted.records === 0 && deleted.objects === 0) return;
      logger.info('Audit retention sweep removed expired records', {
        retentionDays,
        records: deleted.records,
        objects: deleted.objects,
      });
    } catch (error) {
      logger.warn('Audit retention sweep failed; it will run again', {
        retentionDays,
        error: describeError(error),
      });
    }
  }

  void sweepQuietly();
  const timer = setInterval(() => void sweepQuietly(), intervalMs);
  // Never hold the process open for a sweep. Shutdown is decided by the HTTP
  // server closing, not by a timer nobody is waiting for.
  timer.unref();

  return (): void => clearInterval(timer);
}
