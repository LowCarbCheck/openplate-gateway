/**
 * The invite email, as a PURE FUNCTION of its inputs.
 *
 * WHY THE MESSAGE IS BUILT NOWHERE NEAR THE TRANSPORT. The one thing that can
 * actually be wrong here is the link: a mistyped separator, a missing
 * `encodeURIComponent`, a base URL with a trailing slash doubling into `//`.
 * Every one of those produces a message that sends perfectly and does not work,
 * and none of them is observable from a test that mocks a mail client and
 * asserts it was called. Separating the builder means the link is checked by
 * string comparison, with no SMTP anywhere near the test.
 *
 * THE TOKEN IS IN THE LINK, SO THE LINK IS A CREDENTIAL. It must never be
 * logged. `mailer.ts` logs the invite id and nothing else, and this module
 * returns a value rather than performing an effect precisely so there is no
 * temptation to log what it built.
 *
 * PLAIN TEXT FIRST, MINIMAL HTML SECOND. The plain part is not a fallback — it
 * is what a lot of people actually see, and a mail with a bare "click here"
 * whose href is invisible is indistinguishable from phishing. Both parts carry
 * the full URL as readable text.
 */

import { fill, stringsFor, type GatewayLanguage } from '../i18n.js';

export interface InviteMessageInput {
  /** Human-facing name of the gateway, from `GATEWAY_NAME`. */
  gatewayName: string;
  /** This gateway's externally reachable base URL, from `GATEWAY_PUBLIC_URL`. */
  gatewayPublicUrl: string;
  /** Where the openplate client lives, from `CLIENT_BASE_URL`. */
  clientBaseUrl: string;
  /** The plaintext invite token. A credential — see the module header. */
  inviteToken: string;
  /** Requests per UTC day the invite will grant. */
  dailyLimit: number;
  expiresAt: string;
  /**
   * The gateway's configured language (`GATEWAY_LANGUAGE`).
   *
   * An INPUT, not a module-scope read, for the same reason everything else
   * here is: this builder stays a pure function of its arguments, so both
   * languages are asserted by string comparison with no environment and no
   * SMTP anywhere near the test.
   */
  language: GatewayLanguage;
}

export interface InviteMessage {
  subject: string;
  text: string;
  html: string;
  /** Returned separately so a caller can show the same link in the admin response. */
  link: string;
}

/** Drops trailing slashes so the join below never produces `//`. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * The link the client opens.
 *
 * BOTH VALUES ARE ENCODED. The gateway URL obviously — it is a URL inside a
 * query string, and an unencoded `?` or `&` in it would silently truncate
 * everything after. The token less obviously: it is base64url, whose alphabet
 * happens to be query-safe today, and relying on that means the day the token
 * format changes the link breaks for everyone at once.
 */
export function buildInviteLink(parts: {
  clientBaseUrl: string;
  gatewayPublicUrl: string;
  inviteToken: string;
}): string {
  const client = stripTrailingSlashes(parts.clientBaseUrl);
  const gateway = encodeURIComponent(stripTrailingSlashes(parts.gatewayPublicUrl));
  const invite = encodeURIComponent(parts.inviteToken);
  return `${client}/connect-gateway?gateway=${gateway}&invite=${invite}`;
}

/**
 * Minimal escaping for the values interpolated into the HTML part.
 *
 * The gateway name is operator-supplied free text, so it can contain `<`. This
 * is not a general-purpose sanitiser and does not need to be: the only sink is
 * element text and a plain `href` we built ourselves.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders the expiry the way a person reads it, in UTC, with the zone named. */
function formatExpiry(expiresAt: string): string {
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return expiresAt;
  return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function buildInviteMessage(input: InviteMessageInput): InviteMessage {
  const t = stringsFor(input.language).mail;
  const link = buildInviteLink({
    clientBaseUrl: input.clientBaseUrl,
    gatewayPublicUrl: input.gatewayPublicUrl,
    inviteToken: input.inviteToken,
  });
  const expiry = formatExpiry(input.expiresAt);

  // Built once and used by both parts, so the two can never disagree about
  // what the reader was told.
  const invitedTo = fill(t.invitedTo, { gateway: input.gatewayName });
  const allowance = fill(t.allowance, { limit: input.dailyLimit });
  const expires = fill(t.expires, { expiry });

  const text = [
    invitedTo,
    '',
    t.whatItIs,
    '',
    t.openLink,
    '',
    link,
    '',
    allowance,
    expires,
    '',
    t.privacy,
    '',
    t.unexpected,
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="' + input.language + '"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
    `<p>${escapeHtml(invitedTo)}</p>`,
    `<p>${escapeHtml(t.whatItIs)}</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(t.openLinkHtml)}</a></p>`,
    // The URL as readable text too: a bare "click here" whose target is
    // invisible is exactly what a phishing mail looks like.
    `<p style="word-break:break-all;font-size:12px;color:#555">${escapeHtml(link)}</p>`,
    `<p>${escapeHtml(allowance)}<br>`,
    `${escapeHtml(expires)}</p>`,
    `<p style="font-size:12px;color:#555">${escapeHtml(t.privacy)}</p>`,
    `<p style="font-size:12px;color:#555">${escapeHtml(t.unexpected)}</p>`,
    '</body></html>',
  ].join('\n');

  return {
    subject: fill(t.subject, { gateway: input.gatewayName }),
    text,
    html,
    link,
  };
}
