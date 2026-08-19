/**
 * The member registry: who may spend the shared provider key, and how much.
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
 * AN UNREADABLE REGISTRY IS FATAL — the opposite of the quota file's policy,
 * on purpose. Starting with an empty quota file grants at most one day of extra
 * allowance. Starting with an empty registry produces a gateway that
 * authenticates nobody: every member is rejected, which reads as a broken
 * deployment rather than as a safety default, and someone will "fix" it by
 * disabling auth. Refusing to start says what actually happened.
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
const MEMBER_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** Lowercase hex only. Uppercase would compare unequal against `createHash(...).digest('hex')`. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const MemberSchema = z.object({
  id: z
    .string()
    .regex(MEMBER_ID_PATTERN, 'must be 1–32 chars of lowercase letters, digits, "-" or "_"'),
  tokenSha256: z
    .string()
    .regex(
      SHA256_HEX_PATTERN,
      'must be a 64-character lowercase hex SHA-256 digest of the token, not the token itself',
    ),
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
