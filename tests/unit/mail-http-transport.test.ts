/**
 * The Resend-compatible HTTP mail adapter, against a REAL local server.
 *
 * NOT A MOCKED `fetch`. Two of the three things this adapter can get wrong are
 * invisible to a stub. `to` must go out as a one-element ARRAY — Resend accepts
 * either shape and pigeon refuses a bare string, so a mock that records the
 * call and asserts we passed the recipient is satisfied by the version that
 * breaks in production. And the request has to actually reach a socket for the
 * `Authorization` header and the method to mean anything.
 *
 * THE LEAK TEST IS THE ONE THAT MATTERS. A mail API's error body echoes the
 * request it rejected — the recipient, the subject, and the html, which carries
 * the invite link, which carries the token. `await res.text()` appended to the
 * error message is a natural, helpful-looking change, and it would put an
 * invite credential into whatever the caller does with that error. So the fake
 * server here is SEEDED to echo: the happy path passing proves nothing, and a
 * `not.toContain` against a server that never sent the needle passes for free.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpMailConfig } from '../../src/config.js';
import { createHttpMailer, type OutgoingMail } from '../../src/mail/mailer.js';
import { startFakeMailApi, type FakeMailApi } from '../support/fake-mail-api.js';

const API_KEY = 'a-mail-api-key-that-must-never-leak';
const FROM = 'gateway@example.test';
const RECIPIENT = 'robin@example.test';
const SUBJECT = 'You have been invited to The Family Gateway';
const INVITE_TOKEN = 'gi_a_credential_that_must_never_leak';
const INVITE_LINK = `https://app.example.test/connect-gateway?gateway=https%3A%2F%2Fgateway.example.test&invite=${INVITE_TOKEN}`;

const MESSAGE: OutgoingMail = {
  to: RECIPIENT,
  subject: SUBJECT,
  text: `Open this link to connect:\n\n${INVITE_LINK}`,
  html: `<p><a href="${INVITE_LINK}">Open this link to connect</a></p>`,
};

let mailApi: FakeMailApi | null = null;

afterEach(async () => {
  await mailApi?.close();
  mailApi = null;
});

function configFor(api: FakeMailApi): HttpMailConfig {
  return { url: api.url, apiKey: API_KEY, from: FROM };
}

describe('the wire format', () => {
  it('POSTs the message as JSON with a bearer key, and `to` as an ARRAY', async () => {
    mailApi = await startFakeMailApi({ kind: 'ok' });
    const mailer = createHttpMailer(configFor(mailApi));

    await mailer.send(MESSAGE);

    expect(mailApi.requests).toHaveLength(1);
    const request = mailApi.requests[0];
    expect(request?.method).toBe('POST');
    // The operator's whole URL, used verbatim — this is what makes one adapter
    // reach both `/emails` and `/v1/emails` with no branch.
    expect(request?.path).toBe('/v1/emails');
    expect(request?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request?.contentType).toContain('application/json');

    const body = request?.body as {
      from: string;
      to: unknown;
      subject: string;
      text: string;
      html: string;
    };
    expect(body.from).toBe(FROM);
    // ARRAY, not a bare string. pigeon refuses the string; Resend takes both.
    expect(Array.isArray(body.to)).toBe(true);
    expect(body.to).toEqual([RECIPIENT]);
    expect(body.subject).toBe(SUBJECT);
    expect(body.text).toContain(INVITE_LINK);
    expect(body.html).toContain(INVITE_LINK);
  });

  it('resolves on a 2xx', async () => {
    mailApi = await startFakeMailApi({ kind: 'ok' });
    const mailer = createHttpMailer(configFor(mailApi));

    await expect(mailer.send(MESSAGE)).resolves.toBeUndefined();
  });
});

describe('a non-2xx whose body echoes the request', () => {
  it('REJECTS rather than resolving, so a failed send is never reported as a sent one', async () => {
    mailApi = await startFakeMailApi({ kind: 'echo', status: 500 });
    const mailer = createHttpMailer(configFor(mailApi));

    await expect(mailer.send(MESSAGE)).rejects.toThrow();
  });

  it('puts the STATUS CODE in the error, and nothing else from the response', async () => {
    // The server below sends back the recipient, the subject and the invite
    // link — the shape both Resend and pigeon really answer with. Everything
    // asserted absent here was genuinely present in the response body.
    mailApi = await startFakeMailApi({ kind: 'echo', status: 500 });
    const mailer = createHttpMailer(configFor(mailApi));

    const error = await mailer.send(MESSAGE).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('500');
    expect(message).not.toContain(RECIPIENT);
    expect(message).not.toContain(SUBJECT);
    expect(message).not.toContain(INVITE_LINK);
    expect(message).not.toContain(INVITE_TOKEN);
    expect(message).not.toContain(API_KEY);
    // Not the URL either: a hosted API's credential sometimes rides in one.
    expect(message).not.toContain(mailApi.url);
  });

  it('carries the status through, so 4xx and 5xx are distinguishable to an operator', async () => {
    mailApi = await startFakeMailApi({ kind: 'echo', status: 422 });
    const mailer = createHttpMailer(configFor(mailApi));

    await expect(mailer.send(MESSAGE)).rejects.toThrow(/422/);
  });
});

describe('a server that never answers', () => {
  it('rejects within the bound rather than hanging the invite request', async () => {
    // A send with no bound holds the admin request open behind it. The bound is
    // a parameter precisely so this test can assert it in 100 ms instead of 15 s.
    mailApi = await startFakeMailApi({ kind: 'silent' });
    const mailer = createHttpMailer(configFor(mailApi), { timeoutMs: 100 });

    const startedAt = Date.now();
    await expect(mailer.send(MESSAGE)).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3000);
    // It really did reach the server — otherwise this would pass against a
    // connection that was refused instantly for some unrelated reason.
    expect(mailApi.requests).toHaveLength(1);
  });

  it('does not name the recipient or the key when it times out', async () => {
    mailApi = await startFakeMailApi({ kind: 'silent' });
    const mailer = createHttpMailer(configFor(mailApi), { timeoutMs: 100 });

    const error = await mailer.send(MESSAGE).then(
      () => null,
      (caught: unknown) => caught,
    );

    const text = String(error);
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(INVITE_TOKEN);
  });
});
