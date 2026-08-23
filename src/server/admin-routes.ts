/**
 * The operator's API: the roster, and the invites that fill it.
 *
 * ── 404 WHEN THERE IS NO ADMIN TOKEN, NOT 401 ───────────────────────────────
 * `createAdminRoutes` returns `null` when `config.adminToken` is `null`, and
 * `create-app.ts` then mounts nothing at all — so `/admin/members` falls through
 * to the same 404 as `/wp-admin`. A 401 would confirm that an admin surface
 * exists on this host and is merely locked, which is an invitation to come back
 * with a wordlist. A family gateway that never configured an admin token should
 * be indistinguishable, from outside, from one that never had the feature.
 *
 * ── NO ENDPOINT EVER RETURNS A TOKEN OR A DIGEST ────────────────────────────
 * With exactly two exceptions, both of which are the moment of creation and
 * both of which say so: `POST /members` returns the new member token once, and
 * `POST /invites` returns the invite token and link once. Nothing else — not
 * the list endpoints, not an error — carries either. `toMemberView` and
 * `toInviteView` exist so that is enforced by a projection rather than by
 * remembering not to spread the record.
 *
 * ── COPY-LINK IS THE PRIMARY INVITE FLOW ────────────────────────────────────
 * `POST /invites` ALWAYS returns the link and the token, whether or not an email
 * was sent. Most self-hosters have no SMTP and will never configure one, and a
 * flow that only works with a mail server would make the feature unavailable to
 * them. Email is an extra: when it is configured and an address was given, the
 * mail goes out and `emailed` reports whether it worked. A failed send is NOT an
 * error — the invite exists and the operator has the link in front of them, so
 * failing the request would destroy a usable invite over a transport problem.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AuditLog } from '../audit/types.js';
import type { Config } from '../config.js';
import { asyncHandler } from './async-handler.js';
import { createAuditRoutes } from './audit-routes.js';
import { handleNotFound } from './error-middleware.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  DEFAULT_INVITE_TTL_HOURS,
  InviteNotFoundError,
  MAX_INVITE_TTL_HOURS,
  inviteStatus,
  type InviteRecord,
  type InviteStore,
} from '../invite-store.js';
import type { Logger } from '../logger.js';
import { buildInviteLink, buildInviteMessage } from '../mail/invite-message.js';
import type { Mailer } from '../mail/mailer.js';
import {
  MemberConflictError,
  MemberNotFoundError,
  type MemberRecord,
  type MemberStore,
} from '../member-store.js';
import { MEMBER_ID_MESSAGE, MEMBER_ID_PATTERN } from '../members.js';
import { memberTokenDigest, mintMemberToken } from '../tokens.js';

/**
 * A generous ceiling, not a policy. It exists so a fat-fingered `50000` is
 * caught at the moment it is typed rather than on a bill, and the gateway's real
 * spend control remains the provider-side cap that `docs/family-setup.md`
 * insists on.
 */
const MAX_DAILY_LIMIT = 10_000;

const dailyLimitSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_DAILY_LIMIT, { message: `must be at most ${MAX_DAILY_LIMIT} requests per day` });

const CreateMemberBodySchema = z.object({
  id: z.string().regex(MEMBER_ID_PATTERN, MEMBER_ID_MESSAGE),
  dailyLimit: dailyLimitSchema,
});

const CreateInviteBodySchema = z.object({
  memberId: z.string().regex(MEMBER_ID_PATTERN, MEMBER_ID_MESSAGE),
  dailyLimit: dailyLimitSchema,
  // Deliberately not `z.string().email()`: the only thing this service does
  // with the address is hand it to an SMTP server, which is a far better judge
  // of deliverability than a regex, and a rejection here would be a rejection
  // of an address that works.
  email: z.string().min(3).max(320).optional(),
  ttlHours: z
    .number()
    .int()
    .positive()
    .max(MAX_INVITE_TTL_HOURS, { message: `must be at most ${MAX_INVITE_TTL_HOURS} hours` })
    .default(DEFAULT_INVITE_TTL_HOURS),
});

/** What the roster looks like on the wire. NO digest, NO token — see the module header. */
interface MemberView {
  id: string;
  dailyLimit: number;
  createdAt: string;
  revokedAt: string | null;
  mode: string;
  consentAt: string | null;
}

function toMemberView(member: MemberRecord): MemberView {
  return {
    id: member.id,
    dailyLimit: member.dailyLimit,
    createdAt: member.createdAt,
    // `null` rather than an absent key: a client checking `revokedAt === null`
    // and a client checking `'revokedAt' in member` should not disagree.
    revokedAt: member.revokedAt ?? null,
    mode: member.mode,
    consentAt: member.consentAt ?? null,
  };
}

interface InviteView {
  id: string;
  memberId: string;
  dailyLimit: number;
  status: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  /** Present so an operator can tell two invites apart. It is the address THEY supplied. */
  email: string | null;
}

function toInviteView(invite: InviteRecord, now: Date): InviteView {
  return {
    id: invite.id,
    memberId: invite.memberId,
    dailyLimit: invite.dailyLimit,
    // Derived, not stored — see `inviteStatus`. A stored status would need a
    // sweeper to ever become `expired`, and would lie until it ran.
    status: inviteStatus(invite, now),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    redeemedAt: invite.redeemedAt ?? null,
    revokedAt: invite.revokedAt ?? null,
    email: invite.email ?? null,
  };
}

/** Turns a zod failure into the service's own 400, naming fields and never values. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw badRequest(`Invalid request: ${details}`);
}

/** Domain errors carry no HTTP status; this is the one place they acquire one. */
function toHttpError(error: unknown): unknown {
  if (error instanceof MemberConflictError) return conflict(error.message);
  if (error instanceof MemberNotFoundError) return notFound(error.message);
  if (error instanceof InviteNotFoundError) return notFound(error.message);
  return error;
}

async function rethrowAsHttp<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toHttpError(error);
  }
}

export interface AdminRoutesDeps {
  readonly config: Config;
  readonly members: MemberStore;
  readonly invites: InviteStore;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly now: () => Date;
  /**
   * The audit trail, in org mode only. `null` or absent leaves `/admin/audit`
   * UNMOUNTED, so it reaches the same 404 as any unknown path — see
   * `audit-routes.ts`.
   */
  readonly audit?: AuditLog | null;
}

/**
 * The `/admin` router, or `null` when no admin token is configured — see the
 * module header. The caller must mount NOTHING in the `null` case.
 */
export function createAdminRoutes(deps: AdminRoutesDeps): Router | null {
  const { config, members, invites, mailer, logger, now } = deps;
  if (config.adminToken === null) return null;

  const router = Router();

  // THE AUDIT ENDPOINTS, OR NOTHING AT ALL. Mounted here, inside the admin
  // router, so they inherit its auth and its rate limit; absent entirely in
  // family mode, where there is no audit trail to expose or to deny.
  const audit = deps.audit ?? null;
  if (audit !== null) {
    router.use(createAuditRoutes({ audit, logger }));
  }

  router.get(
    '/members',
    asyncHandler(async (_req, res) => {
      const all = await members.all();
      res.status(200).json({ members: all.map(toMemberView) });
    }),
  );

  router.post(
    '/members',
    asyncHandler(async (req, res) => {
      const body = parseBody(CreateMemberBodySchema, req.body);
      const token = mintMemberToken();
      const created = await rethrowAsHttp(() =>
        members.create({
          id: body.id,
          tokenSha256: memberTokenDigest(token),
          dailyLimit: body.dailyLimit,
          mode: config.gatewayMode,
        }),
      );

      logger.info('Member created', { memberId: created.id, dailyLimit: created.dailyLimit });
      res.status(201).json({
        member: toMemberView(created),
        // THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE CALLER'S PROCESS. It is
        // not stored, not recoverable, and not logged.
        token,
        tokenNote: 'Shown once. It is not stored and cannot be recovered — give it to the member now.',
      });
    }),
  );

  router.delete(
    '/members/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      const revoked = await rethrowAsHttp(() => members.revoke(id));
      logger.info('Member revoked', { memberId: revoked.id });
      res.status(200).json({ member: toMemberView(revoked) });
    }),
  );

  router.get(
    '/invites',
    asyncHandler(async (_req, res) => {
      const all = await invites.all();
      const at = now();
      res.status(200).json({ invites: all.map((invite) => toInviteView(invite, at)) });
    }),
  );

  router.post(
    '/invites',
    asyncHandler(async (req, res) => {
      const body = parseBody(CreateInviteBodySchema, req.body);

      // Checked BEFORE the invite is written. Catching it at redemption instead
      // would burn the invite on a conflict the operator could have been told
      // about here — and the person redeeming it would see the failure, not the
      // person who caused it.
      const existing = await members.all();
      if (existing.some((member) => member.id === body.memberId)) {
        throw conflict(`A member with id "${body.memberId}" already exists.`);
      }

      const { invite, token } = await invites.create({
        memberId: body.memberId,
        dailyLimit: body.dailyLimit,
        ttlHours: body.ttlHours,
        ...(body.email === undefined ? {} : { email: body.email }),
      });

      const link = buildLinkOrNull({ config, token });
      const emailed = await maybeSendInvite({
        config,
        mailer,
        logger,
        invite,
        token,
        ...(body.email === undefined ? {} : { email: body.email }),
      });

      logger.info('Invite created', {
        inviteId: invite.id,
        memberId: invite.memberId,
        dailyLimit: invite.dailyLimit,
        expiresAt: invite.expiresAt,
        emailed,
      });

      res.status(201).json({
        id: invite.id,
        memberId: invite.memberId,
        dailyLimit: invite.dailyLimit,
        expiresAt: invite.expiresAt,
        emailed,
        // ALWAYS returned — copy-link is the primary flow. `link` is null only
        // when the operator has configured no public URLs to build one from, in
        // which case the raw token is still enough to redeem by hand.
        link,
        token,
        tokenNote: 'Shown once. Send the link to the person you are inviting.',
      });
    }),
  );

  router.delete(
    '/invites/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      const revoked = await rethrowAsHttp(() => invites.revoke(id));
      logger.info('Invite revoked', { inviteId: revoked.id });
      res.status(200).json({ invite: toInviteView(revoked, now()) });
    }),
  );

  // THE ADMIN NAMESPACE TERMINATES HERE. Without this, an unmatched `/admin/...`
  // path falls out of this router into the MEMBER auth middleware below it and
  // answers 401 — which reads as "this endpoint exists and you are not signed
  // in". It matters for org mode: `/admin/audit` on a family gateway must be
  // indistinguishable from a path that was never implemented, and 404 is what
  // every other unknown path answers.
  router.use(handleNotFound);

  return router;
}

/** `null` when the operator has configured neither public URL — there is nothing to build from. */
function buildLinkOrNull(parts: { config: Config; token: string }): string | null {
  const { config, token } = parts;
  if (config.gatewayPublicUrl === null || config.clientBaseUrl === null) return null;
  return buildInviteLink({
    gatewayPublicUrl: config.gatewayPublicUrl,
    clientBaseUrl: config.clientBaseUrl,
    inviteToken: token,
  });
}

interface MaybeSendInviteParts {
  config: Config;
  mailer: Mailer;
  logger: Logger;
  invite: InviteRecord;
  token: string;
  email?: string;
}

/**
 * Sends the invite email if — and only if — an address was given AND SMTP is
 * configured AND both link halves are set. Returns whether it went out.
 *
 * NEVER THROWS. A send failure must not fail the request: the invite is already
 * created and the operator already has the link in the response, so turning a
 * transport hiccup into a 500 would destroy a working invite and teach the
 * operator to retry, creating a second one.
 */
async function maybeSendInvite(parts: MaybeSendInviteParts): Promise<boolean> {
  const { config, mailer, logger, invite, token, email } = parts;
  if (email === undefined) return false;
  if (config.smtp === null) return false;
  if (config.gatewayPublicUrl === null || config.clientBaseUrl === null) return false;

  const message = buildInviteMessage({
    gatewayName: config.gatewayName,
    gatewayPublicUrl: config.gatewayPublicUrl,
    clientBaseUrl: config.clientBaseUrl,
    inviteToken: token,
    dailyLimit: invite.dailyLimit,
    expiresAt: invite.expiresAt,
  });

  try {
    await mailer.send({
      to: email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    // The invite id, and nothing else. Not the address, not the subject, and
    // above all not the link — it carries the token.
    logger.info('Invite email sent', { inviteId: invite.id });
    return true;
  } catch {
    // The error itself is discarded rather than logged: an SMTP library's
    // message routinely quotes the envelope it was rejected on, which is the
    // recipient's address.
    logger.warn('Invite email could not be sent; the link in the response is still valid', {
      inviteId: invite.id,
    });
    return false;
  }
}
