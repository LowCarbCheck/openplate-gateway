/**
 * Bearer token authentication, resolved to a MEMBER.
 *
 * NO COOKIES, ANYWHERE — the token travels in `Authorization: Bearer <token>`,
 * so an openplate build on any origin can talk to any instance of this gateway
 * without the browser attaching anything by itself. That absence of ambient
 * credentials is also what makes the permissive CORS policy in `cors.ts` safe.
 *
 * This is `../openplate-inference/src/server/api-key-auth.ts` with one thing
 * added and everything else kept, because everything else was the security:
 *
 *  - COMPARE DIGESTS, NOT TOKENS. `===` on strings returns early at the first
 *    differing character, which is a prefix oracle an attacker can walk. And
 *    `timingSafeEqual` on the RAW buffers refuses unequal lengths — that refusal
 *    is itself a length oracle. Hashing both sides first makes every candidate
 *    exactly 32 bytes, so neither the length nor the prefix is observable.
 *  - IDENTITY LIVES IN A `WeakMap`, NOT ON `req`. Declaration-merging Express's
 *    `Request` would put `req.member` in the type system of EVERY request,
 *    including the unauthenticated ones this middleware exists to stop, and a
 *    downstream handler reading it would compile. `getMemberIdentity` returns
 *    `null`, which the caller has to handle.
 *  - ONLY A FINGERPRINT IS EVER LOGGED. Eight hex chars of the digest: enough
 *    to correlate two log lines, useless for reconstructing the token.
 *
 * What it ADDS: which member matched. The quota is per member and it guards a
 * credit card, so "some valid token" is not an answer — the request has to carry
 * an id and a daily limit onward to the limiter and the quota store.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../errors.js';
import type { Member, MemberRegistry } from '../members.js';

/** Length of the logged token fingerprint. Enough to tell members apart, useless for guessing. */
const TOKEN_FINGERPRINT_LENGTH = 8;

/**
 * One sentence for absent, malformed AND unknown tokens. Distinguishing them
 * tells an attacker which guesses were close — "malformed" vs "unknown" already
 * confirms the shape of a valid token, and a distinct "unknown member" confirms
 * that the presented value parsed as a credential.
 */
const REJECTION_MESSAGE = 'Invalid member token. Send `Authorization: Bearer <your token>`.';

export interface MemberIdentity {
  /** The `Member.id` from the registry — a constrained short label, safe to log. */
  readonly memberId: string;
  /** Requests per UTC day for this member. Carried here so the quota layer needs no second lookup. */
  readonly dailyLimit: number;
  /** First 8 hex chars of the token's SHA-256. This — never the token — is what gets logged. */
  readonly tokenFingerprint: string;
}

const identityByRequest = new WeakMap<Request, MemberIdentity>();

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** A stable, non-reversible id for a token: the first 8 hex chars of its SHA-256. */
export function tokenFingerprint(token: string): string {
  return digest(token).toString('hex').slice(0, TOKEN_FINGERPRINT_LENGTH);
}

/**
 * The member this request authenticated as, or `null` if it never passed
 * `createMemberAuth`. Downstream middleware must treat `null` as a wiring bug
 * and fail closed — see `rate-limit.ts`.
 */
export function getMemberIdentity(req: Request): MemberIdentity | null {
  return identityByRequest.get(req) ?? null;
}

/**
 * Pulls the token out of an `Authorization` header. Returns `null` for absent,
 * blank, and non-Bearer headers alike; the caller must not tell those apart in
 * what it sends back.
 */
export function parseBearerHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? '').trim() || null : null;
}

/**
 * Finds the member whose stored digest matches, WITHOUT short-circuiting.
 *
 * `Array#some` would stop at the first match, so the time this takes would
 * depend on the matching member's position in the file — which leaks, across
 * many requests, roughly which line of `members.json` a token sits on. That is
 * a small leak, but the fix is a full scan of a list with a handful of entries,
 * which costs nothing. Every candidate is compared, every time.
 */
function findMatchingMember(
  members: readonly { member: Member; digest: Buffer }[],
  presentedDigest: Buffer,
): Member | null {
  let matched: Member | null = null;
  for (const candidate of members) {
    if (timingSafeEqual(candidate.digest, presentedDigest)) {
      matched = candidate.member;
    }
  }
  return matched;
}

/**
 * Rejects with `401` unless the request carries a token belonging to a member in
 * the registry. On success the resolved `MemberIdentity` is stashed for
 * `getMemberIdentity`; nothing is written onto `req`.
 *
 * The digests are decoded from the registry's hex ONCE, at construction, so the
 * per-request work is one hash plus N fixed-size comparisons.
 */
export function createMemberAuth(registry: MemberRegistry): RequestHandler {
  const candidates = registry.members.map((member) => ({
    member,
    digest: Buffer.from(member.tokenSha256, 'hex'),
  }));

  return function requireMemberToken(req: Request, _res: Response, next: NextFunction): void {
    const presented = parseBearerHeader(req.header('authorization'));
    if (presented === null) {
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    const presentedDigest = digest(presented);
    const member = findMatchingMember(candidates, presentedDigest);
    if (member === null) {
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    identityByRequest.set(req, {
      memberId: member.id,
      dailyLimit: member.dailyLimit,
      tokenFingerprint: presentedDigest.toString('hex').slice(0, TOKEN_FINGERPRINT_LENGTH),
    });
    next();
  };
}
