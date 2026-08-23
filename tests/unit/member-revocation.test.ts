/**
 * A revoked member is indistinguishable from a stranger.
 *
 * WHY THIS IS ITS OWN FILE. `auth-indistinguishable.test.ts` proves that the
 * ways of failing to present a credential all look alike. Revocation adds a
 * seventh way, and it is the one most likely to be written differently: the
 * natural implementation filters revoked members out of the list before the
 * comparison, which is both shorter and faster — and which makes a revoked token
 * cheaper to reject than an unknown one. That is a timing oracle for "this
 * person used to be a member here", which is exactly the fact a former household
 * member's ex-partner would like to confirm.
 *
 * The response comparison below is against the UNKNOWN-token response rather
 * than against a literal, so a change that alters both consistently still fails.
 *
 * MODE MISMATCH IS THE DELIBERATE EXCEPTION. It answers 403 with a distinct,
 * machine-readable body, because it is the one rejection that has a next step
 * for the person holding the token. It is asserted here so that the exception
 * stays exactly one case wide.
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
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

const UNKNOWN_TOKEN = 'opg_test_token_nobody_has_this';

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;
let dataUri = '';

beforeEach(async () => {
  upstream = await startFakeUpstream();
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

describe('a revoked member', () => {
  beforeEach(async () => {
    app = await startTestApp({
      upstreamBaseUrl: upstream?.baseUrl ?? '',
      members: [
        { id: 'alex', token: PRIMARY_MEMBER_TOKEN, dailyLimit: 50, revoked: true },
        { id: 'sam', token: SECOND_MEMBER_TOKEN, dailyLimit: 50 },
      ],
    });
  });

  it('is rejected with the SAME answer as a token nobody ever had', async () => {
    const { app: started } = harness();

    const revoked = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });
    const unknown = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: UNKNOWN_TOKEN,
    });

    expect(revoked.status).toBe(401);
    expect(revoked.status).toBe(unknown.status);
    expect(revoked.text).toBe(unknown.text);
    expect(revoked.headers.get('retry-after')).toBeNull();
  });

  it('spends nothing upstream', async () => {
    const { app: started, upstream: provider } = harness();

    await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });

    expect(provider.requests).toHaveLength(0);
  });

  it('does not stop the members who were not revoked', async () => {
    // Without this, the file passes by rejecting everybody.
    const { app: started } = harness();

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: SECOND_MEMBER_TOKEN,
    });

    expect(response.status).toBe(200);
  });
});

describe('revocation takes effect without a restart', () => {
  it('stops the very next request after the store is written', async () => {
    // The whole reason the store replaced a boot-time snapshot. A cached
    // registry would keep serving this member until someone restarted the
    // container — which is the one moment an operator least wants to.
    app = await startTestApp({ upstreamBaseUrl: upstream?.baseUrl ?? '' });
    const { app: started } = harness();

    const before = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });
    await started.members.revoke('alex');
    const after = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
  });
});

describe('a member stamped with another mode', () => {
  it('is refused with a machine-readable reconsent marker', async () => {
    // A gateway flipped from family to org must not inherit members who agreed
    // to the previous data policy. This is the ONE rejection that is deliberately
    // distinguishable: the holder needs to know their token is real but stale.
    app = await startTestApp({
      upstreamBaseUrl: upstream?.baseUrl ?? '',
      members: [{ id: 'alex', token: PRIMARY_MEMBER_TOKEN, dailyLimit: 50, mode: 'org' }],
    });
    const { app: started, upstream: provider } = harness();

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'reconsent_required' });
    // Refused before anything was forwarded or spent.
    expect(provider.requests).toHaveLength(0);
  });
});
