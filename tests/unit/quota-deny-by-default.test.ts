/**
 * A registry entry that forgets `dailyLimit` denies EVERY request.
 *
 * This is the one default in the service where the two choices are not close.
 * "Unlimited" looks exactly like "working" until the bill arrives weeks later,
 * on a shared provider key nobody was watching. Zero fails on the first call,
 * loudly, in front of the person who just edited the file.
 *
 * Both halves are asserted, because either one alone can pass while the product
 * is broken: `parseMembers` defaulting the field to 0 (the schema), and the
 * proxy actually refusing with 429 and never reaching the provider (the
 * runtime). A schema default that no call site honours is not a spend control.
 *
 * The last test is what stops this file passing by rejecting everything: a
 * member WITH a limit is served.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatRequest,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';
import { parseMembers } from '../../src/members.js';
import { createMemoryQuotaStore } from '../../src/quota/memory-store.js';

const NO_LIMIT_TOKEN = 'opg_test_token_forgetful';
const WITH_LIMIT_TOKEN = 'opg_test_token_careful';

const MEMBERS = [
  // `dailyLimit` deliberately absent — this is the entry a human forgets.
  { id: 'forgetful', token: NO_LIMIT_TOKEN },
  { id: 'careful', token: WITH_LIMIT_TOKEN, dailyLimit: 3 },
];

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = null;
  upstream = null;
});

describe('parseMembers', () => {
  it('defaults a missing dailyLimit to 0, not to unlimited', () => {
    const registry = parseMembers({
      members: [{ id: 'forgetful', tokenSha256: 'a'.repeat(64) }],
    });
    expect(registry.members[0]?.dailyLimit).toBe(0);
  });

  it('keeps an explicit 0 and an explicit limit apart from each other', () => {
    const registry = parseMembers({
      members: [
        { id: 'zero', tokenSha256: 'a'.repeat(64), dailyLimit: 0 },
        { id: 'fifty', tokenSha256: 'b'.repeat(64), dailyLimit: 50 },
      ],
    });
    expect(registry.members.map((member) => member.dailyLimit)).toEqual([0, 50]);
  });

  it('rejects a negative limit rather than treating it as unlimited', () => {
    expect(() => parseMembers({ members: [{ id: 'x', tokenSha256: 'a'.repeat(64), dailyLimit: -1 }] })).toThrow(
      /Invalid member registry/,
    );
  });
});

describe('a memory store with a limit of 0', () => {
  it('never grants a reservation', async () => {
    const store = createMemoryQuotaStore();
    const first = await store.reserve('forgetful', '2026-08-19', 0);
    const second = await store.reserve('forgetful', '2026-08-19', 0);
    expect(first).toEqual({ ok: false, used: 0, limit: 0 });
    expect(second).toEqual({ ok: false, used: 0, limit: 0 });
    expect(await store.used('forgetful', '2026-08-19')).toBe(0);
  });
});

describe('the proxy, for a member whose entry omits dailyLimit', () => {
  it('refuses every request with 429 and never calls the provider', async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({ members: MEMBERS, upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes(1024));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.post('/v1/chat/completions', chatRequest(dataUri), {
        token: NO_LIMIT_TOKEN,
      });
      expect(response.status).toBe(429);
      expect((response.body as { error: { code: string } }).error.code).toBe('rate_limit_exceeded');
      expect((response.body as { error: { message: string } }).error.message).toContain(
        '0 of 0 requests used',
      );
      // A 429 without `Retry-After` makes every client guess.
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }

    // The money never moved: the provider was not called once.
    expect(upstream.requests).toHaveLength(0);
  });

  it('still serves a member who HAS a limit, so this is a quota and not an outage', async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({ members: MEMBERS, upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes(1024));

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri), {
      token: WITH_LIMIT_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-quota-used')).toBe('1');
    expect(response.headers.get('x-quota-limit')).toBe('3');
    expect(upstream.requests).toHaveLength(1);
  });

  it('refuses the request AFTER the limited member has spent their allowance', async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({ members: MEMBERS, upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes(1024));
    const started = app;
    const send = (): Promise<{ status: number }> =>
      started.post('/v1/chat/completions', chatRequest(dataUri), { token: WITH_LIMIT_TOKEN });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    // Exactly three upstream calls for a limit of three — never a fourth.
    expect(upstream.requests).toHaveLength(3);
  });
});
