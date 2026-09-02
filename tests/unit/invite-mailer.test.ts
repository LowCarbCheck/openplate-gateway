/**
 * What the invite endpoint does with a mailer — including when it fails.
 *
 * THE FAILURE PATH IS THE INTERESTING ONE. An SMTP hiccup must not fail the
 * request: the invite is already created and the operator already has the link
 * in the response body, so turning a transport problem into a 500 would destroy
 * a working invite and teach the operator to retry, creating a second one. The
 * response reports `emailed: false` and the link stays valid.
 *
 * The message CONTENT is asserted in `invite-email.test.ts` against the pure
 * builder. This file only asserts the wiring: whether a send is attempted, what
 * the response says, and that nothing sensitive reaches the log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminAuth,
  createRecordingMailer,
  makeAdminToken,
  startTestApp,
  type RecordingMailer,
  type TestApp,
} from '../support/app-harness.js';

const ADMIN_TOKEN = makeAdminToken();

const SMTP = {
  host: 'smtp.example.test',
  port: 587,
  user: 'gateway',
  pass: 'a-password-that-must-never-be-logged',
  from: 'gateway@example.test',
};

const LINK_CONFIG = {
  adminToken: ADMIN_TOKEN,
  gatewayPublicUrl: 'https://gateway.example.test',
  clientBaseUrl: 'https://app.example.test',
};

let app: TestApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function startWithMailer(mailer: RecordingMailer): Promise<TestApp> {
  app = await startTestApp({
    config: { ...LINK_CONFIG, mail: { transport: 'smtp', smtp: SMTP } },
    mailer,
  });
  return app;
}

function createInvite(started: TestApp, body: Record<string, unknown>) {
  return started.post(
    '/admin/invites',
    { memberId: 'robin', dailyLimit: 25, ...body },
    adminAuth(ADMIN_TOKEN),
  );
}

describe('with SMTP configured', () => {
  it('sends the invite and reports emailed:true', async () => {
    const mailer = createRecordingMailer();
    const started = await startWithMailer(mailer);

    const response = await createInvite(started, { email: 'robin@example.test' });

    expect(response.status).toBe(201);
    expect((response.body as { emailed: boolean }).emailed).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('robin@example.test');
  });

  it('STILL returns the link and token, so the operator is never dependent on the mail', async () => {
    const mailer = createRecordingMailer();
    const started = await startWithMailer(mailer);

    const response = await createInvite(started, { email: 'robin@example.test' });

    const body = response.body as { link: string; token: string };
    expect(body.link).toContain('/join#gateway=');
    expect(body.token).toContain('gi_');
  });

  it('sends nothing when no address was given', async () => {
    const mailer = createRecordingMailer();
    const started = await startWithMailer(mailer);

    await createInvite(started, {});

    expect(mailer.sent).toHaveLength(0);
  });

  it('succeeds with emailed:false when the send fails', async () => {
    const mailer = createRecordingMailer({ failing: true });
    const started = await startWithMailer(mailer);

    const response = await createInvite(started, { email: 'robin@example.test' });

    // 201, not 500. The invite exists and the link works.
    expect(response.status).toBe(201);
    const body = response.body as { emailed: boolean; link: string };
    expect(body.emailed).toBe(false);
    expect(body.link).toBeTruthy();
  });

  it('never logs the recipient, the link or the SMTP password', async () => {
    // The link carries the invite token, so it is a credential. The address is
    // personal data held for one send. An SMTP library's error message routinely
    // quotes the envelope it was rejected on, which is why the failure path
    // discards the error rather than logging it.
    const mailer = createRecordingMailer({ failing: true });
    const started = await startWithMailer(mailer);

    const response = await createInvite(started, { email: 'robin@example.test' });
    const token = (response.body as { token: string }).token;

    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).not.toContain('robin@example.test');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('/join#');
    expect(logged).not.toContain(SMTP.pass);
  });

  it('logs the invite id, which is the handle an operator can correlate on', async () => {
    const mailer = createRecordingMailer();
    const started = await startWithMailer(mailer);

    const response = await createInvite(started, { email: 'robin@example.test' });
    const id = (response.body as { id: string }).id;

    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).toContain(`"inviteId":"${id}"`);
  });
});

describe('without the link URLs configured', () => {
  it('still issues the invite, with a null link and a usable token', async () => {
    // A gateway with no public URL configured can still onboard somebody: the
    // raw token is enough to redeem by hand.
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });

    const response = await createInvite(app, {});

    expect(response.status).toBe(201);
    const body = response.body as { link: string | null; token: string };
    expect(body.link).toBeNull();
    expect(body.token).toContain('gi_');
  });
});
