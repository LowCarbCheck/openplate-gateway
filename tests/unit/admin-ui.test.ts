/**
 * The admin page: absent when unconfigured, and inert when it is not.
 *
 * THE FIRST DESCRIBE IS THE SAME SECURITY ASSERTION AS `admin-api.test.ts`. The
 * page is a second door into the admin area, and a door that answers differently
 * from the wall around it is a door somebody can find. `/admin/ui` on a gateway
 * with no admin token must be byte-comparable to a path that never existed.
 *
 * THE REST PIN THE TWO PROPERTIES OF THE DOCUMENT ITSELF: it puts the admin
 * token in no browser store, and it talks to no endpoint that does not already
 * exist. Both are invisible to a typecheck and to every other test, because the
 * page is a string — nothing but a grep over the served bytes can see them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAdminToken, startTestApp, type TestApp } from '../support/app-harness.js';

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

describe('with NO admin token configured', () => {
  beforeEach(async () => {
    app = await startTestApp();
  });

  it('answers /admin/ui exactly as it answers a nonsense path', async () => {
    const started = harness();

    const page = await started.get('/admin/ui');
    const nonsense = await started.get('/admin-does-not-exist');

    expect(page.status).toBe(404);
    expect(page.status).toBe(nonsense.status);
    expect(page.body).toMatchObject({ error: { code: 'unknown_endpoint' } });
    expect(nonsense.body).toMatchObject({ error: { code: 'unknown_endpoint' } });
    expect(page.headers.get('content-type')).toBe(nonsense.headers.get('content-type'));
  });

  it('answers 404 to a caller with no credential at all, never 401', async () => {
    // The page is served without a bearer when it exists, so the unconfigured
    // case has to be checked with no bearer too — otherwise the assertion is
    // about member auth rather than about the page.
    const started = harness();

    const response = await started.get('/admin/ui', { token: null });

    expect(response.status).toBe(404);
  });
});

describe('with an admin token configured', () => {
  beforeEach(async () => {
    app = await startTestApp({ config: { adminToken: ADMIN_TOKEN } });
  });

  it('serves the page as HTML to a browser that cannot send a bearer', async () => {
    // A navigation carries no `Authorization` header — by specification. If this
    // needed one, the page could never be opened.
    const started = harness();

    const response = await started.get('/admin/ui', { token: null });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.text).toContain('<!doctype html>');
  });

  it('renders a token form, and no roster, to an unauthenticated visitor', async () => {
    // The document is public; the data behind it is not. Nothing that arrives
    // over the wire here may name a member.
    const started = harness();

    const response = await started.get('/admin/ui', { token: null });

    expect(response.text).toContain('id="signin-form"');
    expect(response.text).not.toContain('alex');
    expect(response.text).not.toContain(ADMIN_TOKEN);
  });

  it('puts the admin token in no browser store', async () => {
    // A shared family laptop is the deployment this gateway is built for. Any of
    // these three would leave the payer's admin credential readable by the next
    // person to open the console, long after the tab was closed.
    const started = harness();

    const response = await started.get('/admin/ui', { token: null });

    expect(response.text).not.toContain('localStorage');
    expect(response.text).not.toContain('sessionStorage');
    expect(response.text).not.toContain('document.cookie');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('references only endpoints that already exist', async () => {
    // The page must add no API surface. Every `/admin/...` and `/v1/...` string
    // in the document is collected and checked against the endpoints
    // `admin-routes.ts` and `public-routes.ts` already serve — so a future edit
    // that reaches for a new one fails here rather than in review.
    const started = harness();
    const allowed = ['/admin/members', '/admin/invites', '/v1/gateway/info'];

    const response = await started.get('/admin/ui', { token: null });
    const referenced = response.text.match(/\/(?:admin|v1)\/[a-z0-9/_-]*/gi) ?? [];

    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) {
      expect(allowed).toContain(path);
    }
  });

  it('allows its own inline script by nonce rather than by unsafe-inline', async () => {
    // One self-contained file means the script is inline, and `'unsafe-inline'`
    // would allow any OTHER inline script too — on the surface that mints member
    // tokens. The nonce allows exactly these two blocks.
    const started = harness();

    const response = await started.get('/admin/ui', { token: null });
    const policy = response.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];

    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(nonce).toBeDefined();
    expect(response.text).toContain(`<script nonce="${nonce}">`);
  });

  it('mints a fresh nonce per request', async () => {
    // A constant nonce is `'unsafe-inline'` written out longhand.
    const started = harness();

    const first = await started.get('/admin/ui', { token: null });
    const second = await started.get('/admin/ui', { token: null });

    expect(first.headers.get('content-security-policy')).not.toBe(
      second.headers.get('content-security-policy'),
    );
  });

  it('still requires the bearer on the API the page calls', async () => {
    // The page being open to a navigation must not have opened anything else.
    const started = harness();

    const response = await started.get('/admin/members', { token: null });

    expect(response.status).toBe(401);
  });
});
