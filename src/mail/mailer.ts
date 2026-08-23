/**
 * The mail port, and its one nodemailer adapter.
 *
 * WHY A PORT FOR A THREE-LINE CALL. Not to allow swapping providers — nobody
 * will. It is so that everything upstream of the transport is testable without
 * one. The admin invite route has real branching (SMTP configured or not, send
 * succeeded or not, and what the response says in each case), and none of it
 * should require a fake SMTP server to exercise. `Mailer` is the seam; the
 * message itself is built by `invite-message.ts`, which is pure.
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
import type { SmtpConfig } from '../config.js';

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
 * Used when no SMTP block is configured, so the call site does not branch on
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
          'No SMTP configuration — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM to send invite emails.',
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

/** Picks the adapter from config. `null` SMTP is the copy-link-only deployment. */
export function createMailer(smtp: SmtpConfig | null): Mailer {
  return smtp === null ? createUnconfiguredMailer() : createSmtpMailer(smtp);
}
