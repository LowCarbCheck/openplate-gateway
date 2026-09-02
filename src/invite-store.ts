/**
 * Invites: a one-shot credential that turns into a member.
 *
 * WHY INVITES EXIST AT ALL. Before them, adding someone to a family gateway
 * meant sending them a bearer token over WhatsApp and asking them to paste it
 * into a settings form. That token is a live spend credential with no expiry,
 * and it now lives in a chat history forever. An invite is short-lived, single
 * use, and dies the moment it is redeemed — so the thing sitting in the chat log
 * afterwards is worthless.
 *
 * THE FILE HOLDS A DIGEST, NEVER A TOKEN — same rule as the member store, same
 * reason. An invite token is shown once, when it is created.
 *
 * EVERY REJECTION LOOKS THE SAME FROM OUTSIDE. Unknown, expired, already
 * redeemed and revoked all produce one 400 with one body. Distinguishing them
 * would hand an attacker a probe: "already redeemed" confirms a token existed,
 * "expired" confirms it existed AND narrows when it was made, and a guessing
 * loop can tell warm from cold. The REASON is carried on the error for the
 * server's own log, where a self-hosting admin needs it and an attacker cannot
 * read it — see `public-routes.ts`.
 *
 * REDEMPTION IS CHECK-AND-ACT INSIDE ONE LOCK. Two simultaneous redemptions of
 * the same token must not both succeed, and a naive read-then-write lets them:
 * both read `redeemedAt: undefined`, both create a member, and one invite has
 * bought two allowances. `redeem` therefore does its validation inside
 * `update`'s critical section, which is serialised with every other operation on
 * this file. That lock is IN-PROCESS: this store assumes a single Node process,
 * as the member and quota stores do.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MEMBER_ID_MESSAGE, MEMBER_ID_PATTERN, SHA256_HEX_MESSAGE, SHA256_HEX_PATTERN } from './members.js';
import { createAtomicJsonFile, type AtomicJsonFile } from './store/atomic-json-file.js';

/**
 * Distinct from a member token's shape so a human pasting the wrong one into
 * the wrong field gets a clean failure instead of a confusing 401, and so a
 * string found in a log or a chat is identifiable at a glance.
 *
 * `gi_` since M181/05, where the prefix stopped being a convenience and became
 * a BINDING. A join link can carry this token beside an `openplate-sync` signup
 * invite, which wears `si_`; the two are otherwise interchangeable strings, and
 * the services behind them have different operators and different revocation
 * surfaces. Short on purpose: it is read aloud, retyped and pasted by people.
 * It replaced `opgwi_` outright rather than being accepted alongside it,
 * because an invite lives at most a week (`MAX_INVITE_TTL_HOURS`) and this is
 * pre-launch: the whole outstanding population expires on its own.
 */
export const INVITE_TOKEN_PREFIX = 'gi_';

/**
 * Whether a presented string could be an invite of THIS service at all.
 *
 * A SHAPE GATE, and `redeem` runs it before it touches the store. It is not a
 * check on the token's validity and must never behave like one: its rejection
 * is the same `InviteRejectedError('unknown')` an invented token gets, which
 * `public-routes.ts` turns into the same 400 with the same body as an expired,
 * revoked or already-spent one. So it buys a refusal without a lookup, and
 * gives up nothing: the digest comparison below stays free of the length and
 * prefix oracles it was written to avoid.
 */
export function hasInviteTokenShape(token: string): boolean {
  return token.startsWith(INVITE_TOKEN_PREFIX);
}

/** 32 bytes = 256 bits, from a CSPRNG. Guessing is removed from the threat model. */
const INVITE_TOKEN_BYTES = 32;

/** 8 bytes of hex. An opaque handle: safe in a URL, safe in a log line, meaningless on its own. */
const INVITE_ID_BYTES = 8;

export const DEFAULT_INVITE_TTL_HOURS = 72;

/** A week. Long enough for "send it Friday, they open it next weekend", short enough to still be an expiry. */
export const MAX_INVITE_TTL_HOURS = 24 * 7;

export const INVITE_STORE_VERSION = 1;

export interface InviteRecord {
  readonly id: string;
  readonly tokenSha256: string;
  /** The member id this invite will create when redeemed. */
  readonly memberId: string;
  readonly dailyLimit: number;
  readonly expiresAt: string;
  readonly redeemedAt?: string;
  readonly revokedAt?: string;
  /** Only present when the operator asked for the invite to be emailed. */
  readonly email?: string;
  readonly createdAt: string;
}

const InviteRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/, 'must be 16 lowercase hex characters'),
  tokenSha256: z.string().regex(SHA256_HEX_PATTERN, SHA256_HEX_MESSAGE),
  memberId: z.string().regex(MEMBER_ID_PATTERN, MEMBER_ID_MESSAGE),
  dailyLimit: z.number().int().nonnegative(),
  expiresAt: z.string().min(1),
  redeemedAt: z.string().min(1).optional(),
  revokedAt: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  createdAt: z.string().min(1),
});

const InviteStoreStateSchema = z.object({
  version: z.number().int().positive().default(INVITE_STORE_VERSION),
  invites: z.array(InviteRecordSchema),
});

type InviteStoreState = z.infer<typeof InviteStoreStateSchema>;

/**
 * What an operator sees in the admin list. Derived, never stored: a stored
 * status would have to be recomputed on a timer to ever become `expired`, and a
 * status field that lies until something sweeps it is worse than no field.
 */
export type InviteStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

/**
 * `redeemed` wins over everything: it is the terminal fact, and an operator
 * looking at a redeemed invite that has since passed its expiry needs to be
 * told it worked, not that it lapsed. `revoked` beats `expired` for the same
 * reason — one is a decision somebody made, the other is just time passing.
 */
export function inviteStatus(invite: InviteRecord, now: Date): InviteStatus {
  if (invite.redeemedAt !== undefined) return 'redeemed';
  if (invite.revokedAt !== undefined) return 'revoked';
  if (Date.parse(invite.expiresAt) <= now.getTime()) return 'expired';
  return 'pending';
}

/** Why a redemption failed. For the SERVER LOG only — the client is told one thing for all four. */
export type InviteRejectionReason = 'unknown' | 'expired' | 'redeemed' | 'revoked';

export class InviteRejectedError extends Error {
  readonly reason: InviteRejectionReason;
  /** Absent for `unknown` — there is no invite to name. */
  readonly inviteId?: string;

  constructor(reason: InviteRejectionReason, inviteId?: string) {
    super(`Invite rejected: ${reason}`);
    this.name = 'InviteRejectedError';
    this.reason = reason;
    if (inviteId !== undefined) this.inviteId = inviteId;
  }
}

export class InviteNotFoundError extends Error {
  constructor(id: string) {
    super(`No invite with id "${id}".`);
    this.name = 'InviteNotFoundError';
  }
}

export interface CreateInviteInput {
  memberId: string;
  dailyLimit: number;
  ttlHours: number;
  email?: string;
}

/** A freshly created invite, plus the plaintext token — the only moment it exists. */
export interface CreatedInvite {
  readonly invite: InviteRecord;
  /** Show it once, then forget it. It is not recoverable from the store. */
  readonly token: string;
}

export interface InviteStore {
  all(): Promise<readonly InviteRecord[]>;
  create(input: CreateInviteInput): Promise<CreatedInvite>;
  revoke(id: string): Promise<InviteRecord>;
  /**
   * Claims an invite by token: validates and marks it redeemed in ONE critical
   * section, so a second concurrent redemption of the same token loses.
   *
   * The caller creates the member afterwards. That order is deliberate — see
   * `public-routes.ts` — because burning an invite that then fails to produce a
   * member costs one invite, while creating a member before burning the invite
   * costs an unbounded number of members.
   */
  redeem(token: string): Promise<InviteRecord>;
}

export function inviteTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreateFileInviteStoreOptions {
  now?: () => Date;
  /** Injectable token minting, so a test can pin the token it is about to redeem. */
  mintToken?: () => string;
  /** Injectable id minting, for the same reason. */
  mintId?: () => string;
}

export function createFileInviteStore(
  filePath: string,
  options: CreateFileInviteStoreOptions = {},
): InviteStore {
  const now = options.now ?? ((): Date => new Date());
  const mintToken =
    options.mintToken ??
    ((): string => `${INVITE_TOKEN_PREFIX}${randomBytes(INVITE_TOKEN_BYTES).toString('base64url')}`);
  const mintId = options.mintId ?? ((): string => randomBytes(INVITE_ID_BYTES).toString('hex'));

  const file: AtomicJsonFile<InviteStoreState> = createAtomicJsonFile({
    filePath,
    schema: InviteStoreStateSchema,
    empty: () => ({ version: INVITE_STORE_VERSION, invites: [] }),
    label: 'invite store',
    temporaryPrefix: 'invite-store',
  });

  return {
    async all(): Promise<readonly InviteRecord[]> {
      const state = await file.read();
      return state.invites;
    },

    create(input: CreateInviteInput): Promise<CreatedInvite> {
      const token = mintToken();
      const createdAt = now();
      const invite = buildInviteRecord({
        input,
        id: mintId(),
        tokenSha256: inviteTokenDigest(token),
        createdAt,
      });
      return file.update((current) => ({
        next: { ...current, invites: [...current.invites, invite] },
        result: { invite, token },
      }));
    },

    revoke(id: string): Promise<InviteRecord> {
      const revokedAt = now().toISOString();
      return file.update((current) => {
        const existing = current.invites.find((invite) => invite.id === id);
        if (existing === undefined) throw new InviteNotFoundError(id);
        const revoked: InviteRecord =
          existing.revokedAt === undefined ? { ...existing, revokedAt } : existing;
        return {
          next: {
            ...current,
            invites: current.invites.map((invite) => (invite.id === id ? revoked : invite)),
          },
          result: revoked,
        };
      });
    },

    redeem(token: string): Promise<InviteRecord> {
      // The shape gate, BEFORE the lookup and before the lock: a token minted
      // by openplate-sync (`si_`) is refused here without being compared
      // against a single stored digest — and is refused as `unknown`, which is
      // exactly what an invented token gets. See `hasInviteTokenShape`.
      if (!hasInviteTokenShape(token)) return Promise.reject(new InviteRejectedError('unknown'));
      const presentedDigest = Buffer.from(inviteTokenDigest(token), 'hex');
      const at = now();
      return file.update((current) => {
        const matched = findMatchingInvite(current.invites, presentedDigest);
        if (matched === null) throw new InviteRejectedError('unknown');
        if (matched.redeemedAt !== undefined) {
          throw new InviteRejectedError('redeemed', matched.id);
        }
        if (matched.revokedAt !== undefined) {
          throw new InviteRejectedError('revoked', matched.id);
        }
        if (Date.parse(matched.expiresAt) <= at.getTime()) {
          throw new InviteRejectedError('expired', matched.id);
        }

        const redeemed: InviteRecord = { ...matched, redeemedAt: at.toISOString() };
        return {
          next: {
            ...current,
            invites: current.invites.map((invite) =>
              invite.id === matched.id ? redeemed : invite,
            ),
          },
          result: redeemed,
        };
      });
    },
  };
}

/**
 * Finds the invite whose stored digest matches, WITHOUT short-circuiting —
 * exactly as `member-auth.ts` does, and for the same reason: `Array#find` would
 * make the time taken depend on the matching invite's position in the file,
 * which leaks across many attempts. Comparing digests (never the tokens) also
 * removes the length and prefix oracles that `===` and a raw `timingSafeEqual`
 * would give away.
 */
function findMatchingInvite(
  invites: readonly InviteRecord[],
  presentedDigest: Buffer,
): InviteRecord | null {
  let matched: InviteRecord | null = null;
  for (const invite of invites) {
    if (timingSafeEqual(Buffer.from(invite.tokenSha256, 'hex'), presentedDigest)) {
      matched = invite;
    }
  }
  return matched;
}

function buildInviteRecord(parts: {
  input: CreateInviteInput;
  id: string;
  tokenSha256: string;
  createdAt: Date;
}): InviteRecord {
  const { input, id, tokenSha256, createdAt } = parts;
  const expiresAt = new Date(createdAt.getTime() + input.ttlHours * 3_600_000).toISOString();
  const parsed = InviteRecordSchema.safeParse({
    id,
    tokenSha256,
    memberId: input.memberId,
    dailyLimit: input.dailyLimit,
    expiresAt,
    createdAt: createdAt.toISOString(),
    ...(input.email === undefined ? {} : { email: input.email }),
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    // Names the FIELD, never the value: `email` is personal data and must not
    // be echoed into an error a client can read.
    throw new Error(`Invalid invite: ${details}`);
  }
  return parsed.data;
}
