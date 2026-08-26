/**
 * The mail port, and its two adapters: nodemailer over SMTP, and a
 * Resend-compatible HTTP API.
 *
 * WHY A PORT FOR A THREE-LINE CALL. Two reasons, and the smaller one came
 * second. The first is that everything upstream of the transport has to be
 * testable without one: the admin invite route has real branching (mail
 * configured or not, send succeeded or not, and what the response says in each
 * case), and none of it should require a fake mail server to exercise.
 * `Mailer` is the seam; the message itself is built by `invite-message.ts`,
 * which is pure. The second is that there really are two transports now — a
 * self-hoster with a mailbox provider has SMTP credentials and nothing else,
 * while a hosted deployment sends through an HTTP API and often cannot open
 * port 587 at all. Both stay behind one two-method surface.
 *
 * THE ADAPTER IS THE ONLY MODULE IN THE SERVICE THAT IMPORTS NODEMAILER, which
 * is also what keeps the `external` list in `scripts/build.ts` honest:
 * nodemailer is CommonJS, so bundling it into the ESM output produces esbuild's
 * dynamic-require shim and an artifact that throws on its first line.
 *
 * NOTHING HERE LOGS A RECIPIENT, A SUBJECT, A BODY OR A LINK. The link carries
 * the invite token, so it is a credential; the recipient address is personal
 * data we hold for one send. The invite id is the correlation handle, and it is
 * enough.
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { HttpMailConfig, MailConfig, SmtpConfig } from '../config.js';

/**
 * 15 s, and NO RETRIES. The invite route already treats a failed send as
 * survivable — it answers 201 with `emailed: false` and a link that still
 * works — so a retry loop here would be duplicate-email machinery bolted onto a
 * path that is allowed to fail. It is a parameter rather than a variable
 * because the only caller that needs a different value is a test proving the
 * bound exists; an operator has nothing to tune here.
 */
export const DEFAULT_MAIL_API_TIMEOUT_MS = 15_000;

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/**
 * Fails on every send.
 *
 * Used when no mail block is configured, so the call site does not branch on
 * `null` — and it THROWS rather than silently succeeding, because a mailer that
 * quietly discards an invite would leave the operator believing one was
 * delivered. Copy-link is the primary flow precisely so this path is a
 * degradation and not an outage.
 */
export function createUnconfiguredMailer(): Mailer {
  return {
    send: (): Promise<void> =>
      Promise.reject(
        new Error(
          'No mail configuration — to send invite emails, set either the SMTP block (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) or the HTTP mail API block (MAIL_API_URL, MAIL_API_KEY, MAIL_API_FROM).',
        ),
      ),
  };
}

export function createSmtpMailer(smtp: SmtpConfig): Mailer {
  // `secure` from the port rather than a sixth variable: 465 is implicit TLS
  // and everything else is STARTTLS-on-587, which is the whole decision tree in
  // practice. A variable here would be one more thing to get wrong for no reach.
  const transporter: Transporter = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  return {
    async send(mail: OutgoingMail): Promise<void> {
      await transporter.sendMail({
        from: smtp.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}

/**
 * Posts the message to a Resend-compatible HTTP mail API.
 *
 * ONE ADAPTER, NOT ONE PER PROVIDER. Resend and our own pigeon service differ
 * in exactly two ways: the path (`/emails` against `/v1/emails`) and whether
 * `to` may be a bare string. The path is the operator's whole URL, so it never
 * reaches this code; `to` is ALWAYS sent as a one-element array, which Resend
 * accepts and pigeon requires. That is the entire compatibility story, and it
 * is why there is no provider enum and no branch below.
 *
 * GLOBAL `fetch`, NOT UNDICI. Node 22's `fetch` is undici, so importing the
 * package would buy nothing and cost an entry on `scripts/build.ts`'s
 * `external` list. This adapter adds no dependency at all — for a public repo
 * where every dependency is a supply-chain surface a self-hoster inherits, a
 * mail transport that is one `fetch` is the point.
 *
 * THE ERROR CARRIES THE STATUS CODE AND NOTHING ELSE — read the `send` body.
 */
export function createHttpMailer(
  mail: HttpMailConfig,
  options: { timeoutMs?: number } = {},
): Mailer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MAIL_API_TIMEOUT_MS;

  return {
    async send(outgoing: OutgoingMail): Promise<void> {
      const response = await fetch(mail.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mail.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: mail.from,
          // An array even for one recipient: see the header.
          to: [outgoing.to],
          subject: outgoing.subject,
          text: outgoing.text,
          html: outgoing.html,
        }),
        // No retry, and no idempotency key — with nothing retrying, there is
        // no duplicate for a key to suppress. See `DEFAULT_MAIL_API_TIMEOUT_MS`.
        signal: AbortSignal.timeout(timeoutMs),
      });

      // THE BODY IS DISCARDED WITHOUT BEING READ, and that is a privacy
      // decision rather than a tidiness one. Both Resend and pigeon echo the
      // request back inside an error body — the recipient address and the
      // subject, and any provider might one day echo the html, which carries
      // the invite token. Cancelling rather than reading means there is no
      // string in scope for a later `${...}` to put into a message or a log.
      await response.body?.cancel();

      if (!response.ok) {
        // THE STATUS CODE, AND NOTHING ELSE. Not `statusText`, which some
        // providers set from their own error text; not the body; not the URL,
        // which is where a hosted API's credential sometimes ends up as a query
        // parameter. The invite route logs the invite id beside this failure,
        // and an operator correlating on that id has the whole story.
        throw new Error(`mail API responded ${response.status}`);
      }
    },
  };
}

/**
 * Picks the adapter from config. `null` is the copy-link-only deployment, which
 * is what most self-hosters run.
 *
 * The `switch` is over a discriminated union deliberately: adding a third
 * transport is then a compile error here rather than a silently unhandled case.
 */
export function createMailer(mail: MailConfig | null): Mailer {
  if (mail === null) return createUnconfiguredMailer();
  switch (mail.transport) {
    case 'smtp':
      return createSmtpMailer(mail.smtp);
    case 'http':
      return createHttpMailer(mail.http);
  }
}
