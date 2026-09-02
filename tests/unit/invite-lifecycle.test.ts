/**
 * Invites: one use, one failure sentence, and a real member at the end.
 *
 * THE CENTRAL ASSERTION IS THAT THE FOUR FAILURES ARE ONE FAILURE. Unknown
 * token, expired invite, already-redeemed invite and revoked invite are compared
 * against EACH OTHER — status, body and headers — rather than against a literal,
 * so a change that varies one of them is caught even if it changes all four
 * literals consistently. This endpoint is unauthenticated by definition: it is
 * the only way in, so it is the first thing anybody probing this gateway finds.
 * "Already redeemed" would confirm a token existed; "expired" would confirm it
 * existed and narrow when it was issued.
 *
 * THE REAL REASON IS ASSERTED TOO — in the LOG, where the operator can read it
 * and an attacker cannot. A self-hoster whose family member says "the link does
 * not work" has no other way to tell a lapsed invite from a used one.
 *
 * The last describe is what stops this file passing by rejecting everything: a
 * redemption produces a member token that actually authenticates.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminAuth,
  createRecordingMailer,
  makeAdminToken,
  startTestApp,
  type RecordingMailer,
  type TestApp,
  type TestResponse,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

const ADMIN_TOKEN = makeAdminToken();
const GATEWAY_PUBLIC_URL = 'https://gateway.example.test';
const CLIENT_BASE_URL = 'https://app.example.test';

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;
// Held here rather than read back off the app, whose `mailer` is the port type.
let mailer: RecordingMailer = createRecordingMailer();

beforeEach(async () => {
  upstream = await startFakeUpstream();
  mailer = createRecordingMailer();
  app = await startTestApp({
    mailer,
    upstreamBaseUrl: upstream.baseUrl,
    config: {
      adminToken: ADMIN_TOKEN,
      gatewayPublicUrl: GATEWAY_PUBLIC_URL,
      clientBaseUrl: CLIENT_BASE_URL,
      gatewayName: 'The Family Gateway',
    },
  });
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

interface CreatedInviteBody {
  id: string;
  expiresAt: string;
  link: string | null;
  token: string;
  emailed: boolean;
}

async function createInvite(
  started: TestApp,
  overrides: Record<string, unknown> = {},
): Promise<CreatedInviteBody> {
  const response = await started.post(
    '/admin/invites',
    { memberId: 'robin', dailyLimit: 25, ...overrides },
    adminAuth(ADMIN_TOKEN),
  );
  expect(response.status).toBe(201);
  return response.body as CreatedInviteBody;
}

function redeem(started: TestApp, inviteToken: string): Promise<TestResponse> {
  return started.post('/v1/invites/redeem', { inviteToken }, { token: null });
}

describe('creating an invite', () => {
  it('ALWAYS returns the link and the token, because copy-link is the primary flow', async () => {
    // Most self-hosters have no SMTP and never will. A flow that only worked
    // with a mail server would put the feature out of their reach entirely.
    const { app: started } = harness();

    const invite = await createInvite(started);

    expect(invite.token).toContain('gi_');
    expect(invite.link).toBe(
      `${CLIENT_BASE_URL}/join#gateway=${encodeURIComponent(GATEWAY_PUBLIC_URL)}&ginvite=${encodeURIComponent(invite.token)}`,
    );
    expect(invite.emailed).toBe(false);
  });

  it('does not email when no address was given', async () => {
    const { app: started } = harness();

    await createInvite(started);

    expect(mailer.sent).toHaveLength(0);
  });

  it('reports emailed:false when an address was given but no mail transport is configured', async () => {
    // Not an error: the invite exists and the operator has the link in front of
    // them, so failing the request would destroy a usable invite.
    const { app: started } = harness();

    const invite = await createInvite(started, { email: 'robin@example.test' });

    expect(invite.emailed).toBe(false);
    expect(invite.link).toBeTruthy();
  });

  it('refuses to invite someone to a member id that is already taken', async () => {
    // Caught here rather than at redemption: otherwise the invite burns on a
    // conflict the operator caused, and the person redeeming sees the failure.
    const { app: started } = harness();

    const response = await started.post(
      '/admin/invites',
      { memberId: 'alex', dailyLimit: 25 },
      adminAuth(ADMIN_TOKEN),
    );

    expect(response.status).toBe(409);
  });

  it('lists invites with a derived status and WITHOUT the token', async () => {
    const { app: started } = harness();
    const invite = await createInvite(started);

    const listed = await started.get('/admin/invites', adminAuth(ADMIN_TOKEN));

    const body = listed.body as { invites: { id: string; status: string }[] };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ id: invite.id, status: 'pending' });
    expect(listed.text).not.toContain(invite.token);
    expect(listed.text).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('every rejected redemption produces the same answer', () => {
  it('answers 400 with one identical body for unknown, expired, redeemed and revoked', async () => {
    const { app: started } = harness();

    // Unknown: a well-formed token nobody ever issued.
    const unknown = await redeem(started, 'gi_this_token_was_never_issued_anywhere');

    // Redeemed: created, used, then used again.
    const used = await createInvite(started, { memberId: 'used-one' });
    await redeem(started, used.token);
    const redeemedTwice = await redeem(started, used.token);

    // Revoked: created, then withdrawn by the operator.
    const withdrawn = await createInvite(started, { memberId: 'withdrawn' });
    await started.delete(`/admin/invites/${withdrawn.id}`, adminAuth(ADMIN_TOKEN));
    const revoked = await redeem(started, withdrawn.token);

    // Expired: created with a short TTL, then aged past it in the store.
    const lapsed = await createInvite(started, { memberId: 'lapsed', ttlHours: 1 });
    await expireInvite(started, lapsed.id);
    const expired = await redeem(started, lapsed.token);

    const cases: readonly { name: string; response: TestResponse }[] = [
      { name: 'unknown', response: unknown },
      { name: 'already redeemed', response: redeemedTwice },
      { name: 'revoked', response: revoked },
      { name: 'expired', response: expired },
    ];

    for (const testCase of cases) {
      expect(testCase.response.status, testCase.name).toBe(400);
      expect(testCase.response.text, testCase.name).toBe(unknown.text);
      expect(testCase.response.headers.get('retry-after'), testCase.name).toBeNull();
    }
  });

  it('refuses a sync invite indistinguishably from an unknown one, so the shape gate is no oracle', async () => {
    // `si_` is an openplate-sync SIGNUP invite. It must never be looked up
    // here: the two services have different operators and different revocation
    // surfaces, and a gateway that accepts the other one's token shape is a
    // gateway whose invite endpoint can be probed with it.
    //
    // The gate runs BEFORE the digest comparison, so this case never touches
    // the store — and the whole point of the assertion below is that a caller
    // cannot tell. The response must be the same status, the same body and the
    // same headers as a token nobody ever issued, and as an expired one.
    const { app: started } = harness();

    const unknown = await redeem(started, 'gi_this_token_was_never_issued_anywhere');
    const lapsed = await createInvite(started, { memberId: 'lapsed-beside-a-sync-token', ttlHours: 1 });
    await expireInvite(started, lapsed.id);
    const expired = await redeem(started, lapsed.token);

    const crossService = await redeem(started, 'si_a_sync_signup_invite_posted_to_the_gateway');

    expect(crossService.status).toBe(400);
    expect(crossService.text).toBe(unknown.text);
    expect(crossService.text).toBe(expired.text);
    expect(crossService.headers.get('retry-after')).toBeNull();
    // And it is not echoed anywhere, in the response or in the log.
    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(crossService.text).not.toContain('si_a_sync_signup_invite_posted_to_the_gateway');
    expect(logged).not.toContain('si_a_sync_signup_invite_posted_to_the_gateway');
  });

  it('answers the same way to a malformed body, so the field shape is not a hint either', async () => {
    const { app: started } = harness();

    const unknown = await redeem(started, 'gi_this_token_was_never_issued_anywhere');
    const malformed = await started.post('/v1/invites/redeem', { nope: 1 }, { token: null });

    expect(malformed.status).toBe(400);
    expect(malformed.text).toBe(unknown.text);
  });

  it('never echoes the presented invite token back', async () => {
    const { app: started } = harness();
    const guess = 'gi_secret_guess_value_not_a_real_invite';

    const response = await redeem(started, guess);

    expect(response.text).not.toContain(guess);
    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).not.toContain(guess);
  });

  it('logs the REAL reason server-side, where an operator can debug it', async () => {
    const { app: started } = harness();
    const used = await createInvite(started, { memberId: 'used-one' });
    await redeem(started, used.token);

    started.logLines.length = 0;
    await redeem(started, used.token);

    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).toContain('"reason":"redeemed"');
    expect(logged).toContain(`"inviteId":"${used.id}"`);
  });

  it('creates no member when a redemption is rejected', async () => {
    const { app: started } = harness();
    const before = (await started.members.all()).length;

    await redeem(started, 'gi_this_token_was_never_issued_anywhere');

    expect(await started.members.all()).toHaveLength(before);
  });
});

describe('a successful redemption', () => {
  it('returns a member token and the gateway description', async () => {
    const { app: started } = harness();
    const invite = await createInvite(started);

    const response = await redeem(started, invite.token);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      memberId: 'robin',
      gateway: { name: 'The Family Gateway', auditEnabled: false },
    });
    expect((response.body as { memberToken: string }).memberToken).toBeTruthy();
  });

  it('produces a member token that actually spends', async () => {
    // Without this the endpoint could return a random string and pass everything
    // else in this file.
    const { app: started, upstream: provider } = harness();
    const invite = await createInvite(started);
    const redeemed = await redeem(started, invite.token);
    const memberToken = (redeemed.body as { memberToken: string }).memberToken;

    const used = await started.post(
      '/v1/chat/completions',
      { model: 'some-vision-model', messages: [{ role: 'user', content: 'hi' }] },
      { token: memberToken },
    );

    expect(used.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
  });

  it('records the consent moment and the gateway mode on the new member', async () => {
    const { app: started } = harness();
    const invite = await createInvite(started);

    await redeem(started, invite.token);

    const created = (await started.members.all()).find((member) => member.id === 'robin');
    expect(created?.mode).toBe('family');
    expect(created?.consentAt).toBeTruthy();
  });

  it('carries the invite’s daily limit onto the member', async () => {
    const { app: started } = harness();
    const invite = await createInvite(started, { dailyLimit: 7 });

    await redeem(started, invite.token);

    const created = (await started.members.all()).find((member) => member.id === 'robin');
    expect(created?.dailyLimit).toBe(7);
  });

  it('marks the invite redeemed, so the admin list stops showing it as pending', async () => {
    const { app: started } = harness();
    const invite = await createInvite(started);

    await redeem(started, invite.token);

    const listed = await started.get('/admin/invites', adminAuth(ADMIN_TOKEN));
    const body = listed.body as { invites: { id: string; status: string }[] };
    expect(body.invites.find((entry) => entry.id === invite.id)?.status).toBe('redeemed');
  });

  it('creates exactly ONE member when the same invite is redeemed twice at once', async () => {
    // The lost-update defect. Two concurrent redemptions both read the invite as
    // unredeemed, both create a member, and one invite has bought two
    // allowances. The store's lock is what stops it.
    const { app: started } = harness();
    const invite = await createInvite(started);

    const [first, second] = await Promise.all([
      redeem(started, invite.token),
      redeem(started, invite.token),
    ]);

    const statuses = [first?.status, second?.status].toSorted();
    expect(statuses).toEqual([200, 400]);
    expect((await started.members.all()).filter((member) => member.id === 'robin')).toHaveLength(1);
  });
});

describe('/v1/gateway/info', () => {
  it('answers without any credential, because the client has none yet', async () => {
    const { app: started } = harness();

    const response = await started.get('/v1/gateway/info', { token: null });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'The Family Gateway',
      auditEnabled: false,
    });
    expect((response.body as { version: string }).version).toBeTruthy();
  });

  it('reports the advertised model, or null when the operator pinned none', async () => {
    const { app: started } = harness();

    const response = await started.get('/v1/gateway/info', { token: null });

    expect((response.body as { model: string | null }).model).toBeNull();
  });
});

/**
 * Ages an invite past its expiry by rewriting `expiresAt` in the store file.
 *
 * Rewriting the file rather than injecting a clock, because the clock would have
 * to move for the WHOLE app — including the rate limiter and the quota day key —
 * and a test that advances those to prove something about invites is testing
 * three things at once.
 */
async function expireInvite(started: TestApp, inviteId: string): Promise<void> {
  const raw = JSON.parse(await readFile(started.config.inviteStoreFile, 'utf8')) as {
    invites: { id: string; expiresAt: string }[];
  };
  for (const invite of raw.invites) {
    if (invite.id === inviteId) invite.expiresAt = new Date(Date.now() - 1000).toISOString();
  }
  await writeFile(started.config.inviteStoreFile, JSON.stringify(raw), 'utf8');
}
