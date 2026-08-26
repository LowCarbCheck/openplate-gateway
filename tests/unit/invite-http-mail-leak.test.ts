/**
 * The whole invite path with the REAL HTTP mail adapter behind it, pointed at a
 * mail API that fails and echoes the request back.
 *
 * WHY NOT `RecordingMailer`. The harness fixture cannot leak: it rejects with a
 * fixed string that never contained a recipient, so every `not.toContain` in
 * this file would pass against it for free and the test would prove nothing.
 * The leak this file exists to catch lives in a real transport reading a real
 * error body, so the real transport is what runs here — `createHttpMailer`,
 * over a socket, against a server seeded to echo the recipient, the subject and
 * the invite link back inside a 500.
 *
 * TWO THINGS ARE ASSERTED AND BOTH ARE LOAD-BEARING:
 *
 *  1. THE SEND IS ATTEMPTED. `emailed: false` on its own is also what a gateway
 *     that refuses to email over HTTP produces — the exact regression the
 *     transport-union refactor could reintroduce at the invite route's
 *     "can this gateway email" check. So the fake API must have RECEIVED the
 *     request. Without that assertion this file passes on a gateway that never
 *     tried.
 *  2. THE DEGRADATION HOLDS. 201, a link that still works, and `emailed: false`
 *     — the send failing must not destroy an invite the operator already has in
 *     front of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpMailer } from '../../src/mail/mailer.js';
import {
  adminAuth,
  makeAdminToken,
  startTestApp,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeMailApi, type FakeMailApi } from '../support/fake-mail-api.js';

const ADMIN_TOKEN = makeAdminToken();
const GATEWAY_PUBLIC_URL = 'https://gateway.example.test';
const CLIENT_BASE_URL = 'https://app.example.test';
const RECIPIENT = 'robin@example.test';
const MAIL_API_KEY = 'a-mail-api-key-that-must-never-leak';

let app: TestApp | null = null;
let mailApi: FakeMailApi | null = null;

afterEach(async () => {
  await app?.close();
  await mailApi?.close();
  app = null;
  mailApi = null;
});

interface CreatedInviteBody {
  id: string;
  link: string;
  token: string;
  emailed: boolean;
}

/** A gateway configured for the HTTP transport, wired with the REAL adapter. */
async function startWithFailingMailApi(): Promise<{ started: TestApp; api: FakeMailApi }> {
  const api = await startFakeMailApi({ kind: 'echo', status: 500 });
  mailApi = api;
  const http = { url: api.url, apiKey: MAIL_API_KEY, from: 'gateway@example.test' };
  const started = await startTestApp({
    config: {
      adminToken: ADMIN_TOKEN,
      gatewayPublicUrl: GATEWAY_PUBLIC_URL,
      clientBaseUrl: CLIENT_BASE_URL,
      gatewayName: 'The Family Gateway',
      mail: { transport: 'http', http },
    },
    // A short bound so a hung server cannot hang the suite.
    mailer: createHttpMailer(http, { timeoutMs: 2000 }),
  });
  app = started;
  return { started, api };
}

function createInvite(started: TestApp): Promise<CreatedInviteBody> {
  return started
    .post(
      '/admin/invites',
      { memberId: 'robin', dailyLimit: 25, email: RECIPIENT },
      adminAuth(ADMIN_TOKEN),
    )
    .then((response) => {
      expect(response.status).toBe(201);
      return response.body as CreatedInviteBody;
    });
}

describe('an HTTP-configured gateway whose mail API is failing', () => {
  it('ATTEMPTS the send — an http transport is a configured transport', async () => {
    const { started, api } = await startWithFailingMailApi();

    await createInvite(started);

    // The regression this kills: a "can this gateway email" check that only
    // recognises SMTP leaves an HTTP-configured gateway silently refusing.
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.authorization).toBe(`Bearer ${MAIL_API_KEY}`);
  });

  it('still answers 201 with a usable link and emailed:false', async () => {
    const { started } = await startWithFailingMailApi();

    const invite = await createInvite(started);

    expect(invite.emailed).toBe(false);
    expect(invite.link).toBe(
      `${CLIENT_BASE_URL}/connect-gateway?gateway=${encodeURIComponent(GATEWAY_PUBLIC_URL)}&invite=${encodeURIComponent(invite.token)}`,
    );
  });

  it('logs the invite id and NOTHING the mail API echoed back', async () => {
    const { started } = await startWithFailingMailApi();

    const invite = await createInvite(started);

    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    // The correlation handle an operator can act on, and the only one.
    expect(logged).toContain(`"inviteId":"${invite.id}"`);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain(invite.token);
    expect(logged).not.toContain(invite.link);
    expect(logged).not.toContain('/connect-gateway');
    expect(logged).not.toContain('invited');
    expect(logged).not.toContain(MAIL_API_KEY);
  });
});
