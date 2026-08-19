/**
 * `pnpm mint-token <member-id> <daily-limit>` — mint one member token.
 *
 * It prints two things: the TOKEN, once, and the registry ENTRY containing only
 * the token's SHA-256 digest. The token is not stored anywhere and cannot be
 * recovered; a member who loses theirs gets a new one minted, which is the
 * correct trade for a `members.json` that gets copied into deployments,
 * committed by mistake, pasted into issues and read by every backup.
 *
 * IT WRITES NOTHING TO DISK. Not the members file, not a temp file, not a
 * dotfile. That is the whole design:
 *
 *  - The operator runs this against a LIVE production members file, often on
 *    the box, often at 23:00 because a family member cannot log in. A script
 *    that edited that file could truncate it, reorder it, drop a comment, or
 *    lose the other members if the JSON write raced a container restart — and
 *    the failure mode of a corrupted registry is a gateway that authenticates
 *    NOBODY. This script cannot cause that, no matter how it is invoked.
 *  - Pasting is also the review step. The operator sees the entry before it
 *    lands, which is when a typo'd member id or a limit of 5000 gets caught.
 *  - And it makes the script safe to run anywhere: a laptop with no access to
 *    the deployment produces exactly the same output.
 *
 * THE TOKEN IS 32 RANDOM BYTES from `crypto.randomBytes` — a CSPRNG, not
 * `Math.random`. This value is the only thing standing between the internet and
 * the payer's provider key, so 256 bits of entropy is not excess; it removes
 * guessing from the threat model entirely and lets the gateway spend its
 * defences on quotas instead.
 */
import { createHash, randomBytes } from 'node:crypto';

/**
 * The member id rule, kept in step with `MEMBER_ID_PATTERN` in `src/members.ts`.
 *
 * Duplicated deliberately rather than exported from there: this script must not
 * import the service (it would drag in config, zod schemas and a filesystem
 * dependency for a job that is two `crypto` calls), and the duplication is
 * fail-safe — if the two ever drift, the gateway REFUSES the entry at boot with
 * a message naming the field. The failure is loud and at the right time.
 *
 * The constraint exists because the id is written into log lines: an
 * unconstrained id could carry a newline and forge a second JSON log record.
 */
const MEMBER_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** 32 bytes = 256 bits. base64url so it survives a URL, a header and a copy-paste. */
const TOKEN_BYTES = 32;

const USAGE = 'Usage: pnpm mint-token <member-id> <daily-limit>\n  e.g. pnpm mint-token alex 50';

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

/**
 * `Number.parseInt` is deliberately not used: it reads `50x` as 50 and `1e3` as
 * 1, so a fat-fingered limit would silently become a different number. A daily
 * spend cap is exactly the wrong place for a lenient parse.
 */
function parseDailyLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`Daily limit must be a whole number greater than zero, not "${raw}".`);
  }
  return value;
}

function main(): void {
  const [memberId, dailyLimitRaw] = process.argv.slice(2);

  if (!memberId || !dailyLimitRaw) fail('Both a member id and a daily limit are required.');
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    fail(
      `Member id "${memberId}" is invalid: use 1–32 characters of lowercase letters, digits, "-" or "_".`,
    );
  }
  const dailyLimit = parseDailyLimit(dailyLimitRaw);

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenSha256 = createHash('sha256').update(token).digest('hex');

  const entry = JSON.stringify({ id: memberId, tokenSha256, dailyLimit }, null, 2);

  // Written straight to stdout rather than through the logger: this is a
  // one-time operator handover meant to be read in a terminal, not a log event.
  // It is also the ONLY time the token is ever printed — the logger would be the
  // wrong place for it twice over.
  process.stdout.write(
    [
      '',
      '='.repeat(72),
      `  Token for "${memberId}" — shown ONCE. It is not stored and cannot be`,
      '  recovered. Give it to the member now; if it is lost, mint a new one.',
      '',
      `    ${token}`,
      '',
      '='.repeat(72),
      '',
      '  Paste this into the "members" array of your members.json:',
      '',
      entry
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
      '',
      '  This file holds the DIGEST, never the token. Nothing was written to',
      '  disk by this command.',
      '',
    ].join('\n'),
  );
}

main();
