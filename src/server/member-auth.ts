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
 *
 * ── TWO THINGS ADR-0002 ADDED ───────────────────────────────────────────────
 *
 * 1. THE REGISTRY IS READ PER REQUEST, from the member store, rather than
 *    captured once at boot. That is the whole point of the store: a revocation
 *    takes effect on the next call instead of the next restart. A revoked
 *    member is rejected with the SAME sentence as an unknown token, after the
 *    same full-scan comparison — "revoked" and "never existed" must be
 *    indistinguishable, or a former member's token becomes an oracle for
 *    whether they were ever a member.
 *
 * 2. A MODE MISMATCH IS A 403, AND IT IS DELIBERATELY DISTINGUISHABLE. Every
 *    member record is stamped with the gateway's privacy mode at the time they
 *    joined. If the operator later flips the gateway into a different mode, the
 *    old members are refused with `reconsent_required` — the one place this
 *    file answers something other than "no". It tells a legitimate member their
 *    token is real but needs re-issuing, which is exactly what they need to
 *    hear; it also confirms token validity to whoever holds it, which is the
 *    price. That price is only paid after a mode flip an operator performed on
 *    purpose, and the alternative — silently applying a new data policy to
 *    people who agreed to the old one — is not a trade worth making.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../errors.js';
import type { GatewayMode, MemberDirectory, MemberRecord } from '../member-store.js';

/** Length of the logged token fingerprint. Enough to tell members apart, useless for guessing. */
const TOKEN_FINGERPRINT_LENGTH = 8;

/**
 * One sentence for absent, malformed AND unknown tokens. Distinguishing them
 * tells an attacker which guesses were close — "malformed" vs "unknown" already
 * confirms the shape of a valid token, and a distinct "unknown member" confirms
 * that the presented value parsed as a credential.
 */
const REJECTION_MESSAGE = 'Invalid member token. Send `Authorization: Bearer <your token>`.';

/**
 * The machine-readable marker a client keys on to send the member back through
 * an invite. Deliberately NOT the OpenAI error envelope every other failure
 * uses: an OpenAI-compatible client is expected to surface `error.message` to a
 * user and give up, and this is the one failure that has a next step. A flat,
 * unambiguous discriminator is what a client can branch on without parsing
 * prose.
 */
export const RECONSENT_REQUIRED_BODY = { error: 'reconsent_required' } as const;

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
  members: readonly MemberRecord[],
  presentedDigest: Buffer,
): MemberRecord | null {
  let matched: MemberRecord | null = null;
  for (const member of members) {
    if (timingSafeEqual(Buffer.from(member.tokenSha256, 'hex'), presentedDigest)) {
      matched = member;
    }
  }
  return matched;
}

export interface CreateMemberAuthOptions {
  directory: MemberDirectory;
  /** The gateway's current mode. A member stamped with another one is refused — see the module header. */
  gatewayMode: GatewayMode;
}

/**
 * Rejects with `401` unless the request carries a token belonging to an ACTIVE
 * member of the store, and with `403` when that member's mode no longer matches
 * the gateway's. On success the resolved `MemberIdentity` is stashed for
 * `getMemberIdentity`; nothing is written onto `req`.
 *
 * The store read is per request. For a household roster that is one small file
 * read behind an in-process lock, which is nothing next to the upstream call it
 * gates — and it is what buys revocation-without-restart. Caching it would put
 * a staleness window on exactly the operation that must not have one.
 */
export function createMemberAuth(options: CreateMemberAuthOptions): RequestHandler {
  const { directory, gatewayMode } = options;

  async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const presented = parseBearerHeader(req.header('authorization'));
    if (presented === null) {
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    const presentedDigest = digest(presented);

    let members: readonly MemberRecord[];
    try {
      members = await directory.all();
    } catch (error) {
      // An unreadable store is a server fault, not a bad credential. It reaches
      // the error middleware, which renders a 500 and says nothing about why.
      next(error);
      return;
    }

    const member = findMatchingMember(members, presentedDigest);
    // Unknown and revoked collapse into one answer, AFTER the same full scan.
    // Filtering revoked members out before the scan would make them cheaper to
    // reject, which is the timing oracle this avoids.
    if (member === null || member.revokedAt !== undefined) {
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    if (member.mode !== gatewayMode) {
      res.status(403).json(RECONSENT_REQUIRED_BODY);
      return;
    }

    identityByRequest.set(req, {
      memberId: member.id,
      dailyLimit: member.dailyLimit,
      tokenFingerprint: presentedDigest.toString('hex').slice(0, TOKEN_FINGERPRINT_LENGTH),
    });
    next();
  }

  return function requireMemberToken(req: Request, res: Response, next: NextFunction): void {
    // `void` rather than a `.catch(next)` chain: every rejection is already
    // handled inside `authenticate`, and a second `next` call from a promise
    // callback is how a double-response bug gets written.
    void authenticate(req, res, next);
  };
}
