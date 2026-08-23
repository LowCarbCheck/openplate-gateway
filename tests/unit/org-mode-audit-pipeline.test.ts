/**
 * Org mode's request path: what it stores, what it refuses, and what it does
 * when the bucket is down.
 *
 * THE INVERSE OF `org-mode-family-writes-nothing.test.ts`. That file proves a
 * family gateway writes nothing; this one proves an org gateway writes EXACTLY
 * the intended artefacts — one object per submitted image, under the documented
 * key, and one audit record with the documented fields. "Exactly" is the word
 * that matters: a test asserting only that the image arrived would pass on an
 * implementation that also wrote a second copy somewhere.
 *
 * THE AUDIT MUST NEVER GATE THE AI CALL. A clinic whose object store is
 * unreachable keeps answering; the trail gets a gap and a loud log line. That is
 * ADR-0003's stated trade, and the test at the bottom is what holds us to it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatRequest,
  makePhotoBytes,
  payloadNeedle,
  startTestApp,
  toDataUri,
  waitFor,
  allObservableText,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

let app: TestApp | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = undefined;
  upstream = undefined;
});

/** The org harness always has a bucket; this is the non-null assertion made once. */
function bucketOf(current: TestApp): NonNullable<TestApp['objects']> {
  const { objects } = current;
  if (objects === null) throw new Error('this test app has no bucket — it is not in org mode');
  return objects;
}

describe('an audited completion', () => {
  it('stores exactly one object and exactly one record, and nothing else', async () => {
    const photoBytes = makePhotoBytes();
    const photo = toDataUri(photoBytes);
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });
    const bucket = bucketOf(app);

    const response = await app.post('/v1/chat/completions', chatRequest(photo));
    expect(response.status).toBe(200);

    await waitFor(async () => (await app!.auditRecords()).length === 1, {
      what: 'the audit record to be written',
    });
    const records = await app.auditRecords();

    expect(records).toHaveLength(1);
    expect(bucket.objects).toHaveLength(1);

    const record = records[0];
    const object = bucket.objects[0];
    expect(record).toMatchObject({
      memberId: 'alex',
      model: 'some-vision-model',
      imageKeys: [object?.key],
    });
    expect(record?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(record?.ts ?? '')).toBeGreaterThan(0);
    // The completion text is captured for a non-streamed answer.
    expect(record?.responseText).toContain('rice, chicken');

    // The key is the documented shape, and the bytes are the photograph itself.
    expect(object?.key).toMatch(
      new RegExp(`^audit/alex/\\d{4}-\\d{2}-\\d{2}/${record?.requestId}-0\\.jpg$`),
    );
    expect(object?.contentType).toBe('image/jpeg');
    expect(object?.body.equals(photoBytes)).toBe(true);
  });

  it('names the audit row in a response header, so a member can ask about one request', async () => {
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });

    const response = await app.post('/v1/chat/completions', chatRequest(toDataUri(makePhotoBytes())));

    const requestId = response.headers.get('x-audit-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(async () => (await app!.auditRecords()).length === 1, { what: 'the audit record' });
    expect((await app.auditRecords())[0]?.requestId).toBe(requestId);
  });

  it('stores one object per image, in the order they appeared', async () => {
    const first = makePhotoBytes(2000);
    const second = makePhotoBytes(3000);
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });
    const bucket = bucketOf(app);

    await app.post('/v1/chat/completions', {
      model: 'some-vision-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: toDataUri(first) } },
            { type: 'image_url', image_url: { url: toDataUri(second, 'image/png') } },
          ],
        },
      ],
    });

    await waitFor(() => bucket.objects.length === 2, { what: 'both images to be stored' });
    expect(bucket.objects[0]?.key).toMatch(/-0\.jpg$/);
    expect(bucket.objects[1]?.key).toMatch(/-1\.png$/);
    expect(bucket.objects[1]?.body.equals(second)).toBe(true);
  });

  it('records responseText as null for a streamed answer rather than misquoting it', async () => {
    // Reassembling SSE frames into a completion means parsing a
    // provider-specific delta format; a subtly wrong reassembly writes a
    // misquotation into an audit trail. `null` says "not captured", which is
    // true. See `org-proxy.ts`.
    upstream = await startFakeUpstream({ kind: 'sse' });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });

    const response = await app.post(
      '/v1/chat/completions',
      chatRequest(toDataUri(makePhotoBytes()), { stream: true }),
    );

    // The stream still reaches the member intact — the tee never withholds it.
    expect(response.status).toBe(200);
    expect(response.text).toContain('rice');
    expect(response.text).toContain(', chicken');

    await waitFor(async () => (await app!.auditRecords()).length === 1, { what: 'the audit record' });
    const record = (await app.auditRecords())[0];
    expect(record?.responseText).toBeNull();
    // The image is still stored: the request happened and was billed.
    expect(record?.imageKeys).toHaveLength(1);
  });

  it('does NOT audit a request the provider refused', async () => {
    // A 4xx means the provider threw the request away; no completion exists to
    // record, and keeping the photographs of a request that produced nothing is
    // storage without a purpose.
    upstream = await startFakeUpstream({ kind: 'status', status: 400 });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });
    const bucket = bucketOf(app);

    const response = await app.post('/v1/chat/completions', chatRequest(toDataUri(makePhotoBytes())));

    expect(response.status).toBe(400);
    // Give an errant async write time to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bucket.objects).toHaveLength(0);
    expect(await app.auditRecords()).toEqual([]);
  });
});

describe('the hard body cap', () => {
  it('answers 413, forwards nothing and stores nothing', async () => {
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({
      org: true,
      upstreamBaseUrl: upstream.baseUrl,
      auditOverrides: { maxBodyBytes: 20_000 },
    });
    const bucket = bucketOf(app);

    // 30 kB of photo becomes ~40 kB of base64 — comfortably over the cap.
    const response = await app.post('/v1/chat/completions', chatRequest(toDataUri(makePhotoBytes())));

    expect(response.status).toBe(413);
    // NOT FORWARDED: the provider never saw it, so nobody was billed.
    expect(upstream.requests).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bucket.objects).toHaveLength(0);
    expect(await app.auditRecords()).toEqual([]);
  });

  it('accepts a body just under the cap', async () => {
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({
      org: true,
      upstreamBaseUrl: upstream.baseUrl,
      auditOverrides: { maxBodyBytes: 20_000 },
    });

    const response = await app.post(
      '/v1/chat/completions',
      chatRequest(toDataUri(makePhotoBytes(8000))),
    );

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });
});

describe('a failing audit never fails the AI call', () => {
  it('answers the member normally when the object store is down', async () => {
    const photo = toDataUri(makePhotoBytes());
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ org: true, upstreamBaseUrl: upstream.baseUrl });
    const bucket = bucketOf(app);
    bucket.failPuts();

    const response = await app.post('/v1/chat/completions', chatRequest(photo));

    expect(response.status).toBe(200);
    expect(response.text).toContain('rice, chicken');

    await waitFor(
      () => app!.logLines.some((line) => line.message.includes('Audit record could not be written')),
      { what: 'the audit failure to be logged' },
    );
    // Nothing was written, and the failure did not leak a body into the log.
    expect(await app.auditRecords()).toEqual([]);
    expect(allObservableText(app, response.text)).not.toContain(payloadNeedle(photo));
  });
});
