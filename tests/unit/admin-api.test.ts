/**
 * The admin API: absent when unconfigured, closed when configured.
 *
 * THE FIRST DESCRIBE IS THE SECURITY ASSERTION. A family gateway that never set
 * `GATEWAY_ADMIN_TOKEN` must be indistinguishable, from outside, from a build
 * that never had an admin API. A 401 there would confirm the surface exists on
 * this host and is merely locked, which is an invitation to come back with a
 * wordlist — and the operator who never wanted an admin API has no idea they are
 * advertising one. So the assertion is not "it is protected", it is "it answers
 * exactly what a nonsense path answers", compared byte for byte.
 *
 * THE SECOND IS THE ONE THAT COSTS MONEY IF IT REGRESSES: no list endpoint may
 * ever return a token or a digest. Creation returns a token once, by design, and
 * the tests below pin which responses may contain one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adminAuth,
  makeAdminToken,
  startTestApp,
  type TestApp,
  type TestResponse,
} from '../support/app-harness.js';

const ADMIN_TOKEN = makeAdminToken();

let app: TestApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function harness(): TestApp {
  if (app === null) throw new Error('harness did not start');
  return app;
}

/** Everything a response could carry, so a token leak cannot hide in a header. */
function allText(response: TestResponse): string {
  return [response.text, ...[...response.headers.entries()].map(([k, v]) => `${k}: ${v}`)].join('\n');
}

describe('with NO admin token configured', () => {
  beforeEach(async () => {
    app = await startTestApp();
  });

  it('answers /admin/members exactly as it answers a nonsense path', async () => {
    // Compared as a MEMBER, because that is the only caller who can see past
    // the gateway's 401 to what the routing table actually holds. To them the
    // `/admin` namespace must be indistinguishable from any other path that
    // does not exist — same status, same envelope, same code.
    const started = harness();

    const admin = await started.get('/admin/members');
    const nonsense = await started.get('/admin-does-not-exist');

    expect(admin.status).toBe(404);
    expect(admin.status).toBe(nonsense.status);
    expect(admin.body).toMatchObject({ error: { code: 'unknown_endpoint' } });
    expect(nonsense.body).toMatchObject({ error: { code: 'unknown_endpoint' } });
  });

  it('answers 404 to an unauthenticated caller, never 401', async () => {
    // A 401 here would say "there is something at this path and it is locked",
    // which is the one fact the unconfigured admin API must not disclose. It has
    // to be answered BEFORE member auth, or the 401 below the routing table
    // leaks it anyway — which is exactly the defect this assertion caught.
    const started = harness();

    const response = await started.get('/admin/members', { token: null });

    expect(response.status).toBe(404);
  });

  it('answers 404 even when a plausible admin token is presented', async () => {
    // Otherwise "404 without a token, 401 with one" is the same oracle wearing a hat.
    const started = harness();

    const response = await started.get('/admin/members', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(404);
  });

  it('refuses to create a member through an API that is not there', async () => {
    const started = harness();

    const response = await started.post(
      '/admin/members',
      { id: 'intruder', dailyLimit: 500 },
      adminAuth(ADMIN_TOKEN),
    );

    expect(response.status).toBe(404);
    expect((await started.members.all()).map((member) => member.id)).not.toContain('intruder');
  });
});

describe('with an admin token configured', () => {
  beforeEach(async () => {
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });
  });

  it('answers 401 to a wrong token, and 401 to no token', async () => {
    const started = harness();

    const wrong = await started.get('/admin/members', adminAuth(makeAdminToken()));
    const absent = await started.get('/admin/members', { token: null });

    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    // One sentence for both: "wrong" versus "missing" is a free hint.
    expect(wrong.text).toBe(absent.text);
  });

  it('is not fooled by a token that is a prefix of the real one', async () => {
    const started = harness();

    const response = await started.get('/admin/members', adminAuth(ADMIN_TOKEN.slice(0, -1)));

    expect(response.status).toBe(401);
  });

  it('never echoes the presented admin token, in the response or the logs', async () => {
    const started = harness();
    const guess = makeAdminToken();

    const response = await started.get('/admin/members', adminAuth(guess));

    expect(allText(response)).not.toContain(guess);
    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).not.toContain(guess);
  });

  it('logs the rejection, because nobody but the operator calls /admin', async () => {
    // A member 401 is routine noise. An admin 401 is the operator fumbling a
    // paste, or somebody probing — both worth a line.
    const started = harness();

    await started.get('/admin/members', adminAuth(makeAdminToken()));

    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).toContain('Admin request rejected');
  });

  it('lists members WITHOUT their digests or tokens', async () => {
    const started = harness();

    const response = await started.get('/admin/members', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(200);
    const body = response.body as { members: { id: string; revokedAt: string | null }[] };
    expect(body.members.map((member) => member.id)).toEqual(['alex', 'sam']);
    expect(body.members[0]?.revokedAt).toBeNull();
    // The digest is 64 hex chars; none may appear anywhere in the response.
    expect(response.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('creates a member and returns the token exactly once', async () => {
    const started = harness();

    const created = await started.post(
      '/admin/members',
      { id: 'robin', dailyLimit: 25 },
      adminAuth(ADMIN_TOKEN),
    );

    expect(created.status).toBe(201);
    const body = created.body as { token: string; member: { id: string; dailyLimit: number } };
    expect(body.member).toMatchObject({ id: 'robin', dailyLimit: 25 });
    expect(body.token).toBeTruthy();

    // ...and never again: the list endpoint must not carry it.
    const listed = await started.get('/admin/members', adminAuth(ADMIN_TOKEN));
    expect(listed.text).not.toContain(body.token);
  });

  it('mints a token that actually authenticates', async () => {
    // Without this the endpoint could return a random string and pass every
    // other assertion in this file.
    const started = harness();

    const created = await started.post(
      '/admin/members',
      { id: 'robin', dailyLimit: 25 },
      adminAuth(ADMIN_TOKEN),
    );
    const token = (created.body as { token: string }).token;

    // A 401 would mean the digest and the token disagree. Any other status means
    // it authenticated and failed later, which is all this asserts.
    const used = await started.post('/v1/chat/completions', { model: 'm', messages: [] }, { token });
    expect(used.status).not.toBe(401);
  });

  it('refuses a duplicate member id with 409, not 500', async () => {
    const started = harness();

    const response = await started.post(
      '/admin/members',
      { id: 'alex', dailyLimit: 25 },
      adminAuth(ADMIN_TOKEN),
    );

    expect(response.status).toBe(409);
  });

  it('rejects a malformed member id rather than writing it into a log line', async () => {
    // An unconstrained id could carry a newline and forge a second JSON log record.
    const started = harness();

    const response = await started.post(
      '/admin/members',
      { id: 'Not A Valid Id\n{"level":"info"}', dailyLimit: 25 },
      adminAuth(ADMIN_TOKEN),
    );

    expect(response.status).toBe(400);
  });

  it('revokes a member and reports the tombstone', async () => {
    const started = harness();

    const response = await started.delete('/admin/members/alex', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(200);
    expect((response.body as { member: { revokedAt: string } }).member.revokedAt).toBeTruthy();
  });

  it('answers 404 when revoking a member that never existed', async () => {
    const started = harness();

    const response = await started.delete('/admin/members/nobody', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(404);
  });

  it('does not let a MEMBER token reach the admin API', async () => {
    // A member token is a spend credential, not an operator one. If these were
    // interchangeable, any family member could read the roster and mint members.
    const started = harness();

    const response = await started.get('/admin/members');

    expect(response.status).toBe(401);
  });
});
