/**
 * The allowance resets at UTC midnight, and only at UTC midnight.
 *
 * WHY UTC IS THE ASSERTION. A household can span time zones. With a
 * local-midnight reset, the member in the later zone crosses their own midnight
 * while the counter still thinks it is yesterday — a second full allowance, for
 * free, every single day, for exactly one member. One global instant is the only
 * version where everybody gets one allowance per day.
 *
 * The clock is injected into the real app, so these tests assert the boundary the
 * PROXY keys on rather than the boundary `utcDayKey` computes in isolation. A
 * correct helper wired to `new Date()` at the call site would pass a unit test
 * of the helper and still bill the wrong day.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatRequest,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  type TestApp,
  type TestResponse,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';
import { createFileQuotaStore } from '../../src/quota/file-store.js';
import { createMemoryQuotaStore } from '../../src/quota/memory-store.js';
import { utcDayKey } from '../../src/quota/types.js';

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;
let temporaryDirectory: string | null = null;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = null;
  upstream = null;
  if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe('utcDayKey', () => {
  it('changes at UTC midnight and nowhere else', () => {
    expect(utcDayKey(new Date('2026-08-19T00:00:00.000Z'))).toBe('2026-08-19');
    expect(utcDayKey(new Date('2026-08-19T23:59:59.999Z'))).toBe('2026-08-19');
    expect(utcDayKey(new Date('2026-08-20T00:00:00.000Z'))).toBe('2026-08-20');
  });

  it('ignores the host time zone', () => {
    // Two instants an hour apart that share a UTC day but not a local one in
    // most of Europe.
    expect(utcDayKey(new Date('2026-08-19T22:30:00.000Z'))).toBe('2026-08-19');
    expect(utcDayKey(new Date('2026-08-19T23:30:00.000Z'))).toBe('2026-08-19');
  });

  it('sorts lexicographically the same way it sorts chronologically', () => {
    // The file store's retention pruning relies on this.
    const keys = ['2026-08-19', '2026-07-31', '2026-12-01', '2025-12-31'];
    expect(keys.toSorted()).toEqual(['2025-12-31', '2026-07-31', '2026-08-19', '2026-12-01']);
  });
});

describe('the proxy across a UTC day boundary', () => {
  it('grants a fresh allowance after midnight, and not a minute before', async () => {
    upstream = await startFakeUpstream();
    let currentInstant = new Date('2026-08-19T23:59:00.000Z');
    app = await startTestApp({
      members: [{ id: 'alex', token: 'opg_test_token_alex', dailyLimit: 2 }],
      upstreamBaseUrl: upstream.baseUrl,
      now: () => currentInstant,
    });
    const started = app;
    const dataUri = toDataUri(makePhotoBytes(1024));
    const send = (): Promise<TestResponse> =>
      started.post('/v1/chat/completions', chatRequest(dataUri));

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    // Still 19 August: the allowance is spent.
    currentInstant = new Date('2026-08-19T23:59:59.999Z');
    const refused = await send();
    expect(refused.status).toBe(429);
    // The 429 names the instant the allowance comes back.
    expect((refused.body as { error: { message: string } }).error.message).toContain(
      '2026-08-20T00:00:00.000Z',
    );
    expect(Number(refused.headers.get('retry-after'))).toBe(1);

    // One millisecond later it is a new UTC day.
    currentInstant = new Date('2026-08-20T00:00:00.000Z');
    expect((await send()).status).toBe(200);
    expect(await started.quota.used('alex', '2026-08-20')).toBe(1);
    // Yesterday's counter is untouched — it is a different key, not a reset.
    expect(await started.quota.used('alex', '2026-08-19')).toBe(2);
  });
});

describe('retention pruning', () => {
  it('drops day entries older than a week from the file store', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'openplate-gateway-retention-'));
    const filePath = join(temporaryDirectory, 'quota.json');
    const store = createFileQuotaStore(filePath);

    await store.reserve('alex', '2026-08-01', 10); // 18 days before the write below
    await store.reserve('alex', '2026-08-15', 10); // inside the window
    await store.reserve('alex', '2026-08-19', 10); // the day being written

    const state: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    expect(Object.keys((state as { days: Record<string, unknown> }).days).toSorted()).toEqual([
      '2026-08-15',
      '2026-08-19',
    ]);
  });

  it('drops them from the memory store too, so a long-lived process does not leak', async () => {
    const store = createMemoryQuotaStore();
    await store.reserve('alex', '2026-08-01', 10);
    await store.reserve('alex', '2026-08-19', 10);

    expect(await store.used('alex', '2026-08-01')).toBe(0);
    expect(await store.used('alex', '2026-08-19')).toBe(1);
  });

  it('keeps yesterday, so a support question is still answerable', async () => {
    const store = createMemoryQuotaStore();
    await store.reserve('alex', '2026-08-18', 10);
    await store.reserve('alex', '2026-08-19', 10);

    expect(await store.used('alex', '2026-08-18')).toBe(1);
  });
});
