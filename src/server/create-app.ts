/**
 * Composition root for the HTTP surface.
 *
 * It takes a built registry, quota store and logger rather than a config alone,
 * so the test suite can boot the REAL app against an in-memory quota store and a
 * capturing logger. Everything that reads `process.env`, opens a socket or
 * touches the filesystem lives in `main.ts`; nothing below does.
 *
 * ── THE ORDER IS THE SECURITY ───────────────────────────────────────────────
 * This is a spend endpoint. Every line of `createApp` is a `use` in a chain, and
 * moving one up or down changes who can spend the payer's money. In order:
 *
 *  1. CORS FIRST. A browser preflight (`OPTIONS`) carries no `Authorization`
 *     header — by specification. Behind the auth middleware, every preflight
 *     would 401 and the browser would report a CORS failure, which reads as
 *     "the gateway is misconfigured" rather than "you are not signed in". CORS
 *     first also means a 401 itself carries the headers, so the client can
 *     actually read the status instead of seeing an opaque network error.
 *
 *  2. `/healthcheck` BEFORE AUTH, and it touches NOTHING. A container
 *     orchestrator has no member token, so a probe behind auth reports on the
 *     token rather than on the service. It also must not read the quota store:
 *     a liveness probe that does file I/O every few seconds turns a slow disk
 *     into a restart loop, and a probe that fails because a COUNTER file is
 *     unreadable is answering a different question than the one asked.
 *
 *  3. JSON PARSING WITH THE SIZE LIMIT, before auth. The limit refuses an
 *     oversized body while it is still being read off the socket, which is the
 *     only place it can be refused cheaply. `proxy.ts` re-checks the size
 *     authoritatively on exactly the bytes it would forward.
 *
 *  4. THE UNAUTHENTICATED ROUTES (`/v1/invites/redeem`, `/v1/gateway/info`) and
 *     the ADMIN API, before member auth — necessarily, since neither caller has
 *     a member token. Both are guessing surfaces, so both sit behind an
 *     IP-keyed limiter, and that limiter is mounted ON THOSE PATHS ONLY: an IP
 *     limiter in front of the spend route would bucket a whole household behind
 *     one NAT together.
 *
 *     The admin API is mounted only if an admin token is configured. When it is
 *     not, nothing is mounted and `/admin/*` reaches the 404 at the end like any
 *     other unknown path — a 401 would confirm the surface exists.
 *
 *  5. MEMBER AUTH, then the per-member RATE LIMIT. This order costs one hash per
 *     rejected request and buys per-MEMBER limiting: a limiter in front of auth
 *     can only key on IP, and every member behind one household NAT shares one.
 *
 *  6. THE ROUTE, then 404, then the error middleware LAST. Express only reaches
 *     a four-argument handler after everything before it has passed an error
 *     along, so an error middleware registered early catches nothing.
 *
 * NO COOKIE MIDDLEWARE, ANYWHERE. Authentication is a bearer token and nothing
 * else. A cookie parser would make the gateway a CSRF target: a browser attaches
 * cookies to cross-site requests on its own, so a logged-in member visiting a
 * hostile page would spend their allowance without a click. Bearer tokens are
 * never attached automatically, which is why this file has no session state at
 * all.
 */
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import type { AuditLog } from '../audit/types.js';
import type { Config } from '../config.js';
import type { InviteStore } from '../invite-store.js';
import type { Logger } from '../logger.js';
import type { Mailer } from '../mail/mailer.js';
import type { MemberStore } from '../member-store.js';
import type { QuotaStore } from '../quota/types.js';
import { createAdminAuth } from './admin-auth.js';
import { createAdminRoutes } from './admin-routes.js';
import { createAdminUiRoutes } from './admin-ui.js';
import { createCors } from './cors.js';
import { createErrorMiddleware, handleNotFound } from './error-middleware.js';
import { createMemberAuth } from './member-auth.js';
import { createOrgChatCompletionsHandler } from './org-proxy.js';
import { createChatCompletionsHandler } from './proxy.js';
import { createPublicRoutes } from './public-routes.js';
import { createRateLimit, remoteAddressKey } from './rate-limit.js';

export interface AppDeps {
  readonly config: Config;
  readonly members: MemberStore;
  readonly invites: InviteStore;
  readonly quota: QuotaStore;
  readonly mailer: Mailer;
  readonly logger: Logger;
  /** Injectable clock, threaded to both the daily quota key and the per-minute limiter. */
  readonly now?: () => Date;
  /**
   * REQUIRED IN ORG MODE, AND MUST BE ABSENT OTHERWISE. It is what the org
   * handler and the audit endpoints are built from; `main.ts` constructs it only
   * when `config.audit !== null`. See step 7 below.
   */
  readonly audit?: AuditLog | null;
}

export function createApp(deps: AppDeps): Express {
  const { config, members, invites, quota, mailer, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const audit = selectAudit(config, deps.audit ?? null);

  const app = express();
  // No `X-Powered-By`: it names the framework and version to anyone scanning.
  app.disable('x-powered-by');
  // No ETag either. Responses here are relayed model output, and a 304 on a
  // completion would hand a member a cached answer they still paid for.
  app.disable('etag');

  // 1. CORS — before auth, so preflights and 401s both carry the headers.
  app.use(createCors(config.corsAllowedOrigins));

  // 2. Liveness. No auth, no quota store, no upstream call — it answers "is this
  // process alive", and nothing else, so it cannot fail for a reason unrelated
  // to the question.
  app.get('/healthcheck', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // 3. Body parsing with the size limit as a stream-level stop.
  //
  // The parser's own failures (`entity.too.large`, `entity.parse.failed`) are
  // NOT translated here: `createErrorMiddleware` recognises both and renders
  // them in the same OpenAI error envelope as everything else. That matters for
  // more than tidiness — body-parser's JSON error message quotes the fragment
  // it choked on, which for this service is a slice of a plate photograph, and
  // there is exactly one place that string is allowed to be discarded.
  //
  // IN ORG MODE THE LIMIT IS THE SMALLER OF THE TWO BOUNDS. The org handler
  // BUFFERS the body to audit it, so `AUDIT_MAX_BODY_BYTES` is a memory bound as
  // well as a policy one, and it must be refused on the socket rather than after
  // the whole thing is in this process.
  app.use(express.json({ limit: bodyLimitFor(config) }));

  // 4. THE UNAUTHENTICATED ROUTES, BEFORE MEMBER AUTH — necessarily.
  //
  // A person redeeming an invite has no member token yet; that is the entire
  // point of an invite. A client reading `/v1/gateway/info` is drawing the
  // "connect to this gateway" screen and has nothing to send either. Mounted
  // behind `createMemberAuth` both would 401 forever.
  //
  // They are IP-rate-limited, because both are guessing surfaces for an
  // unauthenticated caller and an IP is the only thing that identifies one.
  //
  // SCOPED TO THESE PATHS, NEVER GLOBAL. An IP limiter in front of
  // `/v1/chat/completions` would put an entire household behind one NAT into a
  // single bucket — the exact unfairness `rate-limit.ts` exists to avoid, and it
  // would silently halve a family's throughput the moment two people photograph
  // lunch at once.
  const unauthenticatedRateLimit = createRateLimit({
    perMinute: config.rateLimitPerMinute,
    now: () => now().getTime(),
    keyOf: remoteAddressKey,
  });
  app.use(['/v1/invites', '/v1/gateway', '/admin'], unauthenticatedRateLimit);
  app.use(createPublicRoutes({ config, members, invites, logger, now }));

  // 5. THE ADMIN API, or nothing at all.
  //
  // `createAdminRoutes` returns `null` when no admin token is configured, and
  // nothing is mounted — so `/admin/members` reaches the 404 below exactly as
  // any other unknown path does. A 401 there would confirm the surface exists.
  //
  // Rate limit BEFORE auth: what is worth limiting is guesses at the admin
  // token, and a limiter behind the auth it protects never sees one. The IP
  // limiter mounted in step 4 already covers this path.
  const adminRoutes = createAdminRoutes({
    config,
    members,
    invites,
    mailer,
    logger,
    now,
    // `null` in family mode, which leaves `/admin/audit` unmounted rather than
    // forbidden — see `audit-routes.ts`.
    audit: audit === null ? null : audit.log,
  });
  if (adminRoutes !== null && config.adminToken !== null) {
    // THE PAGE IS SERVED BEFORE THE BEARER AUTH, AND ONLY HERE.
    //
    // A browser cannot attach an `Authorization` header to a navigation, so
    // `/admin/ui` behind `createAdminAuth` would be a page nobody could ever
    // open. It is not a hole: the document holds no data, renders a token form
    // until one is entered, and every call it then makes goes through the auth
    // below like any other admin request.
    //
    // It sits INSIDE this branch so its existence is decided by the same
    // condition as the API's — on a gateway with no admin token, `/admin/ui`
    // falls to the terminator below and 404s exactly like `/admin/members`.
    app.use(
      '/admin',
      createAdminUiRoutes(config.language),
      createAdminAuth({ adminToken: config.adminToken, logger }),
      adminRoutes,
    );
  } else {
    // NOT just "leave it unmounted". Everything below this line is behind member
    // auth, so an unmounted `/admin` would fall through to `createMemberAuth`
    // and answer 401 — and a 401 is precisely the "there is something here"
    // signal the 404 exists to withhold. The explicit terminator answers the
    // ordinary unknown-endpoint 404 to EVERY caller, credentialed or not,
    // before any authentication runs.
    app.use('/admin', handleNotFound);
  }

  // 6. Member auth, then the per-MEMBER burst limiter.
  app.use(createMemberAuth({ directory: members, gatewayMode: config.gatewayMode }));
  app.use(createRateLimit({ perMinute: config.rateLimitPerMinute, now: () => now().getTime() }));

  // 7. THE ONE SPEND ROUTE, AND THE ONE PLACE THE MODE IS CHOSEN.
  //
  // This is the single line that decides whether anything is ever stored. The
  // two handlers are separate modules with no shared branch: a family gateway
  // never constructs the audited one, so there is no condition inside a request
  // path that could be inverted, mis-ordered or made truthy by a stray config
  // value. See ADR-0003 and `org-proxy.ts`'s header.
  app.post(
    '/v1/chat/completions',
    audit === null
      ? createChatCompletionsHandler({ config, quota, logger, now })
      : createOrgChatCompletionsHandler({
          config,
          audit: audit.settings,
          auditLog: audit.log,
          quota,
          logger,
          now,
        }),
  );

  // 8. Unknown paths, then the error middleware.
  app.use(handleNotFound);

  // Last, always. `createErrorMiddleware` is what renders an `HttpError` and
  // what scrubs anything else before it is logged or returned.
  const errorMiddleware: ErrorRequestHandler = createErrorMiddleware(logger);
  app.use(errorMiddleware);

  return app;
}

/** What the org-mode wiring needs, or `null` for a family gateway. */
interface SelectedAudit {
  readonly log: AuditLog;
  readonly settings: NonNullable<Config['audit']>;
}

/**
 * Resolves the mode ONCE, and refuses both mismatches loudly.
 *
 * An org config with no audit log would boot a gateway that promises an audit
 * trail and writes none — the worst of the three states, because the member
 * consented on the promise. An audit log handed to a family config is a wiring
 * mistake in the other direction, and silently ignoring it would leave whoever
 * made it believing images are being kept.
 */
function selectAudit(config: Config, audit: AuditLog | null): SelectedAudit | null {
  if (config.audit === null) {
    if (audit !== null) {
      throw new Error(
        'An audit log was supplied to a family-mode gateway. Set ORG_MODE=true or remove it.',
      );
    }
    return null;
  }
  if (audit === null) {
    throw new Error('ORG_MODE=true, but no audit log was supplied to createApp.');
  }
  return { log: audit, settings: config.audit };
}

/**
 * The body-parser limit. In org mode the audit cap applies as well, and the
 * SMALLER of the two wins: the handler buffers what it audits, so the cap is a
 * memory bound and must be enforced while the body is still on the socket.
 */
function bodyLimitFor(config: Config): number {
  if (config.audit === null) return config.maxRequestBytes;
  return Math.min(config.maxRequestBytes, config.audit.maxBodyBytes);
}
