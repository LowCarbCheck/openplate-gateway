/**
 * The privacy promise, tested where it actually breaks: the ERROR paths.
 *
 * "No request or response body ever reaches a log line or an error message" is
 * the product, not a nicety — and the happy path passing proves nothing about
 * it. Our own call sites are disciplined; `logger.ts`'s field type will not even
 * accept a Buffer. The realistic leak is somebody ELSE's string: the upstream
 * provider echoing the request it rejected, `body-parser` quoting the fragment
 * it choked on, a dependency putting its input into an `Error.message` that one
 * `${error}` then logs.
 *
 * So each test below drives a real request carrying a real base64 payload
 * through the REAL app, forces a failure at a different point, and asserts the
 * payload appears in NEITHER the HTTP response body NOR any captured log line.
 *
 * THE LAST TWO TESTS ARE WHAT MAKE THIS FILE ABLE TO FAIL. One injects an error
 * whose message deliberately contains the whole data URI; the other asserts
 * that the unscrubbed string DOES contain the needle and that `scrubPayloads`
 * is what removes it. Together they mean a future refactor that deletes a scrub
 * call is caught here rather than passing silently — a `not.toContain`
 * assertion on its own also passes against an empty string.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  allObservableText,
  chatRequest,
  makePhotoBytes,
  payloadNeedle,
  startTestApp,
  toDataUri,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';
import type { QuotaStore, ReserveResult } from '../../src/quota/types.js';
import { scrubPayloads } from '../../src/scrub.js';

const DATA_URI_PREFIX = 'data:image/jpeg;base64,';

let app: TestApp | null = null;
let upstream: FakeUpstream | null = null;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = null;
  upstream = null;
});

/**
 * A store that throws an error carrying the payload — the stand-in for "a
 * dependency quoted its input". Our own code never does this, which is exactly
 * why it has to be tested rather than assumed.
 */
function leakyQuotaStore(leakedText: string): QuotaStore {
  return {
    reserve(): Promise<ReserveResult> {
      return Promise.reject(new Error(`quota backend rejected the request ${leakedText}`));
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
    used(): Promise<number> {
      return Promise.resolve(0);
    },
  };
}

describe('the request body never reaches a log line or a response', () => {
  it('scrubs the payload out of an upstream error that echoes the request back', async () => {
    // The realistic case: the provider refuses the request and quotes the whole
    // thing — plate photograph included — inside its error body.
    upstream = await startFakeUpstream({ kind: 'echo', status: 400 });
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes());
    const needle = payloadNeedle(dataUri);

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));

    // The upstream's status passes through — a client has to tell "your request
    // was wrong" from "the provider is down".
    expect(response.status).toBe(400);

    const observable = allObservableText(app, response.text);
    expect(observable).not.toContain(needle);
    expect(observable).not.toContain(DATA_URI_PREFIX);

    // The failure was reported, not swallowed: the echoed body is present as a
    // redaction marker rather than as bytes.
    expect(response.text).toContain('[redacted]');
    const warned = app.logLines.find((line) => line.message === 'Upstream provider returned an error');
    expect(String(warned?.fields.upstreamError)).toContain('[redacted]');
  });

  it('scrubs the payload out of a 5xx upstream error that echoes the request back', async () => {
    // Same echo, different money answer (a 5xx stays spent). The scrub must not
    // depend on which branch of the release table we took.
    upstream = await startFakeUpstream({ kind: 'echo', status: 503 });
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes());

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));

    expect(response.status).toBe(503);
    const observable = allObservableText(app, response.text);
    expect(observable).not.toContain(payloadNeedle(dataUri));
    expect(observable).not.toContain(DATA_URI_PREFIX);
  });

  it('discards the payload when the body is not valid JSON', async () => {
    // `body-parser`'s own error carries the fragment it choked on, which for
    // this service is a slice of a plate photograph. The handler discards it and
    // sends a fixed sentence.
    upstream = await startFakeUpstream();
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes());
    const truncated = `${JSON.stringify(chatRequest(dataUri)).slice(0, 20_000)}`;

    const response = await app.postRaw('/v1/chat/completions', truncated);

    expect(response.status).toBe(400);
    expect((response.body as { error: { message: string } }).error.message).toBe(
      'Request body is not valid JSON.',
    );
    const observable = allObservableText(app, response.text);
    expect(observable).not.toContain(payloadNeedle(dataUri));
    expect(observable).not.toContain(DATA_URI_PREFIX);
    // Nothing was forwarded: the parser refused before auth even ran.
    expect(upstream.requests).toHaveLength(0);
  });

  it('does not echo the payload when the body is refused for size', async () => {
    upstream = await startFakeUpstream();
    app = await startTestApp({
      upstreamBaseUrl: upstream.baseUrl,
      config: { maxRequestBytes: 2048 },
    });
    const dataUri = toDataUri(makePhotoBytes());

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));

    expect(response.status).toBe(413);
    const observable = allObservableText(app, response.text);
    expect(observable).not.toContain(payloadNeedle(dataUri));
    expect(observable).not.toContain(DATA_URI_PREFIX);
    expect(upstream.requests).toHaveLength(0);
  });

  it('scrubs an UNEXPECTED error whose message carries the payload', async () => {
    // The adversarial case, and the reason `scrub.ts` exists. If the
    // `describeError` call in the error middleware is deleted, THIS is the test
    // that turns red.
    upstream = await startFakeUpstream();
    const dataUri = toDataUri(makePhotoBytes());
    app = await startTestApp({
      upstreamBaseUrl: upstream.baseUrl,
      quota: leakyQuotaStore(dataUri),
    });

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));

    expect(response.status).toBe(500);
    // The response says nothing about the failure at all.
    expect((response.body as { error: { message: string } }).error.message).toBe(
      'Internal server error.',
    );

    const observable = allObservableText(app, response.text);
    expect(observable).not.toContain(payloadNeedle(dataUri));
    expect(observable).not.toContain(DATA_URI_PREFIX);

    // Reported, not swallowed — the log line still names the failure, redacted.
    const errorLine = app.logLines.find((line) => line.level === 'error');
    expect(errorLine?.message).toBe('Unhandled request error');
    expect(String(errorLine?.fields.error)).toContain('quota backend rejected the request');
    expect(String(errorLine?.fields.error)).toContain('[redacted]');
  });

  it('proves the needle is findable and that the scrubber is what removes it', async () => {
    // The sibling assertion that stops every `not.toContain` above from being
    // vacuous. If `payloadNeedle` ever returned '' — or the payload stopped
    // looking like base64 — the assertions would pass against anything. Here the
    // raw string DOES contain the needle, and only the scrubber takes it out.
    const dataUri = toDataUri(makePhotoBytes());
    const needle = payloadNeedle(dataUri);
    expect(needle).toHaveLength(64);

    const leaked = `quota backend rejected the request ${dataUri}`;
    expect(leaked).toContain(needle);

    const scrubbed = scrubPayloads(leaked);
    expect(scrubbed).not.toContain(needle);
    expect(scrubbed).not.toContain(DATA_URI_PREFIX);
    expect(scrubbed).toBe('quota backend rejected the request [redacted]');
    // Idempotent: scrubbing an already-scrubbed string is a no-op.
    expect(scrubPayloads(scrubbed)).toBe(scrubbed);
  });

  it('leaves short identifiers alone, so a scrubbed log line is still useful', async () => {
    // The other half of "able to fail": a scrubber that redacted everything
    // would pass every assertion above and make the logs worthless.
    const message = 'member alex token a1b2c3d4 request 5f1c9a20-1b7e-4c31-9f0a-2d3e4f5a6b7c failed';
    expect(scrubPayloads(message)).toBe(message);
  });

  it('scrubs a payload a client put into the URL, on the 404 path', async () => {
    // `handleNotFound` echoes the path back so a caller can see what they asked
    // for, which makes it the one response in the service built out of a
    // client-controlled string. A client that has just put an image into a URL
    // is exactly the mistake that sentence would otherwise repeat.
    upstream = await startFakeUpstream();
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    // `+`, `/` and `=` would split the path into segments or be re-encoded, so
    // the run is flattened to the alphanumeric part — still far above the
    // 48-char threshold `scrub.ts` looks for.
    const inUrl = makePhotoBytes(256).toString('base64').replaceAll(/[+/=]/g, 'A');

    const response = await app.get(`/v1/${inUrl}`);

    expect(response.status).toBe(404);
    expect(allObservableText(app, response.text)).not.toContain(inUrl.slice(0, 64));
    expect(response.text).toContain('[redacted]');
  });

  it('never lets the payer key or the member token reach a log line or a response', async () => {
    upstream = await startFakeUpstream({ kind: 'echo', status: 400 });
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes());

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));
    const observable = allObservableText(app, response.text);

    expect(observable).not.toContain(app.config.upstreamApiKey);
    expect(observable).not.toContain('opg_test_token_alex');
    // The provider got the payer's key and never the member's token.
    expect(upstream.requests[0]?.authorization).toBe(`Bearer ${app.config.upstreamApiKey}`);
  });

  it('logs byte counts for a successful proxy, and no bytes', async () => {
    // The happy path proves the positive half of the contract: the log line that
    // DOES get written carries counts, ids and a status — never the payload.
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });
    const dataUri = toDataUri(makePhotoBytes());

    const response = await app.post('/v1/chat/completions', chatRequest(dataUri));
    expect(response.status).toBe(200);

    const proxied = app.logLines.find((line) => line.message === 'Proxied a completion');
    expect(proxied).toBeDefined();
    expect(proxied?.fields.memberId).toBe('alex');
    expect(typeof proxied?.fields.requestBytes).toBe('number');
    expect(Number(proxied?.fields.requestBytes)).toBeGreaterThan(dataUri.length);
    expect(allObservableText(app, response.text)).not.toContain(payloadNeedle(dataUri));
  });
});
