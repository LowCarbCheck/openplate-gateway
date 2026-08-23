/**
 * The member store: who may spend the shared provider key, how much, under
 * which privacy mode, and whether they still may. Written at runtime — by the
 * admin API, by an invite redemption, and by `pnpm mint-token`.
 *
 * WHY THIS REPLACED A HAND-EDITED FILE (ADR-0002). Adding a family member used
 * to mean minting a token, pasting JSON into `members.json`, and restarting the
 * gateway. Restarting is the part that made revocation unusable: the one moment
 * you most want to remove somebody's access is the one moment you least want to
 * drop every in-flight request. The store is read on each authentication, so a
 * revocation takes effect on the very next call and nothing restarts.
 *
 * IT STILL HOLDS A SHA-256 DIGEST, NEVER A TOKEN. That is unchanged and
 * non-negotiable. A token is shown once — by `mint-token`, by the admin create
 * endpoint, by an invite redemption — and is not recoverable from this file. So
 * a backup, a stray `cat`, or a volume snapshot hands nobody a working
 * credential.
 *
 * REVOCATION IS A TOMBSTONE, NOT A DELETE. `revokedAt` is set and the row stays.
 * Two reasons, and the second is the one that matters:
 *
 *  - The id keeps meaning one person, so the quota counters and the log lines
 *    already written about them still resolve.
 *  - A deleted digest could be RE-ADDED — by a legacy-file merge, by an operator
 *    restoring an old `members.json`, by `mint-token` colliding. A tombstone
 *    makes "this token was revoked" a fact the store can still assert. Deleting
 *    the row would make a revoked token merely unknown, and an unknown token is
 *    one a later merge is happy to reinstate.
 *
 * EVERY RECORD CARRIES THE MODE IT WAS CREATED UNDER. `mode` is the gateway's
 * privacy posture at the moment the member joined, and `member-auth.ts` refuses
 * a member whose mode no longer matches the gateway's. An operator who flips a
 * family gateway into an audited org gateway has changed what happens to their
 * household's requests; inheriting the old members would apply a new data
 * policy to people who consented to the previous one, silently. The rejection
 * is what forces a fresh invite, and `consentAt` is what records that it
 * happened.
 *
 * `dailyLimit` DEFAULTS TO ZERO, NOT TO UNLIMITED — see `members.ts`. The other
 * default is discovered on a bill weeks later.
 *
 * SINGLE PROCESS, BY DESIGN. Mutations serialise on an in-process lock (see
 * `store/atomic-json-file.ts`). Two gateway processes pointed at one state
 * directory will lose updates to each other; that deployment needs a database,
 * not this store.
 */
import { z } from 'zod';
import {
  MEMBER_ID_MESSAGE,
  MEMBER_ID_PATTERN,
  SHA256_HEX_MESSAGE,
  SHA256_HEX_PATTERN,
  type Member,
} from './members.js';
import { createAtomicJsonFile, type AtomicJsonFile } from './store/atomic-json-file.js';

/**
 * The gateway's privacy posture, and a property of each member record.
 *
 * `org` is not reachable yet — the audit pipeline that gives it meaning is a
 * later milestone. The field exists now so that the day it lands, existing
 * members are refused rather than silently absorbed into a mode they never
 * agreed to. Adding it afterwards would mean every pre-existing row defaulting
 * into whichever mode the code happened to pick, which is the exact failure the
 * field prevents.
 */
export type GatewayMode = 'family' | 'org';

export const GATEWAY_MODES = ['family', 'org'] as const satisfies readonly GatewayMode[];

export interface MemberRecord {
  readonly id: string;
  /** 64 lowercase hex chars. The token itself is not stored anywhere. */
  readonly tokenSha256: string;
  readonly dailyLimit: number;
  readonly createdAt: string;
  /** The gateway's mode when this member was created. See the module header. */
  readonly mode: GatewayMode;
  /** Set when the member accepted an invite. Absent for members an operator minted directly. */
  readonly consentAt?: string;
  /** Set once, never cleared. An absent field means the member is active. */
  readonly revokedAt?: string;
}

const MemberRecordSchema = z.object({
  id: z.string().regex(MEMBER_ID_PATTERN, MEMBER_ID_MESSAGE),
  tokenSha256: z.string().regex(SHA256_HEX_PATTERN, SHA256_HEX_MESSAGE),
  dailyLimit: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
  // Defaulted rather than required: a row written by an older build of this
  // service predates the field, and the mode it was created under was `family`
  // — that is the only mode that existed.
  mode: z.enum(GATEWAY_MODES).default('family'),
  consentAt: z.string().min(1).optional(),
  revokedAt: z.string().min(1).optional(),
});

/**
 * The on-disk envelope.
 *
 * `version` is the seam a future migration needs. It is defaulted rather than
 * required so this build reads a file it wrote before the field existed; a
 * later build that changes the shape reads the number and knows which upgrade
 * to run, instead of guessing from which keys happen to be present.
 */
export const MEMBER_STORE_VERSION = 1;

const MemberStoreStateSchema = z.object({
  version: z.number().int().positive().default(MEMBER_STORE_VERSION),
  /** Set the first (and only) time a legacy `members.json` is folded in. */
  legacyMigratedAt: z.string().min(1).optional(),
  members: z.array(MemberRecordSchema),
});

type MemberStoreState = z.infer<typeof MemberStoreStateSchema>;

/**
 * The read side, and the ONLY thing `member-auth.ts` is given.
 *
 * Auth has no business creating or revoking anybody, and a middleware holding a
 * handle that can is a middleware one refactor away from doing it. It is also
 * what lets a test hand the real auth chain a fixed list with no filesystem.
 */
export interface MemberDirectory {
  /**
   * EVERY record, revoked ones included. Auth must compare against all of them
   * in constant time and only then decide — filtering here would make a revoked
   * member cheaper to reject than an unknown one, which is a timing oracle for
   * "this token used to work".
   */
  all(): Promise<readonly MemberRecord[]>;
}

export interface CreateMemberInput {
  id: string;
  tokenSha256: string;
  dailyLimit: number;
  mode: GatewayMode;
  /** Set by invite redemption; omitted when an operator mints a member directly. */
  consentAt?: string;
}

/** What a once-only legacy merge did, so the boot log can say something true. */
export interface LegacyMergeResult {
  /** False when the merge had already run against this store. */
  readonly migrated: boolean;
  readonly added: number;
}

export interface MergeLegacyOptions {
  readonly members: readonly Member[];
  /**
   * Runs INSIDE the store lock, immediately before the first (and only) merge —
   * the backup of the legacy file lives here. Inside the lock because a backup
   * taken outside it could run on every boot, or run and then lose the race to
   * a merge that decided it had already happened.
   */
  readonly beforeMerge?: () => Promise<void>;
}

export interface MemberStore extends MemberDirectory {
  create(input: CreateMemberInput): Promise<MemberRecord>;
  /** Sets `revokedAt`. Idempotent: revoking an already-revoked member keeps the first timestamp. */
  revoke(id: string): Promise<MemberRecord>;
  /**
   * Folds a legacy `members.json` in, AT MOST ONCE per store.
   *
   * Once-only rather than merge-on-every-boot, because the two differ exactly
   * where it hurts: an operator who revokes a legacy member and leaves the old
   * file in place would have them reinstated on the next restart. The
   * `legacyMigratedAt` stamp is what makes the second boot a no-op.
   */
  mergeLegacyOnce(options: MergeLegacyOptions): Promise<LegacyMergeResult>;
}

/** Raised when a caller asks for a member that is not there. Rendered as a 404 by the admin API. */
export class MemberNotFoundError extends Error {
  constructor(id: string) {
    super(`No member with id "${id}".`);
    this.name = 'MemberNotFoundError';
  }
}

/**
 * Raised on a duplicate id or a duplicate digest. Rendered as a 409.
 *
 * Two members sharing a token is the quiet failure: nothing errors, both
 * requests authenticate, and they silently share ONE allowance — so the
 * household's cap is half what it looks like. Duplicate ids are the same problem
 * from the other side: the quota key stops identifying one person.
 */
export class MemberConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberConflictError';
  }
}

export interface CreateFileMemberStoreOptions {
  /** Injectable clock, so `createdAt`/`revokedAt` are assertable without freezing time globally. */
  now?: () => Date;
}

export function createFileMemberStore(
  filePath: string,
  options: CreateFileMemberStoreOptions = {},
): MemberStore {
  const now = options.now ?? ((): Date => new Date());
  const file: AtomicJsonFile<MemberStoreState> = createAtomicJsonFile({
    filePath,
    schema: MemberStoreStateSchema,
    empty: () => ({ version: MEMBER_STORE_VERSION, members: [] }),
    label: 'member store',
    temporaryPrefix: 'member-store',
  });

  return {
    async all(): Promise<readonly MemberRecord[]> {
      const state = await file.read();
      return state.members;
    },

    create(input: CreateMemberInput): Promise<MemberRecord> {
      const record = buildMemberRecord(input, now());
      return file.update((current) => {
        assertNoConflict(current.members, record);
        return {
          next: { ...current, members: [...current.members, record] },
          result: record,
        };
      });
    },

    revoke(id: string): Promise<MemberRecord> {
      const revokedAt = now().toISOString();
      return file.update((current) => {
        const existing = current.members.find((member) => member.id === id);
        if (existing === undefined) throw new MemberNotFoundError(id);
        // Idempotent: a second revoke must not move the timestamp, or an audit
        // of "when did this person lose access" answers whenever it was last asked.
        const revoked: MemberRecord =
          existing.revokedAt === undefined ? { ...existing, revokedAt } : existing;
        return {
          next: {
            ...current,
            members: current.members.map((member) => (member.id === id ? revoked : member)),
          },
          result: revoked,
        };
      });
    },

    mergeLegacyOnce({ members, beforeMerge }: MergeLegacyOptions): Promise<LegacyMergeResult> {
      // The result type is pinned rather than inferred: the early-return branch
      // alone would narrow `migrated` to the literal `false`, and the second
      // branch would then fail to assign.
      return file.update<LegacyMergeResult>(async (current) => {
        if (current.legacyMigratedAt !== undefined) {
          // Already done. Rewrites the same state rather than skipping the write
          // — one extra atomic rename on a boot path, in exchange for `update`
          // having exactly one exit shape.
          return { next: current, result: { migrated: false, added: 0 } };
        }

        await beforeMerge?.();

        const mergedAt = now().toISOString();
        const byId = new Set(current.members.map((member) => member.id));
        const byDigest = new Set(current.members.map((member) => member.tokenSha256));
        const added: MemberRecord[] = [];

        for (const legacy of members) {
          // Either key already being present means the row is already
          // represented — including by a tombstone, which is therefore not
          // resurrected.
          if (byId.has(legacy.id) || byDigest.has(legacy.tokenSha256)) continue;
          const record: MemberRecord = {
            id: legacy.id,
            tokenSha256: legacy.tokenSha256,
            dailyLimit: legacy.dailyLimit,
            createdAt: mergedAt,
            // A legacy file predates modes entirely, and the only mode that
            // existed when it was written is `family`.
            mode: 'family',
          };
          added.push(record);
          byId.add(record.id);
          byDigest.add(record.tokenSha256);
        }

        return {
          next: {
            ...current,
            legacyMigratedAt: mergedAt,
            members: [...current.members, ...added],
          },
          result: { migrated: true, added: added.length },
        };
      });
    },
  };
}

/** Validates through the same schema the file is read with, so a bad input cannot be written at all. */
function buildMemberRecord(input: CreateMemberInput, at: Date): MemberRecord {
  const parsed = MemberRecordSchema.safeParse({
    id: input.id,
    tokenSha256: input.tokenSha256,
    dailyLimit: input.dailyLimit,
    createdAt: at.toISOString(),
    mode: input.mode,
    ...(input.consentAt === undefined ? {} : { consentAt: input.consentAt }),
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    // Names the FIELD, never the value — `tokenSha256` is a digest, but this
    // same message would happily carry whatever a caller put in its place.
    throw new MemberConflictError(`Invalid member: ${details}`);
  }
  return parsed.data;
}

function assertNoConflict(existing: readonly MemberRecord[], candidate: MemberRecord): void {
  if (existing.some((member) => member.id === candidate.id)) {
    throw new MemberConflictError(`A member with id "${candidate.id}" already exists.`);
  }
  if (existing.some((member) => member.tokenSha256 === candidate.tokenSha256)) {
    // Does NOT name the colliding member: the caller presented a token, and
    // telling them whose digest it matched would turn a minting collision into
    // a lookup. In practice this fires on a re-run of the same mint command.
    throw new MemberConflictError(
      'That token is already registered to a member. Mint a separate token for each member.',
    );
  }
}

/** A directory over a fixed list — for tests, and for any caller with no file. */
export function createStaticMemberDirectory(members: readonly MemberRecord[]): MemberDirectory {
  const snapshot = [...members];
  return {
    all: (): Promise<readonly MemberRecord[]> => Promise.resolve(snapshot),
  };
}
