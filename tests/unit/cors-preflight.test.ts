/**
 * CORS runs FIRST, before auth — and the preflight is why.
 *
 * A browser sends `OPTIONS` with no `Authorization` header, by specification: it
 * is asking whether it may send one. Behind the auth middleware every preflight
 * would answer 401, the browser would report a CORS failure, and "point
 * openplate at your own gateway" would be false. The same ordering is what puts
 * the headers on a 401, so a client can read the status instead of seeing an
 * opaque network error.
 *
 * `Access-Control-Allow-Credentials` IS ASSERTED ABSENT on every path. Sending
 * it would signal an intent — cookie auth — this service must never develop:
 * the wide origin policy is only safe because the browser has no ambient
 * credential to attach on a hostile page's behalf.
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

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = null;
  upstream = null;
});

describe('the preflight', () => {
  it('is answered 204 without any credential', async () => {
    app = await startTestApp();

    const response = await app.options('/v1/chat/completions', {
      Origin: 'https://openplate.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
  });

  it('exposes the headers a client must obey', async () => {
    // Without this the backpressure contract is unreadable to exactly the client
    // that has to honour it.
    app = await startTestApp();

    const response = await app.options('/v1/chat/completions', { Origin: 'https://openplate.test' });

    const exposed = response.headers.get('access-control-expose-headers') ?? '';
    expect(exposed).toContain('Retry-After');
    expect(exposed).toContain('X-Quota-Used');
    expect(exposed).toContain('X-Quota-Limit');
  });

  it('never sends Access-Control-Allow-Credentials', async () => {
    app = await startTestApp();

    const preflight = await app.options('/v1/chat/completions', { Origin: 'https://openplate.test' });
    const rejected = await app.post('/v1/chat/completions', {}, { token: null });

    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(rejected.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('an exact-match allowlist', () => {
  it('echoes an allowed origin and always sends Vary: Origin', async () => {
    app = await startTestApp({
      config: { corsAllowedOrigins: ['https://openplate.test', 'http://localhost:5173'] },
    });

    const allowed = await app.options('/v1/chat/completions', { Origin: 'http://localhost:5173' });

    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    // Not optional: a cache in front of this service would otherwise serve one
    // origin's answer to the next one.
    expect(allowed.headers.get('vary')).toBe('Origin');
  });

  it('refuses a disallowed origin with a well-formed answer and no allow header', async () => {
    app = await startTestApp({ config: { corsAllowedOrigins: ['https://openplate.test'] } });

    const denied = await app.options('/v1/chat/completions', {
      Origin: 'https://openplate.test.attacker.test',
    });

    // The browser is what enforces the refusal, and it needs a well-formed
    // answer to read the absence from.
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.headers.get('vary')).toBe('Origin');
  });

  it('does not admit a suffix or prefix of an allowed origin', async () => {
    app = await startTestApp({ config: { corsAllowedOrigins: ['https://app.example.test'] } });
    const started = app;

    for (const origin of [
      'https://app.example.test.attacker.test',
      'https://evil.app.example.test',
      'http://app.example.test',
      'https://app.example.test/',
    ]) {
      const response = await started.options('/v1/chat/completions', { Origin: origin });
      expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });
});

describe('CORS headers on real answers', () => {
  it('are present on a 401, so the client can read the status', async () => {
    app = await startTestApp();

    const response = await app.post('/v1/chat/completions', {}, { token: null });

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('are present on a proxied 200', async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });

    const response = await app.post(
      '/v1/chat/completions',
      chatRequest(toDataUri(makePhotoBytes(1024))),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-quota-used')).toBe('1');
  });

  it('does not name the framework in a response header', async () => {
    app = await startTestApp();
    const response = await app.get('/healthcheck', { token: null });
    expect(response.headers.get('x-powered-by')).toBeNull();
    // No ETag either: a 304 on a completion would hand a member a cached answer
    // they still paid for.
    expect(response.headers.get('etag')).toBeNull();
  });
});
