/**
 * Retention: delete what is older than `AUDIT_RETENTION_DAYS`, and NOTHING ELSE.
 *
 * BOTH HALVES OF THAT SENTENCE ARE ASSERTIONS. A sweep that deletes too little
 * leaves an organisation holding images past the period it told people about; a
 * sweep that deletes too much destroys the trail an auditor came for. The tests
 * below pin the boundary from each side, and pin that a record with an
 * unparseable timestamp is KEPT rather than swept by a comparison that silently
 * read it as "very old".
 *
 * The sweep also runs ONCE AT BOOT, not only on the daily timer — a container
 * that restarts every night would otherwise never sweep at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditLog } from '../../src/audit/audit-log.js';
import { createAuditRecordFile } from '../../src/audit/record-file.js';
import { startAuditRetention } from '../../src/audit/retention.js';
import type { AuditLog } from '../../src/audit/types.js';
import { createCapturingLogger, createSilentLogger } from '../../src/logger.js';
import {
  createRecordingObjectStore,
  type RecordingObjectStore,
} from '../support/fake-object-store.js';
import { waitFor } from '../support/app-harness.js';

const MS_PER_DAY = 86_400_000;
const NOW = new Date('2026-08-23T12:00:00.000Z');

let stateDir: string | undefined;

afterEach(async () => {
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

interface Harness {
  audit: AuditLog;
  objects: RecordingObjectStore;
  recordFile: ReturnType<typeof createAuditRecordFile>;
}

async function makeHarness(retentionDays: number): Promise<Harness> {
  stateDir = await mkdtemp(join(tmpdir(), 'opgw-retention-'));
  const recordFile = createAuditRecordFile(join(stateDir, 'audit-log.jsonl'));
  const objects = createRecordingObjectStore();
  return {
    recordFile,
    objects,
    audit: createAuditLog({
      records: recordFile,
      objects,
      retentionDays,
      logger: createSilentLogger(),
    }),
  };
}

/** Writes one record with the given age, plus the object it points at. */
async function seedRecord(
  harness: Harness,
  parts: { requestId: string; ageDays: number; memberId?: string },
): Promise<string> {
  const ts = new Date(NOW.getTime() - parts.ageDays * MS_PER_DAY).toISOString();
  await harness.audit.record({
    ts,
    memberId: parts.memberId ?? 'alex',
    requestId: parts.requestId,
    model: 'some-vision-model',
    images: [{ mediaType: 'image/jpeg', bytes: Buffer.from('a plate') }],
    responseText: 'rice, chicken',
  });
  return ts;
}

describe('the sweep', () => {
  it('deletes what is past the retention period and keeps what is not', async () => {
    const harness = await makeHarness(30);
    await seedRecord(harness, { requestId: 'ancient', ageDays: 31 });
    await seedRecord(harness, { requestId: 'fresh', ageDays: 29 });

    const deleted = await harness.audit.sweep(NOW);

    expect(deleted).toEqual({ records: 1, objects: 1 });
    const { records } = await harness.recordFile.all();
    expect(records.map((record) => record.requestId)).toEqual(['fresh']);
    // The object went with the record. A swept row pointing at a live image
    // would leave the photograph behind, which is the deletion that matters.
    expect(harness.objects.objects).toHaveLength(1);
    expect(harness.objects.objects[0]?.key).toContain('fresh');
  });

  it('keeps a record exactly at the boundary', async () => {
    // "Older than 30 days" and "30 days old" are different claims, and an
    // organisation that promised 30 days must not delete on day 30.
    const harness = await makeHarness(30);
    await seedRecord(harness, { requestId: 'boundary', ageDays: 30 });

    const deleted = await harness.audit.sweep(new Date(NOW.getTime()));

    expect(deleted).toEqual({ records: 0, objects: 0 });
    expect((await harness.recordFile.all()).records).toHaveLength(1);
  });

  it('deletes nothing when there is nothing expired', async () => {
    const harness = await makeHarness(7);
    await seedRecord(harness, { requestId: 'today', ageDays: 0 });

    expect(await harness.audit.sweep(NOW)).toEqual({ records: 0, objects: 0 });
  });

  it('KEEPS a record whose timestamp cannot be read', async () => {
    // `NaN < cutoff` is false by design: a row nobody can date survives for an
    // admin to look at rather than being deleted by a comparison that silently
    // said "very old".
    const harness = await makeHarness(1);
    await harness.recordFile.append({
      ts: 'not-a-timestamp',
      memberId: 'alex',
      requestId: 'undateable',
      model: 'some-vision-model',
      imageKeys: [],
      responseText: null,
    });

    expect(await harness.audit.sweep(NOW)).toEqual({ records: 0, objects: 0 });
    expect((await harness.recordFile.all()).records).toHaveLength(1);
  });
});

describe('the scheduler', () => {
  it('sweeps once at startup, before the first interval elapses', async () => {
    const harness = await makeHarness(30);
    await seedRecord(harness, { requestId: 'ancient', ageDays: 90 });
    const captured = createCapturingLogger();

    const stop = startAuditRetention({
      audit: harness.audit,
      logger: captured.logger,
      retentionDays: 30,
      now: () => NOW,
      // An interval far beyond the test's lifetime, so a pass here can only be
      // the STARTUP run.
      intervalMs: 3_600_000,
    });

    try {
      await waitFor(async () => (await harness.recordFile.all()).records.length === 0, {
        what: 'the startup sweep to run',
      });
      expect(harness.objects.objects).toHaveLength(0);
      expect(
        captured.lines.some((line) => line.message.includes('retention sweep removed')),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it('logs counts only — never a key, a member or a body', async () => {
    const harness = await makeHarness(30);
    await seedRecord(harness, { requestId: 'ancient', ageDays: 90, memberId: 'alex' });
    const captured = createCapturingLogger();

    const stop = startAuditRetention({
      audit: harness.audit,
      logger: captured.logger,
      retentionDays: 30,
      now: () => NOW,
      intervalMs: 3_600_000,
    });

    try {
      await waitFor(
        () => captured.lines.some((line) => line.message.includes('retention sweep removed')),
        { what: 'the sweep log line' },
      );
      const line = captured.lines.find((entry) => entry.message.includes('retention sweep removed'));
      expect(line?.fields).toEqual({ retentionDays: 30, records: 1, objects: 1 });
    } finally {
      stop();
    }
  });
});
