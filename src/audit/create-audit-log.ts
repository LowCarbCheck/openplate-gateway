/**
 * THE MODE GATE. One function, one branch, and the branch is the whole privacy
 * guarantee: `config.audit === null` returns `null` before anything that can
 * store an image is constructed.
 *
 * It exists as its own module — rather than four lines inside `main.ts` — for
 * one reason: `main.ts` is the module the unit suite deliberately never boots
 * (it reads `process.env`, opens a socket, and installs signal handlers). A
 * guarantee that only holds inside a file no test can run is a guarantee nobody
 * has checked. Here, `createObjectStore` is injectable, so a test hands in a spy
 * and asserts that a family-mode config never calls it.
 */
import type { Config, S3Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createAuditLog } from './audit-log.js';
import { createAuditRecordFile } from './record-file.js';
import { createS3ObjectStore } from './s3-object-store.js';
import type { AuditLog, ObjectStore } from './types.js';

export interface CreateAuditForModeOptions {
  readonly config: Config;
  readonly logger: Logger;
  /**
   * Injectable ONLY so a test can prove it is not called in family mode. In
   * production this is `createS3ObjectStore`, which is the single import site of
   * `@aws-sdk/client-s3` in the service.
   */
  readonly createObjectStore?: (s3: S3Config) => ObjectStore;
}

/** The audit log for an org-mode gateway, or `null` for a family one. */
export function createAuditForMode(options: CreateAuditForModeOptions): AuditLog | null {
  const { config, logger } = options;
  // The `null` audit block IS the family mode. Reading `config.audit` rather
  // than `config.gatewayMode` keeps the two from ever disagreeing — `loadConfig`
  // is what guarantees they are set together.
  if (config.audit === null) return null;

  const createObjectStore = options.createObjectStore ?? createS3ObjectStore;
  return createAuditLog({
    records: createAuditRecordFile(config.audit.recordFile),
    objects: createObjectStore(config.audit.s3),
    retentionDays: config.audit.retentionDays,
    logger,
  });
}
