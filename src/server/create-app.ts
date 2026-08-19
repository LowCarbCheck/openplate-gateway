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
 *  4. AUTH, then RATE LIMIT. This order costs one hash per rejected request and
 *     buys per-MEMBER limiting: a limiter in front of auth can only key on IP,
 *     and every member behind one household NAT shares an IP.
 *
 *  5. THE ROUTE, then 404, then the error middleware LAST. Express only reaches
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
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { MemberRegistry } from '../members.js';
import type { QuotaStore } from '../quota/types.js';
import { createCors } from './cors.js';
import { createErrorMiddleware, handleNotFound } from './error-middleware.js';
import { createMemberAuth } from './member-auth.js';
import { createChatCompletionsHandler } from './proxy.js';
import { createRateLimit } from './rate-limit.js';

export interface AppDeps {
  readonly config: Config;
  readonly registry: MemberRegistry;
  readonly quota: QuotaStore;
  readonly logger: Logger;
  /** Injectable clock, threaded to both the daily quota key and the per-minute limiter. */
  readonly now?: () => Date;
}

export function createApp(deps: AppDeps): Express {
  const { config, registry, quota, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());

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
  app.use(express.json({ limit: config.maxRequestBytes }));

  // 4. Auth, then the per-member burst limiter.
  app.use(createMemberAuth(registry));
  app.use(createRateLimit({ perMinute: config.rateLimitPerMinute, now: () => now().getTime() }));

  // 5. The one route.
  app.post('/v1/chat/completions', createChatCompletionsHandler({ config, quota, logger, now }));

  app.use(handleNotFound);

  // Last, always. `createErrorMiddleware` is what renders an `HttpError` and
  // what scrubs anything else before it is logged or returned.
  const errorMiddleware: ErrorRequestHandler = createErrorMiddleware(logger);
  app.use(errorMiddleware);

  return app;
}
