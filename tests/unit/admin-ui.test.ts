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
import { renderAdminUiPage } from '../../src/server/admin-ui.js';
import { stringsFor } from '../../src/i18n.js';

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

/**
 * The German render (M167/03).
 *
 * The page is one string built by hand, so the failure modes are string
 * failures: a label that stayed English because its literal was missed, an
 * umlaut mangled on the way into the document, or the dictionary breaking the
 * inline `<script>` it is injected into. None of those is a type error and none
 * of them throws.
 */
/** How many times a pattern occurs in a rendered page. */
const count = (html: string, needle: RegExp) => (html.match(needle) ?? []).length;

describe('renderAdminUiPage — German', () => {
  const de = renderAdminUiPage('test-nonce', 'de');
  const en = renderAdminUiPage('test-nonce', 'en');

  it('declares the language to the browser', () => {
    expect(de).toContain('<html lang="de">');
    expect(en).toContain('<html lang="en">');
  });

  it('renders every dictionary string the page has a place for', () => {
    // Asserted against the DICTIONARY, not against hardcoded German. The German
    // is machine-translated and re-runnable (see `src/i18n.ts`), so a test that
    // pinned the exact wording would break on every re-run and teach whoever
    // re-ran it to edit assertions rather than read them. What must hold is
    // that the page renders what the dictionary says, whatever that says.
    const dict = stringsFor('de').console;
    for (const key of ['heading', 'adminTokenLabel', 'unlock', 'membersHeading', 'invitesHeading'] as const) {
      expect(de, `missing from the page: ${key}`).toContain(dict[key]);
    }
  });

  it('leaves no English label behind in the German page', () => {
    // The exact strings the English page shows in the same places. Any one of
    // them surviving means a literal was missed rather than translated.
    for (const english of [
      '>Gateway admin<',
      '>Admin token<',
      '>Unlock<',
      '>Members<',
      '>Invites<',
      '>Daily limit<',
      '>Create member<',
      '>Create invite<',
      'No members yet',
      'No invites yet',
    ]) {
      expect(de, `untranslated: ${english}`).not.toContain(english);
    }
  });

  it('keeps umlauts and eszett intact rather than escaping or dropping them', () => {
    // Every dictionary string that HAS a German-only character must survive
    // with it intact. Derived from the dictionary so it keeps working when the
    // translation is re-run and different strings carry the umlauts.
    const dict = stringsFor('de').console;
    const withUmlauts = Object.values(dict).filter((value) => /[äöüÄÖÜß]/.test(value));
    expect(withUmlauts.length, 'no German string carries an umlaut — suspect').toBeGreaterThan(3);
    for (const value of withUmlauts) {
      expect(de, `mangled: ${value}`).toContain(value);
    }
    expect(de).not.toContain('&auml;');
    expect(de).not.toContain('&szlig;');
  });

  it('does not let the dictionary break out of the inline script', () => {
    // The dictionary is injected into a <script> block. A literal `</script>`
    // in any string would close it early and put the rest of the page's own
    // code into the document as text.
    const scriptOpen = de.indexOf('<script nonce=');
    const scriptClose = de.indexOf('</script>', scriptOpen);
    const block = de.slice(scriptOpen, scriptClose);
    expect(block).toContain('var T = ');
    // Inside the block, every `<` from the dictionary is <-escaped.
    expect(block).not.toMatch(/var T = \{[^\n]*</);
  });

  it('keeps the security properties the English page has', () => {
    // The CSP is a header, not markup — what the DOCUMENT must still show is
    // the nonce on both inline blocks and no external asset anywhere.
    expect((de.match(/nonce="test-nonce"/g) ?? []).length).toBe(2);
    // No external asset may have arrived with the translation.
    expect(de).not.toMatch(/https?:\/\/[^"' ]+\.(css|js|woff2?|png|svg)/);
  });

  it('renders exactly the same structure in both languages', () => {
    // Same number of form fields, rows and buttons — a translation must not
    // add or lose a control.
    expect(count(de, /<input /g)).toBe(count(en, /<input /g));
    expect(count(de, /<button/g)).toBe(count(en, /<button/g));
    expect(count(de, /<th>/g)).toBe(count(en, /<th>/g));
  });
});

/**
 * The page's OWN JavaScript, executed (M167/03).
 *
 * Everything in the inline script is a string on the server, so TypeScript
 * never sees it and neither does the linter's type layer. That gap is not
 * theoretical: this suite was written after a template-literal escape bug
 * shipped `/{(w+)}/` into the browser instead of `/\{(\w+)\}/`. The page
 * rendered, the console loaded, every markup assertion passed, and every
 * substituted string — "Member {id} created", the revoke confirmations —
 * would have shown the reader a literal `{id}`.
 *
 * So this extracts the page's `fill` and runs it.
 */
/** Pulls one function's source out of the inline script and makes it callable. */
function extractFill(page: string): (t: string, v: Record<string, string | number>) => string {
  const start = page.indexOf('function fill(template, values) {');
  expect(start, 'fill() not found in the rendered page').toBeGreaterThan(-1);
  const end = page.indexOf('\n  }', start);
  const source = page.slice(start, end + 4);
  // eslint-disable-next-line no-new-func -- the input is this module's own output
  return new Function(`${source}; return fill;`)() as ReturnType<typeof extractFill>;
}

describe('the rendered page runs', () => {
  for (const language of ['en', 'de'] as const) {
    it(`${language}: substitutes a placeholder instead of printing it literally`, () => {
      const fill = extractFill(renderAdminUiPage('n', language));
      expect(fill('Member "{id}" created.', { id: 'ada' })).toBe('Member "ada" created.');
    });

    it(`${language}: substitutes into the real dictionary strings`, () => {
      const page = renderAdminUiPage('n', language);
      const fill = extractFill(page);
      const dict = stringsFor(language).console;
      const filled = fill(dict.memberCreated, { id: 'ada' });
      expect(filled).toContain('ada');
      expect(filled).not.toContain('{id}');

      const answered = fill(dict.gatewayAnswered, { status: 503 });
      expect(answered).toContain('503');
      expect(answered).not.toContain('{status}');
    });
  }
});
