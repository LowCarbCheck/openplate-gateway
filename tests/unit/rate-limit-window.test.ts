/**
 * The per-member burst limiter, driven through the real app with an injected
 * clock so nothing sleeps.
 *
 * WHY IT EXISTS ALONGSIDE THE DAILY QUOTA. The quota decides how much a member
 * may spend in a UTC day; it says nothing about WHEN. Without a burst guard, a
 * retry loop in a client spends the whole day's allowance in ten seconds and the
 * first symptom is a member who is inexplicably out of requests at 09:00. This
 * limiter turns that into a visible 429 while the allowance is still there.
 *
 * SLIDING, NOT FIXED. A fixed window lets a caller spend a full minute's budget
 * in the last second of one window and the next budget in the first second of
 * the next — twice the intended burst, at the exact moment the guard was
 * supposed to be watching. The seam test below is what tells the two apart: a
 * fixed-window implementation passes every other case in this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRIMARY_MEMBER_TOKEN,
  SECOND_MEMBER_TOKEN,
  chatRequest,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  type TestApp,
  type TestResponse,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

const MINUTE_MS = 60_000;

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;
let currentInstant = new Date('2026-08-19T12:00:00.000Z');
let dataUri = '';

beforeEach(async () => {
  currentInstant = new Date('2026-08-19T12:00:00.000Z');
  upstream = await startFakeUpstream();
  app = await startTestApp({
    upstreamBaseUrl: upstream.baseUrl,
    config: { rateLimitPerMinute: 3 },
    now: () => currentInstant,
  });
  dataUri = toDataUri(makePhotoBytes(1024));
});

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = null;
  upstream = null;
});

function harness(): { app: TestApp; upstream: FakeUpstream } {
  if (app === null || upstream === null) throw new Error('harness did not start');
  return { app, upstream };
}

function advance(milliseconds: number): void {
  currentInstant = new Date(currentInstant.getTime() + milliseconds);
}

function send(token = PRIMARY_MEMBER_TOKEN): Promise<TestResponse> {
  return harness().app.post('/v1/chat/completions', chatRequest(dataUri), { token });
}

describe('the per-minute burst limit', () => {
  it('serves the limit and refuses the next one with a usable Retry-After', async () => {
    const { upstream: provider } = harness();

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const refused = await send();
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { code: string } }).error.code).toBe('rate_limit_exceeded');
    // Never 0: a `Retry-After: 0` invites an immediate retry guaranteed to fail.
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // The refusal happened before the provider was reached — and before the
    // daily allowance was touched.
    expect(provider.requests).toHaveLength(3);
    expect(await harness().app.quota.used('alex', '2026-08-19')).toBe(3);
  });

  it('lets the caller through again once the oldest request ages out', async () => {
    for (let index = 0; index < 3; index += 1) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    advance(MINUTE_MS + 1);

    expect((await send()).status).toBe(200);
  });

  it('slides rather than resetting: the seam a fixed window would open', async () => {
    // Three requests, one second apart: t=0, t=1s, t=2s. Spacing them is what
    // makes the seam visible — three requests at the same instant would all age
    // out together and a fixed window would look identical.
    expect((await send()).status).toBe(200);
    advance(1_000);
    expect((await send()).status).toBe(200);
    advance(1_000);
    expect((await send()).status).toBe(200);

    // t=59s. A fixed window would be about to reset and hand out a second full
    // budget one second later; a sliding window still counts all three.
    advance(57_000);
    expect((await send()).status).toBe(429);

    // t=60.001s — only the FIRST request has aged out, so exactly one slot frees.
    advance(1_001);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  it('is keyed per member, so one member cannot exhaust another', async () => {
    for (let index = 0; index < 3; index += 1) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    // A household behind one NAT shares an IP; keying on that would put them in
    // one bucket, which is the opposite of the fairness wanted here.
    expect((await send(SECOND_MEMBER_TOKEN)).status).toBe(200);
  });

  it('does not count requests it refused, so a hammering client is not locked out forever', async () => {
    const { upstream: provider } = harness();
    for (let index = 0; index < 3; index += 1) expect((await send()).status).toBe(200);
    for (let index = 0; index < 10; index += 1) expect((await send()).status).toBe(429);

    advance(MINUTE_MS + 1);

    expect((await send()).status).toBe(200);
    expect(provider.requests).toHaveLength(4);
  });

  it('never counts an unauthenticated request against a member', async () => {
    const { app: started } = harness();
    for (let index = 0; index < 10; index += 1) {
      const anonymous = await started.post('/v1/chat/completions', chatRequest(dataUri), {
        token: null,
      });
      expect(anonymous.status).toBe(401);
    }

    // The member's whole budget is still there.
    expect((await send()).status).toBe(200);
  });
});
