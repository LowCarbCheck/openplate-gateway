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
  const link = buildInviteLink({
    clientBaseUrl: input.clientBaseUrl,
    gatewayPublicUrl: input.gatewayPublicUrl,
    inviteToken: input.inviteToken,
  });
  const expiry = formatExpiry(input.expiresAt);

  const text = [
    `You have been invited to use ${input.gatewayName}.`,
    '',
    'It lets you use openplate without setting up your own AI provider key —',
    'the person who invited you pays for the requests.',
    '',
    'Open this link to connect:',
    '',
    link,
    '',
    `Your allowance: ${input.dailyLimit} requests per day.`,
    `This invite expires: ${expiry}. It can be used once.`,
    '',
    'Your food diary stays on your own device. Only the photo you send for an',
    'estimate passes through the gateway, and no request is ever logged.',
    '',
    'If you were not expecting this, ignore it — nothing happens until the link',
    'is opened.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
    `<p>You have been invited to use <strong>${escapeHtml(input.gatewayName)}</strong>.</p>`,
    '<p>It lets you use openplate without setting up your own AI provider key — the person who invited you pays for the requests.</p>',
    `<p><a href="${escapeHtml(link)}">Open this link to connect</a></p>`,
    // The URL as readable text too: a bare "click here" whose target is
    // invisible is exactly what a phishing mail looks like.
    `<p style="word-break:break-all;font-size:12px;color:#555">${escapeHtml(link)}</p>`,
    `<p>Your allowance: <strong>${input.dailyLimit}</strong> requests per day.<br>`,
    `This invite expires: <strong>${escapeHtml(expiry)}</strong>. It can be used once.</p>`,
    '<p style="font-size:12px;color:#555">Your food diary stays on your own device. Only the photo you send for an estimate passes through the gateway, and no request is ever logged.</p>',
    '<p style="font-size:12px;color:#555">If you were not expecting this, ignore it — nothing happens until the link is opened.</p>',
    '</body></html>',
  ].join('\n');

  return {
    subject: `You have been invited to ${input.gatewayName}`,
    text,
    html,
    link,
  };
}
