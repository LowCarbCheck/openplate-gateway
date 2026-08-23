/**
 * The ONE module in this service that imports an S3 client.
 *
 * It is imported by `create-audit-log.ts` and by nothing else, and that module
 * only calls it when `config.audit !== null` — so a family-mode process
 * constructs no client, opens no connection pool and holds no bucket credential.
 * A test asserts exactly that by handing `createAuditForMode` a spying factory
 * and checking it is never called.
 *
 * CUSTOM ENDPOINTS ARE THE POINT, not a fallback. `endpoint` is mandatory in
 * `S3Config` and `forcePathStyle` is a first-class setting, because the
 * deployment this mode exists for — a clinic that must keep patient photographs
 * on hardware it controls — runs MinIO or Ceph in its own rack, not AWS.
 *
 * DELETE IS ONE KEY AT A TIME, not `DeleteObjects`. The batch API is an S3
 * extension that several compatible implementations either lack or implement
 * differently, and an erasure that silently no-ops on somebody's object store is
 * the worst possible bug in this file. One request per object is slower and
 * correct everywhere.
 *
 * A MISSING OBJECT IS NOT AN ERROR. S3 `DeleteObject` is idempotent by
 * specification, which is what makes a retried erasure safe.
 */
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from '../config.js';
import type { ObjectStore } from './types.js';

export function createS3ObjectStore(s3: S3Config): ObjectStore {
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  });

  return {
    async put(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    },

    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
    },
  };
}
