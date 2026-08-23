/**
 * `pnpm mint-token <member-id> <daily-limit>` — mint one member token and add
 * the member to the store.
 *
 * IT NOW WRITES, AND THAT IS THE CHANGE ADR-0002 MADE. It used to print a JSON
 * block for the operator to paste into `members.json` by hand, and refuse to
 * touch a file. The reasoning was sound for the file it was protecting: a
 * hand-edited registry that a bad write could truncate, reorder or empty, whose
 * failure mode was a gateway that authenticates nobody.
 *
 * The member store removed that hazard rather than working around it. Writes go
 * through `store/atomic-json-file.ts`: read-modify-write under an in-process
 * lock, then a write to a temp file and an atomic `rename` over the target. A
 * process killed mid-write leaves the old file completely intact, and a file
 * that exists but does not parse stops the operation instead of being replaced
 * with an empty one. So the paste step bought nothing that the store does not
 * now guarantee, and cost every operator a manual JSON edit at the exact moment
 * they were in a hurry.
 *
 * IT DOES NOT LOAD THE SERVICE CONFIG. `loadConfig` demands `UPSTREAM_BASE_URL`
 * and `UPSTREAM_API_KEY`, which this command has no use for — requiring them
 * would mean a laptop without the provider key could not mint a token. It reads
 * `MEMBER_STORE_FILE` from the environment directly, with the same default, and
 * prints the path it wrote to so the operator can see whether it was the one
 * they meant.
 *
 * THE TOKEN IS 32 RANDOM BYTES from a CSPRNG, and is printed ONCE. It is not
 * stored — only its SHA-256 digest is — and cannot be recovered. A member who
 * loses theirs gets a new one minted, which is the correct trade for a file that
 * ends up in backups and volume snapshots.
 */
import { DEFAULT_MEMBER_STORE_FILE } from '../src/config.js';
import { createFileMemberStore } from '../src/member-store.js';
import { MEMBER_ID_PATTERN } from '../src/members.js';
import { memberTokenDigest, mintMemberToken } from '../src/tokens.js';

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

async function main(): Promise<void> {
  const [memberId, dailyLimitRaw] = process.argv.slice(2);

  if (!memberId || !dailyLimitRaw) fail('Both a member id and a daily limit are required.');
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    fail(
      `Member id "${memberId}" is invalid: use 1–32 characters of lowercase letters, digits, "-" or "_".`,
    );
  }
  const dailyLimit = parseDailyLimit(dailyLimitRaw);

  const storePath = process.env.MEMBER_STORE_FILE?.trim() || DEFAULT_MEMBER_STORE_FILE;
  const store = createFileMemberStore(storePath);

  const token = mintMemberToken();
  try {
    await store.create({
      id: memberId,
      tokenSha256: memberTokenDigest(token),
      dailyLimit,
      // Everything this script mints is a family member. Org mode issues
      // members through invites, where consent is recorded; there is no
      // equivalent for a token an operator hands over directly.
      mode: 'family',
    });
  } catch (error) {
    // `message` only — no stack, no cause chain. Same discipline as `main.ts`.
    fail(error instanceof Error ? error.message : 'Could not add the member.');
  }

  // Written straight to stdout rather than through the logger: this is a
  // one-time operator handover meant to be read in a terminal, not a log event.
  // It is also the ONLY time the token is ever printed.
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
      `  Added to the member store at ${storePath}`,
      `  Daily limit: ${dailyLimit} requests per UTC day.`,
      '',
      '  The store holds the DIGEST, never the token. A running gateway picks',
      '  this member up on the next request — no restart is needed.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
