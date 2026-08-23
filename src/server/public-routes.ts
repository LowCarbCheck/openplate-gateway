/**
 * The two endpoints a client may call with no credential at all.
 *
 * ── `POST /v1/invites/redeem` — ONE FAILURE, WHATEVER WENT WRONG ────────────
 * Unknown token, expired invite, already-redeemed invite, revoked invite: all
 * four answer 400 with a byte-identical body. This is the same discipline as
 * `member-auth.ts` and it matters more here, because the endpoint is
 * unauthenticated by definition — it is the ONLY way in, so it is the thing
 * anybody probing this gateway will find first. Distinguishing the four would
 * turn it into an oracle: "already redeemed" confirms a token existed, and
 * "expired" confirms it existed and narrows when it was issued.
 *
 * THE REAL REASON IS LOGGED SERVER-SIDE, AT INFO. A self-hosting operator whose
 * family member says "the link does not work" needs to know whether it lapsed or
 * was already used, and the log is the one channel an attacker cannot read. The
 * line carries the reason and the invite id — never the presented token, and
 * never the email.
 *
 * ── THE ORDER OF THE TWO WRITES ─────────────────────────────────────────────
 * The invite is claimed FIRST, in its own atomic critical section, and the
 * member is created after. The reverse order is tempting — create the member,
 * then burn the invite, so a crash between them leaves a usable invite rather
 * than a lost one — and it is wrong: a crash between them in THAT order leaves a
 * live invite that has already produced a member, and the second redemption
 * produces a second one. One lost invite costs an operator thirty seconds. An
 * invite that mints members repeatedly is an unbounded spend.
 *
 * ── `GET /v1/gateway/info` — DELIBERATELY UNAUTHENTICATED ───────────────────
 * It is what a client reads while showing the "connect to this gateway" screen,
 * before it has a token to authenticate with. Everything in it is already known
 * to anyone holding an invite link, and none of it names a member.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { asyncHandler } from './async-handler.js';
import { badRequest } from '../errors.js';
import { InviteRejectedError, type InviteStore } from '../invite-store.js';
import type { Logger } from '../logger.js';
import { MemberConflictError, type MemberStore } from '../member-store.js';
import { memberTokenDigest, mintMemberToken } from '../tokens.js';
import { SERVICE_VERSION } from '../version.js';

/**
 * The ONE sentence every rejected redemption gets. A constant rather than four
 * call sites so it cannot drift apart by accident — the whole property is that
 * the four responses are identical.
 */
const REDEEM_REJECTION_MESSAGE =
  'This invite cannot be used. It may have expired, already been used, or been withdrawn. Ask for a new one.';

const RedeemBodySchema = z.object({
  inviteToken: z.string().min(1),
});

/**
 * Every request that gets as far as this endpoint with a syntactically valid
 * body ends in the same 400 unless it fully succeeds — including a malformed
 * body, which would otherwise be a fifth distinguishable answer telling a
 * prober what shape the field takes.
 */
function rejectRedeem(): never {
  throw badRequest(REDEEM_REJECTION_MESSAGE);
}

/**
 * ONE derivation, used by both endpoints. A constant would drift; two
 * expressions would drift more slowly and less visibly. `gatewayMode` is the
 * authority — `loadConfig` is what guarantees an `org` mode always carries an
 * audit block.
 */
function isAuditEnabled(config: Config): boolean {
  return config.gatewayMode === 'org';
}

export interface PublicRoutesDeps {
  readonly config: Config;
  readonly members: MemberStore;
  readonly invites: InviteStore;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function createPublicRoutes(deps: PublicRoutesDeps): Router {
  const { config, members, invites, logger, now } = deps;
  const router = Router();

  router.get('/v1/gateway/info', (_req: Request, res: Response) => {
    res.status(200).json({
      name: config.gatewayName,
      model: config.advertisedModel,
      // DERIVED FROM THE MODE, never hardcoded. This is the field a client shows
      // a person before they connect, and it is the one that has to be true when
      // the answer is "yes, this gateway keeps your photographs" — see ADR-0003.
      auditEnabled: isAuditEnabled(config),
      version: SERVICE_VERSION,
    });
  });

  router.post(
    '/v1/invites/redeem',
    asyncHandler(async (req, res) => {
      const parsed = RedeemBodySchema.safeParse(req.body);
      if (!parsed.success) {
        logger.info('Invite redemption rejected', { reason: 'malformed body' });
        rejectRedeem();
      }

      const claimed = await claimInvite({ invites, logger, token: parsed.data.inviteToken });

      const token = mintMemberToken();
      const redeemedAt = now().toISOString();
      let memberId: string;
      try {
        const member = await members.create({
          id: claimed.memberId,
          tokenSha256: memberTokenDigest(token),
          dailyLimit: claimed.dailyLimit,
          mode: config.gatewayMode,
          // The moment this person accepted this gateway's terms, in this mode.
          // It is what makes a later mode flip a re-consent rather than a
          // silent re-interpretation of an old agreement.
          consentAt: redeemedAt,
        });
        memberId = member.id;
      } catch (error) {
        // The invite is already burnt. This is reachable when a member with the
        // same id appeared between the invite being issued and being redeemed —
        // an operator race, not a client fault. It is LOUD in the log and
        // indistinguishable outside: an id-collision oracle would let anyone
        // holding an invite enumerate the roster.
        if (error instanceof MemberConflictError) {
          logger.error('Invite was valid but the member could not be created', {
            inviteId: claimed.id,
            memberId: claimed.memberId,
            reason: 'member id already taken',
          });
          rejectRedeem();
        }
        throw error;
      }

      logger.info('Invite redeemed', { inviteId: claimed.id, memberId });
      res.status(200).json({
        memberId,
        // Shown once. Not stored, not recoverable, not logged.
        memberToken: token,
        gateway: {
          name: config.gatewayName,
          model: config.advertisedModel,
          // The SAME derivation as `/v1/gateway/info`, and it matters more here:
          // this is the response to the request that created the member, and
          // `consentAt` above records that they accepted this answer.
          auditEnabled: isAuditEnabled(config),
        },
      });
    }),
  );

  return router;
}

/**
 * Claims the invite and translates every rejection into the one client-visible
 * failure, logging the real reason on the way past.
 */
async function claimInvite(parts: {
  invites: InviteStore;
  logger: Logger;
  token: string;
}): Promise<{ id: string; memberId: string; dailyLimit: number }> {
  const { invites, logger, token } = parts;
  try {
    const invite = await invites.redeem(token);
    return { id: invite.id, memberId: invite.memberId, dailyLimit: invite.dailyLimit };
  } catch (error) {
    if (error instanceof InviteRejectedError) {
      logger.info('Invite redemption rejected', {
        reason: error.reason,
        inviteId: error.inviteId ?? null,
      });
      rejectRedeem();
    }
    throw error;
  }
}
