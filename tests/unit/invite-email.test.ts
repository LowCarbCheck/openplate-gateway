/**
 * The invite email is a pure function, so the link is checked by comparing
 * strings.
 *
 * WHY THIS IS THE TEST WORTH WRITING. The only thing that can actually be wrong
 * in an invite email is the link: a mistyped separator, a missing
 * `encodeURIComponent`, a base URL whose trailing slash doubles into `//`. Every
 * one of those produces a message that SENDS PERFECTLY and does not work, and
 * none of them is visible to a test that mocks a mail client and asserts it was
 * called once. Separating the builder from the transport is what makes the link
 * assertable at all.
 *
 * The delivery-side behaviour — whether a send is attempted, and what the admin
 * response says when it fails — is asserted in `invite-mailer.test.ts` against
 * the real route.
 */
import { describe, expect, it } from 'vitest';
import { buildInviteLink, buildInviteMessage } from '../../src/mail/invite-message.js';

const BASE = {
  gatewayName: 'The Family Gateway',
  gatewayPublicUrl: 'https://gateway.example.test',
  clientBaseUrl: 'https://app.example.test',
  inviteToken: 'opgwi_abc123',
  dailyLimit: 25,
  expiresAt: '2026-09-01T12:00:00.000Z',
};

describe('buildInviteLink', () => {
  it('builds the connect URL the client expects', () => {
    const link = buildInviteLink(BASE);

    expect(link).toBe(
      'https://app.example.test/connect-gateway?gateway=https%3A%2F%2Fgateway.example.test&invite=opgwi_abc123',
    );
  });

  it('encodes the gateway URL, so its own ? and & cannot truncate the query', () => {
    // An unencoded gateway URL carrying a query string would silently swallow
    // the `invite` parameter, and the link would fail with no clue why.
    const link = buildInviteLink({
      ...BASE,
      gatewayPublicUrl: 'https://gateway.example.test/base?x=1&y=2',
    });

    expect(link).toContain('gateway=https%3A%2F%2Fgateway.example.test%2Fbase%3Fx%3D1%26y%3D2');
    expect(link).toContain('&invite=opgwi_abc123');
  });

  it('encodes the token too, rather than relying on base64url being query-safe', () => {
    // It is today. Relying on that means the day the token format changes, every
    // link breaks at once.
    const link = buildInviteLink({ ...BASE, inviteToken: 'opgwi_a+b/c=d&e' });

    expect(link).toContain('invite=opgwi_a%2Bb%2Fc%3Dd%26e');
  });

  it('never doubles a slash, whatever the operator put in the base URLs', () => {
    const link = buildInviteLink({
      ...BASE,
      clientBaseUrl: 'https://app.example.test///',
      gatewayPublicUrl: 'https://gateway.example.test//',
    });

    expect(link).toBe(
      'https://app.example.test/connect-gateway?gateway=https%3A%2F%2Fgateway.example.test&invite=opgwi_abc123',
    );
  });
});

describe('buildInviteMessage', () => {
  it('puts the same link in the text part, the html part and the return value', () => {
    const message = buildInviteMessage(BASE);

    expect(message.link).toBe(buildInviteLink(BASE));
    // The text part carries it verbatim...
    expect(message.text).toContain(message.link);
    // ...and the HTML part carries it entity-escaped, which is the SAME link:
    // an unescaped `&` between query parameters is invalid HTML, and a mail
    // client that reparses the document can turn `&invite` into an entity and
    // silently drop the token.
    expect(message.html).toContain(message.link.replace(/&/g, '&amp;'));
  });

  it('shows the URL as readable text in the HTML, not just as an href', () => {
    // A bare "click here" whose target is invisible is what a phishing mail
    // looks like — and this one is asking somebody to connect a spend endpoint.
    const message = buildInviteMessage(BASE);

    const withoutHrefs = message.html.replace(/href="[^"]*"/g, '');
    expect(withoutHrefs).toContain('https://app.example.test/connect-gateway');
    expect(withoutHrefs).toContain('invite=opgwi_abc123');
  });

  it('names the gateway, the allowance and the expiry', () => {
    const message = buildInviteMessage(BASE);

    expect(message.subject).toContain('The Family Gateway');
    expect(message.text).toContain('25 requests per day');
    expect(message.text).toContain('2026-09-01 12:00 UTC');
  });

  it('says the invite can be used once', () => {
    const message = buildInviteMessage(BASE);

    expect(message.text).toContain('used once');
    expect(message.html).toContain('used once');
  });

  it('escapes an operator-supplied gateway name in the HTML part', () => {
    // The name is free text an operator typed into an env variable.
    const message = buildInviteMessage({ ...BASE, gatewayName: '<script>alert(1)</script>' });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('falls back to the raw timestamp rather than printing "Invalid Date"', () => {
    const message = buildInviteMessage({ ...BASE, expiresAt: 'not-a-date' });

    expect(message.text).toContain('not-a-date');
    expect(message.text).not.toContain('Invalid Date');
  });
});
