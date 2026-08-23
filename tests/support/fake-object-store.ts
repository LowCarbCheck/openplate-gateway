/**
 * An in-memory `ObjectStore` — the bucket, without a network.
 *
 * THE ONE FIXTURE IN THIS SUITE THAT DELIBERATELY KEEPS BODIES. Everywhere else
 * (`app-harness.ts`, `fake-upstream.ts`) a fixture that stored a payload would
 * undercut the privacy tests. Here it is the whole point: org mode's promise is
 * that the image reaches the bucket, and the only way to assert that is to hold
 * what arrived and compare it against what was sent.
 *
 * It is also why `ObjectStore` is a port. The real adapter opens a socket to
 * MinIO or S3; nothing in the unit suite may, so the adapter is constructed in
 * exactly one place (`audit/create-audit-log.ts`) and injected everywhere else.
 */
import type { ObjectStore } from '../../src/audit/types.js';

export interface StoredObject {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface RecordingObjectStore extends ObjectStore {
  /** Everything currently in the "bucket", in insertion order. */
  readonly objects: StoredObject[];
  /** Every key ever deleted, including ones that were not there. */
  readonly deletedKeys: string[];
  /** Makes the next `put` (and every one after it) fail — the bucket-is-down case. */
  failPuts(reason?: string): void;
}

export function createRecordingObjectStore(): RecordingObjectStore {
  const objects: StoredObject[] = [];
  const deletedKeys: string[] = [];
  let putFailure: string | null = null;

  return {
    objects,
    deletedKeys,

    failPuts(reason = 'the object store is unreachable'): void {
      putFailure = reason;
    },

    put(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
      if (putFailure !== null) return Promise.reject(new Error(putFailure));
      objects.push({ key: input.key, body: Buffer.from(input.body), contentType: input.contentType });
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      deletedKeys.push(key);
      const index = objects.findIndex((object) => object.key === key);
      // Absent keys are NOT an error — S3 `DeleteObject` is idempotent by
      // specification, and the real adapter relies on that.
      if (index >= 0) objects.splice(index, 1);
      return Promise.resolve();
    },
  };
}
