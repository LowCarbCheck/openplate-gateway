/**
 * The LEGACY member registry: a hand-edited `members.json`, read once at boot
 * and merged into the writable member store (`member-store.ts`), which is the
 * authority from ADR-0002 onward.
 *
 * This module survives because that file still exists in every deployment that
 * predates the store, and because its schema — the id rule and the digest rule —
 * is the same schema the store enforces. Those two patterns are exported from
 * here so there is one definition of "a member id" in the service.
 *
 * THE FILE HOLDS A SHA-256 DIGEST, NEVER A TOKEN. A member's token is shown
 * once, at minting time, and is not recoverable from here. That is the whole
 * point: this file gets copied into a deployment, committed by mistake, pasted
 * into an issue, and read by every backup — and none of those events hand
 * anybody a working credential. The cost is that a lost token is re-minted, not
 * looked up, which is the correct trade for a file that travels this widely.
 *
 * `dailyLimit` DEFAULTS TO ZERO, NOT TO UNLIMITED. An entry that forgets the
 * field denies every request, loudly and immediately, on the first call. The
 * other default is discovered on a bill weeks later, because "unlimited" looks
 * exactly like "working" until the money is gone. Deny-by-default puts the
 * failure where a human is watching.
 *
 * A LEGACY FILE THAT EXISTS AND DOES NOT PARSE IS STILL FATAL. An ABSENT one is
 * now normal — a gateway installed after ADR-0002 never had one, and its members
 * live in the store. The distinction is the point: silently ignoring a
 * `members.json` an operator DID write would drop every member they thought they
 * had configured.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export interface Member {
  readonly id: string; // short human label, e.g. "alex" — appears in logs
  readonly tokenSha256: string; // 64 lowercase hex chars
  readonly dailyLimit: number; // requests per UTC day
}

export interface MemberRegistry {
  readonly members: readonly Member[];
}

/**
 * A short, safe label — lowercase letters, digits, hyphen, underscore, 1–32
 * chars. Constrained because it is written into log lines: an unconstrained id
 * could carry a newline and forge a second JSON log record, or carry the
 * member's own email into logs that were meant to hold no personal data.
 */
export const MEMBER_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** Lowercase hex only. Uppercase would compare unequal against `createHash(...).digest('hex')`. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** The one wording for a bad member id, shared by the legacy file and the store. */
export const MEMBER_ID_MESSAGE = 'must be 1–32 chars of lowercase letters, digits, "-" or "_"';

/** The one wording for a value that is a token where a digest belongs. */
export const SHA256_HEX_MESSAGE =
  'must be a 64-character lowercase hex SHA-256 digest of the token, not the token itself';

const MemberSchema = z.object({
  id: z.string().regex(MEMBER_ID_PATTERN, MEMBER_ID_MESSAGE),
  tokenSha256: z.string().regex(SHA256_HEX_PATTERN, SHA256_HEX_MESSAGE),
  // Deny-by-default. See the module header for why this is not `.default(Infinity)`.
  dailyLimit: z.number().int().nonnegative().default(0),
});

const RegistrySchema = z.object({
  members: z.array(MemberSchema),
});

/** `["members", 0, "id"]` -> `members[0].id`, so an error points at a line a human can find. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((accumulated, segment) => {
    if (typeof segment === 'number') return `${accumulated}[${segment}]`;
    return accumulated === '' ? String(segment) : `${accumulated}.${String(segment)}`;
  }, '');
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = formatPath(issue.path);
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Rejects duplicate ids and duplicate digests.
 *
 * Two members sharing a token is the quiet one: nothing errors, both requests
 * authenticate, and they silently share ONE allowance — so the household's cap
 * is half what the file says, and the log line names whichever member the
 * lookup happened to find first. Duplicate ids are the same problem seen from
 * the other side: the quota key stops identifying one person.
 */
function assertNoDuplicates(members: readonly Member[]): void {
  const seenIds = new Set<string>();
  const seenDigests = new Set<string>();
  for (const member of members) {
    if (seenIds.has(member.id)) {
      throw new Error(`Duplicate member id "${member.id}" — each member needs its own id.`);
    }
    if (seenDigests.has(member.tokenSha256)) {
      throw new Error(
        `Duplicate tokenSha256 for member "${member.id}" — two members sharing a token would ` +
          'silently share one daily allowance. Mint a separate token for each member.',
      );
    }
    seenIds.add(member.id);
    seenDigests.add(member.tokenSha256);
  }
}

export function parseMembers(raw: unknown): MemberRegistry {
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid member registry: ${formatIssues(parsed.error)}. Expected ` +
        '{ "members": [ { "id": "alex", "tokenSha256": "<64 hex chars>", "dailyLimit": 50 } ] }.',
    );
  }
  assertNoDuplicates(parsed.data.members);
  return { members: parsed.data.members };
}

/**
 * Reads and validates the legacy registry, returning `null` when the file does
 * not exist.
 *
 * ABSENT AND MALFORMED ARE NOT THE SAME ANSWER. A gateway installed after
 * ADR-0002 has no `members.json` at all and must boot; a gateway whose
 * `members.json` is unparseable has members its operator believes in, and
 * booting without them would silently revoke the household. `null` means "there
 * was nothing to merge"; a throw means "there was something and I could not
 * read it".
 */
export async function loadLegacyMembersFileIfPresent(
  filePath: string,
): Promise<MemberRegistry | null> {
  try {
    return await loadMembersFile(filePath);
  } catch (error) {
    // Only a genuinely absent file is forgiven. `loadMembersFile` wraps the
    // original in `cause`, so that is where the errno lives — a message match
    // would be a different function's wording to keep in step.
    if (error instanceof Error && isFileNotFound(error.cause)) return null;
    throw error;
  }
}

/** `ENOENT` and nothing else. Narrowed from `unknown` because `catch` gives no guarantees. */
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Reads and validates the registry. Every failure — missing file, unreadable
 * file, bad JSON, bad shape — throws with the path in the message, because the
 * caller is a boot sequence whose only useful response is to stop and say why.
 */
export async function loadMembersFile(filePath: string): Promise<MemberRegistry> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read member registry at ${filePath}: ${reason}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Member registry at ${filePath} is not valid JSON: ${reason}`, { cause: error });
  }

  try {
    return parseMembers(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Member registry at ${filePath} is invalid. ${reason}`, { cause: error });
  }
}
