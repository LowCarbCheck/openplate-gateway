/**
 * Every rejected credential looks identical from outside.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE. The natural way to write an
 * auth middleware is to be helpful — "no Authorization header", "expected
 * Bearer", "unknown token" — and each of those sentences is a free oracle. A
 * distinct "malformed" tells an attacker the shape of a valid credential; a
 * distinct "unknown token" confirms that what they presented parsed as one, so
 * a guessing loop can tell "close" from "wrong". One sentence for all of them
 * gives back nothing.
 *
 * The six rejected cases below are compared against EACH OTHER — status, body
 * and headers — rather than against a literal, so a future change that varies
 * one of them is caught even if it changes all the literals consistently.
 *
 * The last test is what stops this file passing by rejecting everything: a valid
 * token is served.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRIMARY_MEMBER_TOKEN,
  chatRequest,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  type TestApp,
  type TestResponse,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';
import { parseBearerHeader } from '../../src/server/member-auth.js';

const UNKNOWN_TOKEN = 'opg_test_token_nobody_has_this';

/** Every way a caller can fail to present a usable credential. */
const REJECTED_CASES: readonly { name: string; authorization: string | null }[] = [
  { name: 'no Authorization header at all', authorization: null },
  { name: 'a Basic scheme', authorization: 'Basic dXNlcjpwYXNzd29yZA==' },
  { name: 'Bearer with nothing after it', authorization: 'Bearer' },
  { name: 'Bearer with only whitespace after it', authorization: 'Bearer    ' },
  { name: 'a bare token with no scheme', authorization: PRIMARY_MEMBER_TOKEN },
  { name: 'a well-formed but unknown token', authorization: `Bearer ${UNKNOWN_TOKEN}` },
];

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;
let dataUri = '';

beforeEach(async () => {
  upstream = await startFakeUpstream();
  app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
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

describe('parseBearerHeader', () => {
  it('returns null for absent, blank, bare and non-Bearer headers alike', () => {
    expect(parseBearerHeader(undefined)).toBeNull();
    expect(parseBearerHeader('')).toBeNull();
    expect(parseBearerHeader('Bearer')).toBeNull();
    expect(parseBearerHeader('Bearer    ')).toBeNull();
    expect(parseBearerHeader('Basic dXNlcjpwYXNz')).toBeNull();
    expect(parseBearerHeader(PRIMARY_MEMBER_TOKEN)).toBeNull();
  });

  it('accepts the token, case-insensitively on the scheme and tolerant of padding', () => {
    expect(parseBearerHeader('Bearer abc123')).toBe('abc123');
    expect(parseBearerHeader('bearer abc123')).toBe('abc123');
    expect(parseBearerHeader('  Bearer   abc123  ')).toBe('abc123');
  });
});

describe('every rejected credential produces the same answer', () => {
  it('answers 401 with one identical body for all of them', async () => {
    const { app: started, upstream: provider } = harness();

    const responses: TestResponse[] = [];
    for (const testCase of REJECTED_CASES) {
      responses.push(
        await started.post('/v1/chat/completions', chatRequest(dataUri), {
          authorization: testCase.authorization,
        }),
      );
    }

    const first = responses[0];
    expect(first).toBeDefined();
    for (const [index, response] of responses.entries()) {
      const label = REJECTED_CASES[index]?.name ?? String(index);
      expect(response.status, label).toBe(401);
      expect(response.text, label).toBe(first?.text);
      // A `Retry-After` on one of them would tell the caller which branch it hit.
      expect(response.headers.get('retry-after'), label).toBeNull();
    }

    // The envelope is still the OpenAI one a client can parse.
    const firstBody = first?.body as { error: { type: string; code: string } } | undefined;
    expect(firstBody?.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    });
    // Nothing was spent and nothing was forwarded.
    expect(provider.requests).toHaveLength(0);
  });

  it('says the same thing on an unknown path as on the real one', async () => {
    // A different status per route is the same oracle wearing a hat: it would
    // tell an unauthenticated caller which endpoints exist.
    const { app: started } = harness();

    const known = await started.post('/v1/chat/completions', chatRequest(dataUri), { token: null });
    const unknown = await started.post('/v1/does-not-exist', chatRequest(dataUri), { token: null });

    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
  });

  it('never echoes the presented token back, in the response or the logs', async () => {
    const { app: started } = harness();
    const guess = 'opg_secret_guess_value';

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: guess,
    });

    expect(response.status).toBe(401);
    expect(response.text).not.toContain(guess);
    const logged = started.logLines.map((line) => JSON.stringify(line)).join('\n');
    expect(logged).not.toContain(guess);
    // A fingerprint is not logged either: the request never resolved to a member.
    expect(logged).toContain('"tokenFingerprint":null');
  });

  it('is not fooled by a token that is a prefix of a valid one', async () => {
    const { app: started, upstream: provider } = harness();

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN.slice(0, -1),
    });

    expect(response.status).toBe(401);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('a valid token', () => {
  it('is accepted, so this file cannot pass by rejecting everything', async () => {
    const { app: started, upstream: provider } = harness();

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      token: PRIMARY_MEMBER_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
  });

  it('is accepted with a lowercase scheme, the way some clients send it', async () => {
    const { app: started } = harness();

    const response = await started.post('/v1/chat/completions', chatRequest(dataUri), {
      authorization: `bearer ${PRIMARY_MEMBER_TOKEN}`,
    });

    expect(response.status).toBe(200);
  });
});

describe('the healthcheck', () => {
  it('answers without a token, because an orchestrator has none to give', async () => {
    const { app: started } = harness();

    const response = await started.get('/healthcheck', { token: null });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
