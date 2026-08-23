/**
 * What a member is TOLD, and what they are stamped with.
 *
 * `auditEnabled` is the field a client shows a person on the screen where they
 * decide whether to join a gateway. It was hardcoded `false` while org mode did
 * not exist; now it is derived from the mode, in BOTH places it appears — the
 * public info endpoint and the redemption response, which is the answer to the
 * request that created the member and the thing `consentAt` records agreement to.
 *
 * A HARDCODED `false` ON AN ORG GATEWAY WOULD BE THE WORST BUG IN THIS SERVICE.
 * Not a crash, not a leak — a lie, told at the moment of consent, to somebody
 * deciding whether to send a photograph of themselves to a system that keeps it.
 *
 * The mode STAMP is the other half. A member who joined a family gateway is
 * refused by an org one with `reconsent_required` rather than silently inherited
 * — see `member-auth.ts` — and that only works if redemption stamps the mode the
 * gateway was actually running.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeAdminToken, adminAuth, startTestApp, type TestApp } from '../support/app-harness.js';

const ADMIN_TOKEN = makeAdminToken();

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const InfoSchema = z.looseObject({ auditEnabled: z.boolean() });
const RedeemSchema = z.looseObject({
  memberId: z.string(),
  gateway: z.looseObject({ auditEnabled: z.boolean() }),
});

/** Creates an invite through the real admin API and returns its token. */
async function mintInvite(current: TestApp, memberId: string): Promise<string> {
  const created = await current.post(
    '/admin/invites',
    { memberId, dailyLimit: 5 },
    adminAuth(ADMIN_TOKEN),
  );
  expect(created.status).toBe(201);
  return z.looseObject({ token: z.string() }).parse(created.body).token;
}

describe('/v1/gateway/info', () => {
  it('reports auditEnabled false on a family gateway', async () => {
    app = await startTestApp();

    const response = await app.get('/v1/gateway/info', { token: null });

    expect(InfoSchema.parse(response.body).auditEnabled).toBe(false);
  });

  it('reports auditEnabled TRUE on an org gateway', async () => {
    app = await startTestApp({ org: true });

    const response = await app.get('/v1/gateway/info', { token: null });

    expect(InfoSchema.parse(response.body).auditEnabled).toBe(true);
  });
});

describe('redeeming an invite', () => {
  it('tells the new member the gateway audits, and stamps them org', async () => {
    app = await startTestApp({ org: true, config: { adminToken: ADMIN_TOKEN } });
    const inviteToken = await mintInvite(app, 'kim');

    const redeemed = await app.post('/v1/invites/redeem', { inviteToken }, { token: null });

    expect(redeemed.status).toBe(200);
    const body = RedeemSchema.parse(redeemed.body);
    expect(body.gateway.auditEnabled).toBe(true);

    const stored = (await app.members.all()).find((member) => member.id === 'kim');
    expect(stored?.mode).toBe('org');
    // The moment they accepted THIS mode. It is what makes a later flip a
    // re-consent rather than a silent re-interpretation of an old agreement.
    expect(stored?.consentAt).toBeDefined();
  });

  it('stamps family on a family gateway, and says so', async () => {
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });
    const inviteToken = await mintInvite(app, 'kim');

    const redeemed = await app.post('/v1/invites/redeem', { inviteToken }, { token: null });

    expect(RedeemSchema.parse(redeemed.body).gateway.auditEnabled).toBe(false);
    expect((await app.members.all()).find((member) => member.id === 'kim')?.mode).toBe('family');
  });
});

describe('a member who joined under the other mode', () => {
  it('is refused with reconsent_required rather than silently inherited', async () => {
    // The flip an operator performs on purpose: family members do not become
    // org members, because they never agreed to be audited.
    app = await startTestApp({
      org: true,
      members: [{ id: 'alex', token: 'opg_test_token_alex', dailyLimit: 5, mode: 'family' }],
    });

    const response = await app.post('/v1/chat/completions', { model: 'm', messages: [] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'reconsent_required' });
  });
});
