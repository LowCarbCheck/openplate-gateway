/**
 * N parallel reservations against a limit of L yield exactly L successes.
 * Never L+1. This is the test that guards a credit card.
 *
 * THE CONCURRENCY HAS TO BE REAL. A sequential loop passes against a broken
 * store — the lost update only exists when two read-modify-writes interleave —
 * so a loop here would be worse than no test: it would report green on the one
 * defect the quota layer exists to prevent. Every case below fires its
 * reservations with `Promise.all` and never awaits between them.
 *
 * BOTH STORES ARE MEASURED. They are safe for different reasons and only one of
 * them is fragile:
 *  - `createMemoryQuotaStore` has no `await` between its read and its write, so
 *    Node's run-to-completion guarantees the atomicity. The first `await`
 *    anybody adds inside that block breaks it, and this test is what notices.
 *  - `createFileQuotaStore` awaits a real file read, so it CANNOT rely on that.
 *    It serialises every operation onto one promise chain instead. Run against
 *    a real temp directory, because the defect being hunted is a filesystem
 *    round-trip, not an abstraction over one.
 *
 * The final case drives the whole app: eight parallel HTTP requests against a
 * limit of three, which is the shape a page with several in-flight calls
 * actually produces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatRequest,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';
import { createFileQuotaStore } from '../../src/quota/file-store.js';
import { createMemoryQuotaStore } from '../../src/quota/memory-store.js';
import type { QuotaStore } from '../../src/quota/types.js';

const DAY = '2026-08-19';
const MEMBER = 'alex';

let temporaryDirectory: string | null = null;

async function makeTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'openplate-gateway-quota-'));
  return temporaryDirectory;
}

afterEach(async () => {
  if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

/** Fires `count` reservations with no await between them, and counts the grants. */
async function reserveInParallel(
  store: QuotaStore,
  options: { count: number; limit: number },
): Promise<{ granted: number; refused: number }> {
  const attempts = Array.from({ length: options.count }, () =>
    store.reserve(MEMBER, DAY, options.limit),
  );
  const results = await Promise.all(attempts);
  return {
    granted: results.filter((result) => result.ok).length,
    refused: results.filter((result) => !result.ok).length,
  };
}

const stores: readonly { name: string; create: () => Promise<QuotaStore> }[] = [
  { name: 'createMemoryQuotaStore', create: async () => createMemoryQuotaStore() },
  {
    name: 'createFileQuotaStore',
    create: async () => createFileQuotaStore(join(await makeTemporaryDirectory(), 'quota.json')),
  },
];

describe.each(stores)('$name under parallel load', ({ create }) => {
  it('grants exactly the limit when 12 reservations race against a limit of 4', async () => {
    const store = await create();

    const { granted, refused } = await reserveInParallel(store, { count: 12, limit: 4 });

    expect(granted).toBe(4);
    expect(refused).toBe(8);
    expect(await store.used(MEMBER, DAY)).toBe(4);
  });

  it('grants all of them when the limit exceeds the number of racers', async () => {
    // The other direction, so the test cannot pass by refusing everything.
    const store = await create();

    const { granted, refused } = await reserveInParallel(store, { count: 5, limit: 20 });

    expect(granted).toBe(5);
    expect(refused).toBe(0);
    expect(await store.used(MEMBER, DAY)).toBe(5);
  });

  it('numbers the granted reservations 1..L with no repeats', async () => {
    // A lost update can also show up as two grants reporting the same `used`,
    // which would put the same number into two `X-Quota-Used` headers.
    const store = await create();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.reserve(MEMBER, DAY, 6)),
    );

    const used = results
      .filter((result) => result.ok)
      .map((result) => result.used)
      .toSorted((a, b) => a - b);
    expect(used).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps members apart while they race each other', async () => {
    const store = await create();
    const attempts = [
      ...Array.from({ length: 6 }, () => store.reserve('alex', DAY, 2)),
      ...Array.from({ length: 6 }, () => store.reserve('sam', DAY, 3)),
    ];
    await Promise.all(attempts);

    expect(await store.used('alex', DAY)).toBe(2);
    expect(await store.used('sam', DAY)).toBe(3);
  });

  it('releases concurrently without ever going below zero', async () => {
    const store = await create();
    await reserveInParallel(store, { count: 2, limit: 2 });

    // More releases than reservations — a double release must not mint
    // allowance out of nothing.
    await Promise.all(Array.from({ length: 5 }, () => store.release(MEMBER, DAY)));

    expect(await store.used(MEMBER, DAY)).toBe(0);
  });
});

describe('createFileQuotaStore, on a real filesystem', () => {
  it('leaves one valid JSON file and no temp files behind after a race', async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'quota.json');
    const store = createFileQuotaStore(filePath);

    await reserveInParallel(store, { count: 12, limit: 4 });

    // A torn write would leave either a truncated file or a `.tmp` next to it.
    const entries = await readdir(directory);
    expect(entries).toEqual(['quota.json']);
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed).toEqual({ days: { [DAY]: { [MEMBER]: 4 } } });
  });

  it('creates its directory rather than failing when the parent does not exist', async () => {
    const directory = await makeTemporaryDirectory();
    const store = createFileQuotaStore(join(directory, 'nested', 'deeper', 'quota.json'));

    const result = await store.reserve(MEMBER, DAY, 1);

    expect(result.ok).toBe(true);
    expect(await store.used(MEMBER, DAY)).toBe(1);
  });

  it('survives a restart: a second store over the same file sees the spend', async () => {
    // The whole reason the file store exists. If this fails, a crash-loop hands
    // every member a brand-new allowance and nothing looks broken from outside.
    const directory = await makeTemporaryDirectory();
    const filePath = join(directory, 'quota.json');

    await reserveInParallel(createFileQuotaStore(filePath), { count: 3, limit: 3 });
    const afterRestart = createFileQuotaStore(filePath);

    expect(await afterRestart.used(MEMBER, DAY)).toBe(3);
    expect((await afterRestart.reserve(MEMBER, DAY, 3)).ok).toBe(false);
  });
});

describe('the proxy under parallel load', () => {
  let app: TestApp | null = null;
  let upstream: FakeUpstream | null = null;

  beforeEach(async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({
      members: [{ id: 'alex', token: 'opg_test_token_alex', dailyLimit: 3 }],
      upstreamBaseUrl: upstream.baseUrl,
      // The burst limiter is not what is under test here; leave it out of the way
      // so a 429 can only have come from the daily quota.
      config: { rateLimitPerMinute: 100 },
    });
  });

  afterEach(async () => {
    await app?.close();
    await upstream?.close();
    app = null;
    upstream = null;
  });

  it('serves exactly the daily limit when eight requests arrive at once', async () => {
    const started = app;
    const upstreamCalls = upstream;
    if (started === null || upstreamCalls === null) throw new Error('harness did not start');
    const dataUri = toDataUri(makePhotoBytes(1024));

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        started.post('/v1/chat/completions', chatRequest(dataUri)),
      ),
    );

    const statuses = responses.map((response) => response.status).toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    // The provider — and the bill — saw exactly three.
    expect(upstreamCalls.requests).toHaveLength(3);
  });
});
