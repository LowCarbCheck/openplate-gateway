/**
 * The admin audit endpoints: read, export, erase — and, in family mode, absent.
 *
 * THE FAMILY-MODE ASSERTION IS THE SECURITY ONE, and it is the same shape as the
 * "no admin token" case in `admin-api.test.ts`: `/admin/audit` must answer
 * exactly what a nonsense path answers. Not 403, not an empty list. A 403 would
 * confirm that an audit trail exists on this host, and on a family gateway there
 * is nothing to confirm.
 *
 * THE ERASURE ENDPOINT IS THE POINT OF THE FEATURE. An organisation storing
 * images of the people it serves owes them removal on request, and "removal"
 * means the record AND the stored object — a deleted row pointing at a live
 * photograph is not an erasure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  adminAuth,
  chatRequest,
  makeAdminToken,
  makePhotoBytes,
  startTestApp,
  toDataUri,
  waitFor,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

const ADMIN_TOKEN = makeAdminToken();

let app: TestApp | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = undefined;
  upstream = undefined;
});

const PageSchema = z.object({
  records: z.array(z.looseObject({ memberId: z.string(), requestId: z.string() })),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

/** Boots an org gateway and audits `count` completions for the named members. */
async function startWithAudited(members: readonly string[]): Promise<TestApp> {
  upstream = await startFakeUpstream({ kind: 'ok' });
  const started = await startTestApp({
    org: true,
    upstreamBaseUrl: upstream.baseUrl,
    config: { adminToken: ADMIN_TOKEN },
  });

  for (const member of members) {
    const token = member === 'alex' ? undefined : 'opg_test_token_sam';
    await started.post(
      '/v1/chat/completions',
      chatRequest(toDataUri(makePhotoBytes(1000))),
      token === undefined ? {} : { token },
    );
  }
  await waitFor(async () => (await started.auditRecords()).length === members.length, {
    what: 'every audit record to be written',
  });
  return started;
}

describe('in family mode', () => {
  it('answers /admin/audit exactly as it answers a nonsense path', async () => {
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });

    const audit = await app.get('/admin/audit', adminAuth(ADMIN_TOKEN));
    const nonsense = await app.get('/admin/does-not-exist', adminAuth(ADMIN_TOKEN));

    expect(audit.status).toBe(404);
    expect(audit.status).toBe(nonsense.status);
    // Same envelope and same code. The messages differ only by the path they
    // quote, which is what every unknown-endpoint answer does.
    expect(z.looseObject({ error: z.looseObject({ code: z.string(), type: z.string() }) }).parse(audit.body).error)
      .toMatchObject({ code: 'unknown_endpoint', type: 'invalid_request_error' });
    expect(z.looseObject({ error: z.looseObject({ code: z.string(), type: z.string() }) }).parse(nonsense.body).error)
      .toMatchObject({ code: 'unknown_endpoint', type: 'invalid_request_error' });
  });

  it('does not expose the export or the erasure endpoint either', async () => {
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });

    expect((await app.get('/admin/audit/export', adminAuth(ADMIN_TOKEN))).status).toBe(404);
    expect((await app.delete('/admin/audit/member/alex', adminAuth(ADMIN_TOKEN))).status).toBe(404);
  });
});

describe('GET /admin/audit', () => {
  it('is closed to a caller with no admin token', async () => {
    app = await startWithAudited(['alex']);

    const response = await app.get('/admin/audit', { authorization: null });

    expect(response.status).toBe(401);
  });

  it('lists every record when no filter is given', async () => {
    app = await startWithAudited(['alex', 'sam', 'alex']);

    const response = await app.get('/admin/audit', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(200);
    const page = PageSchema.parse(response.body);
    expect(page.total).toBe(3);
    expect(page.records).toHaveLength(3);
  });

  it('filters by member', async () => {
    app = await startWithAudited(['alex', 'sam', 'alex']);

    const response = await app.get('/admin/audit?member=sam', adminAuth(ADMIN_TOKEN));

    const page = PageSchema.parse(response.body);
    expect(page.total).toBe(1);
    expect(page.records[0]?.memberId).toBe('sam');
  });

  it('pages with limit and offset, reporting the unpaged total', async () => {
    app = await startWithAudited(['alex', 'sam', 'alex']);

    const response = await app.get('/admin/audit?limit=2&offset=2', adminAuth(ADMIN_TOKEN));

    const page = PageSchema.parse(response.body);
    expect(page.total).toBe(3);
    expect(page.records).toHaveLength(1);
    expect(page.offset).toBe(2);
  });

  it('covers the WHOLE of the day named in `to`, not midnight of it', async () => {
    // `?to=<today>` excluding everything that happened today would silently hide
    // the day an admin came to ask about.
    app = await startWithAudited(['alex']);
    const today = new Date().toISOString().slice(0, 10);

    const response = await app.get(`/admin/audit?from=${today}&to=${today}`, adminAuth(ADMIN_TOKEN));

    expect(PageSchema.parse(response.body).total).toBe(1);
  });

  it('excludes a window that does not contain the record', async () => {
    app = await startWithAudited(['alex']);

    const response = await app.get(
      '/admin/audit?from=2000-01-01&to=2000-01-02',
      adminAuth(ADMIN_TOKEN),
    );

    expect(PageSchema.parse(response.body).total).toBe(0);
  });

  it('REFUSES an unparseable date rather than silently dropping the filter', async () => {
    app = await startWithAudited(['alex']);

    const response = await app.get('/admin/audit?from=last-tuesday', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(400);
    expect(response.text).toContain('from');
  });
});

describe('GET /admin/audit/export', () => {
  it('returns one JSON object per line, as an attachment', async () => {
    app = await startWithAudited(['alex', 'sam']);

    const response = await app.get('/admin/audit/export', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const lines = response.text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('honours the same filters as the list endpoint', async () => {
    app = await startWithAudited(['alex', 'sam', 'alex']);

    const response = await app.get('/admin/audit/export?member=alex', adminAuth(ADMIN_TOKEN));

    const lines = response.text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(z.looseObject({ memberId: z.string() }).parse(JSON.parse(line)).memberId).toBe('alex');
    }
  });
});

describe('DELETE /admin/audit/member/:id', () => {
  it('removes that member’s records AND their stored images, and nobody else’s', async () => {
    app = await startWithAudited(['alex', 'sam', 'alex']);
    const bucket = app.objects;
    if (bucket === null) throw new Error('the org harness produced no bucket');
    expect(bucket.objects).toHaveLength(3);

    const response = await app.delete('/admin/audit/member/alex', adminAuth(ADMIN_TOKEN));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ memberId: 'alex', deleted: { records: 2, objects: 2 } });

    const remaining = await app.auditRecords();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.memberId).toBe('sam');
    // The objects are gone from the bucket too — a deleted row pointing at a
    // live photograph is not an erasure.
    expect(bucket.objects).toHaveLength(1);
    expect(bucket.objects[0]?.key).toContain('/sam/');
  });

  it('is idempotent: erasing a member with nothing stored reports zeroes', async () => {
    app = await startWithAudited(['alex']);

    const first = await app.delete('/admin/audit/member/alex', adminAuth(ADMIN_TOKEN));
    const second = await app.delete('/admin/audit/member/alex', adminAuth(ADMIN_TOKEN));

    expect(first.body).toMatchObject({ deleted: { records: 1, objects: 1 } });
    expect(second.body).toMatchObject({ deleted: { records: 0, objects: 0 } });
  });
});
