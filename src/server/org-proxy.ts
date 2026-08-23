/**
 * `POST /v1/chat/completions` — THE ORG-MODE HANDLER. The audited twin of
 * `proxy.ts`, and the only handler in this service that stores anything.
 *
 * ── WHY THIS IS A SEPARATE FILE AND NOT AN `if (audit)` IN `proxy.ts` ───────
 * Because the family-mode guarantee has to be structural. An `if` inside the
 * family handler means the storing code is in the same function as the
 * non-storing one, one inverted condition away from running on a household's
 * plate photographs — and a reviewer checking "does family mode store anything?"
 * would have to reason about a branch instead of reading a wiring line.
 * `create-app.ts` picks ONE of the two handlers, once, from `config.gatewayMode`.
 * A family gateway never constructs this closure at all.
 *
 * The price is real and is paid on purpose: the quota table, the two undici
 * timeout sites and the relay logic below are DUPLICATED from `proxy.ts` rather
 * than shared. Sharing them would mean editing `proxy.ts` — the file whose
 * behaviour must not move when org mode ships — every time this one changes.
 * See ADR-0003, "structural guards".
 *
 * ── WHAT IT DOES DIFFERENTLY, AND ONLY THIS ─────────────────────────────────
 *  1. It BUFFERS the request body against `AUDIT_MAX_BODY_BYTES` and refuses
 *     over-cap bodies with a 413 BEFORE the upstream call and before anything is
 *     stored.
 *  2. It captures the response text while relaying it, without delaying a byte.
 *  3. AFTER the member has their answer, it writes the audit record — images to
 *     the bucket, one row to the JSONL log — and a failure there is logged and
 *     dropped. THE AUDIT NEVER GATES, DELAYS OR FAILS THE AI CALL. An org
 *     gateway whose bucket is down keeps answering; the trail gets a gap, and
 *     that trade is stated in ADR-0003 rather than hidden here.
 *
 * ── STREAMED RESPONSES: `responseText` IS `null` ────────────────────────────
 * The family path pipes the upstream body straight through so `stream: true`
 * really streams, and this path keeps that byte-for-byte — the tee below counts
 * and collects as chunks pass, it never buffers ahead of the client. But for a
 * `text/event-stream` response we deliberately do NOT reassemble the completion
 * from its SSE frames: that means parsing a provider-specific delta format, and
 * a reassembly that is subtly wrong writes a MISQUOTATION into an audit trail
 * somebody may rely on. A `null` says "not captured", which is true; a
 * best-effort reconstruction would say something that might not be.
 *
 * ── EVERY PRIVACY RULE FROM `proxy.ts` STILL APPLIES ────────────────────────
 * Nothing here logs a body. The images go to the bucket and the response text
 * goes into the record file — those are the storage this mode exists to do —
 * and NEITHER ever reaches a log line. Upstream error bodies are still scrubbed.
 * The member's token is still never forwarded.
 */
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Agent, fetch as undiciFetch, type Response as UpstreamResponse } from 'undici';
import { z } from 'zod';
import type { AuditConfig, Config } from '../config.js';
import type { AuditLog } from '../audit/types.js';
import { readAuditableRequest } from '../audit/request-images.js';
import {
  badGateway,
  badRequest,
  gatewayTimeout,
  payloadTooLarge,
  tooManyRequests,
  unauthorized,
} from '../errors.js';
import type { Logger } from '../logger.js';
import type { QuotaStore } from '../quota/types.js';
import { utcDayKey } from '../quota/types.js';
import { describeError, scrubPayloads } from '../scrub.js';
import { openAiErrorBody } from './error-middleware.js';
import { getMemberIdentity, type MemberIdentity } from './member-auth.js';

export interface OrgProxyDeps {
  readonly config: Config;
  /** The org-mode block. Passed separately so this handler cannot be built without one. */
  readonly audit: AuditConfig;
  readonly auditLog: AuditLog;
  readonly quota: QuotaStore;
  readonly logger: Logger;
  /** Injectable so a test can freeze the UTC day boundary the quota keys on. */
  readonly now?: () => Date;
}

/** undici's codes for "the socket was open and nothing arrived in time". Mirrors `proxy.ts`. */
const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 5;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;
const MAX_UPSTREAM_ERROR_BYTES = 4096;

/**
 * 1 MiB of captured response text. A completion is kilobytes; anything past this
 * is not an answer we can meaningfully store, and holding it would put a second
 * megabyte-scale buffer beside the request we are already holding. Over the cap,
 * `responseText` is `null` — a truncated answer in an audit trail is a
 * misquotation, and this file refuses to write one.
 */
const MAX_RESPONSE_TEXT_BYTES = 1_048_576;

/** SSE. The one content type whose frames we deliberately do not reassemble — see the module header. */
const EVENT_STREAM_TYPE = 'text/event-stream';

const AnyJsonObjectSchema = z.looseObject({});

function requestsStreaming(body: unknown): boolean {
  const parsed = z.looseObject({ stream: z.boolean().default(false) }).safeParse(body);
  return parsed.success ? parsed.data.stream : false;
}

function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  // SAFETY: `'code' in value` was just checked on a non-null object. The
  // assertion claims the property is PRESENT and says nothing about its type.
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** `fetch` reports every transport failure as an opaque `TypeError` and hangs the reason off `cause`. */
function isTimeoutError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined || seen.has(current)) return false;
    seen.add(current);

    const code = errorCodeOf(current);
    if (code !== undefined && TIMEOUT_CODES.has(code)) return true;

    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY + MS_PER_DAY);
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / MS_PER_SECOND));
}

interface ResponseTee {
  stream: Transform;
  total: () => number;
  /** The captured text, or `null` when it was a stream or ran past the cap. */
  text: () => string | null;
}

/**
 * Counts bytes as they flow past and — unless this is an SSE stream — keeps a
 * copy for the audit record.
 *
 * IT NEVER DELAYS A CHUNK. Each chunk is passed on in the same `transform` call
 * that records it, so the member's stream is not held up by the capture and a
 * `stream: true` completion still arrives token by token.
 */
function createResponseTee(options: { capture: boolean }): ResponseTee {
  let total = 0;
  const chunks: Buffer[] = [];
  let overflowed = false;

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      total += chunk.byteLength;
      if (options.capture && !overflowed) {
        if (total > MAX_RESPONSE_TEXT_BYTES) {
          overflowed = true;
          // Drop what was collected rather than keep a prefix: a prefix in an
          // audit record reads as the whole answer.
          chunks.length = 0;
        } else {
          chunks.push(chunk);
        }
      }
      callback(null, chunk);
    },
  });

  return {
    stream,
    total: (): number => total,
    text: (): string | null => {
      if (!options.capture || overflowed) return null;
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

export function createOrgChatCompletionsHandler(deps: OrgProxyDeps): RequestHandler {
  const { config, audit, auditLog, quota, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const upstreamUrl = `${config.upstreamBaseUrl}/chat/completions`;

  /** ONE dispatcher for the life of the handler — an `Agent` owns the connection pool. */
  const dispatcher = new Agent({
    headersTimeout: config.upstreamTimeoutMs,
    bodyTimeout: config.upstreamTimeoutMs,
  });

  async function releaseQuietly(memberId: string, day: string): Promise<void> {
    try {
      await quota.release(memberId, day);
    } catch (error) {
      logger.warn('Could not release a quota reservation', {
        memberId,
        day,
        error: describeError(error),
      });
    }
  }

  /**
   * The audit write. Called WITHOUT `await` from the request path, and its
   * failure never becomes the member's.
   *
   * The log line on failure carries sizes and ids only — the images are exactly
   * what we are not allowed to put in a log, and an S3 error message routinely
   * quotes the request it rejected.
   */
  function recordQuietly(input: {
    body: unknown;
    ts: string;
    memberId: string;
    requestId: string;
    responseText: string | null;
  }): void {
    void (async (): Promise<void> => {
      const { model, images } = readAuditableRequest(input.body);
      try {
        await auditLog.record({
          ts: input.ts,
          memberId: input.memberId,
          requestId: input.requestId,
          model,
          images,
          responseText: input.responseText,
        });
      } catch (error) {
        logger.error('Audit record could not be written; the completion was already served', {
          memberId: input.memberId,
          requestId: input.requestId,
          images: images.length,
          error: describeError(error),
        });
      }
    })();
  }

  async function proxy(req: Request, res: Response): Promise<void> {
    const startedAt = performance.now();

    // 1. Identity. `null` means the auth middleware did not run — a wiring bug.
    // Fail CLOSED.
    const identity = getMemberIdentity(req);
    if (!identity) {
      throw unauthorized('This request carried no member identity.');
    }

    // 2. THE TWO SIZE STOPS, both before anything is forwarded and before
    // anything is stored. `create-app.ts` has already capped the body parser at
    // the smaller of `MAX_REQUEST_BYTES` and `AUDIT_MAX_BODY_BYTES`, which
    // refuses an oversized body while it is still on the socket; this is the
    // authoritative re-check, measured on exactly the bytes we would forward.
    const parsedBody = AnyJsonObjectSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw badRequest('Request body must be a JSON object.');
    }
    const forwardedBody = Buffer.from(JSON.stringify(req.body), 'utf8');
    if (forwardedBody.byteLength > audit.maxBodyBytes) {
      // Nothing forwarded, nothing reserved, nothing stored.
      throw payloadTooLarge(
        `Request body is ${forwardedBody.byteLength} bytes; the audit limit is ${audit.maxBodyBytes}.`,
      );
    }
    if (forwardedBody.byteLength > config.maxRequestBytes) {
      throw payloadTooLarge(
        `Request body is ${forwardedBody.byteLength} bytes; the limit is ${config.maxRequestBytes}.`,
      );
    }

    // 3. Reserve BEFORE the upstream call — see `proxy.ts` for why counting
    // afterwards has a window N parallel requests all pass through.
    const requestedAt = now();
    const day = utcDayKey(requestedAt);
    const reservation = await quota.reserve(identity.memberId, day, identity.dailyLimit);
    if (!reservation.ok) {
      const resetAt = nextUtcMidnight(requestedAt);
      throw tooManyRequests(
        `Daily quota spent: ${reservation.used} of ${reservation.limit} requests used. ` +
          `It resets at ${resetAt.toISOString()}.`,
        secondsUntil(resetAt, requestedAt),
      );
    }

    const requestId = randomUUID();
    const auditTs = requestedAt.toISOString();

    // 4. Forward. Headers are BUILT, never copied — the member's token never
    // leaves this process and the payer's key never leaves this line.
    let upstream: UpstreamResponse;
    try {
      upstream = await undiciFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': req.header('content-type') ?? 'application/json',
          Authorization: `Bearer ${config.upstreamApiKey}`,
        },
        body: forwardedBody,
        dispatcher,
      });
    } catch (error) {
      // TIMEOUT SITE 1 of 2 — `headersTimeout` and every connect-level failure.
      // Nothing was served to us, so the reservation goes back. NOTHING IS
      // AUDITED EITHER: no completion happened, so there is nothing to audit.
      await releaseQuietly(identity.memberId, day);
      const timedOut = isTimeoutError(error);
      logger.warn('Upstream call failed before any response', {
        memberId: identity.memberId,
        tokenFingerprint: identity.tokenFingerprint,
        requestId,
        timedOut,
        requestBytes: forwardedBody.byteLength,
        durationMs: Math.round(performance.now() - startedAt),
        error: describeError(error),
      });
      if (timedOut) {
        throw gatewayTimeout(
          `The upstream provider did not answer within ${config.upstreamTimeoutMs} ms.`,
        );
      }
      throw badGateway('The upstream provider could not be reached.');
    }

    // 5. Same money table as `proxy.ts`: a 4xx means the provider REFUSED the
    // request, so the unit goes back; a 5xx means it accepted and then failed.
    if (upstream.status >= 400 && upstream.status < 500) {
      await releaseQuietly(identity.memberId, day);
    }

    if (!upstream.ok) {
      // A REFUSED REQUEST IS NOT AUDITED. No completion was produced, so there
      // is no answer to record, and storing the images of a request the provider
      // threw away would keep photographs the member never got a result for.
      await relayUpstreamError({
        upstream,
        res,
        identity,
        requestId,
        startedAt,
        requestBytes: forwardedBody.byteLength,
      });
      return;
    }

    // 6. Relay, piped, with the tee. Nothing buffers ahead of the client.
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Quota-Used', String(reservation.used));
    res.setHeader('X-Quota-Limit', String(reservation.limit));
    // The id the audit record is filed under, so a member (or an admin helping
    // one) can name the request they are asking about. It is a random UUID: it
    // identifies a row, and reveals nothing about the row's contents.
    res.setHeader('X-Audit-Request-Id', requestId);

    const isEventStream = (contentType ?? '').includes(EVENT_STREAM_TYPE);
    const tee = createResponseTee({ capture: !isEventStream });
    let relayFailed: unknown = null;
    try {
      if (!upstream.body) throw new Error('upstream response had no body');
      await pipeline(Readable.fromWeb(upstream.body), tee.stream, res);
    } catch (error) {
      // TIMEOUT SITE 2 of 2 — `bodyTimeout` lands here, after `fetch()` already
      // resolved 200. NO RELEASE: the provider ran the request and is billing.
      relayFailed = error;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    if (relayFailed !== null) {
      logger.error('Relay of the upstream response failed', {
        memberId: identity.memberId,
        tokenFingerprint: identity.tokenFingerprint,
        requestId,
        upstreamStatus: upstream.status,
        timedOut: isTimeoutError(relayFailed),
        responseBytes: tee.total(),
        durationMs,
        error: describeError(relayFailed),
      });
      // A TRUNCATED RELAY IS STILL AUDITED. The provider ran the request, the
      // member was charged for it, and the images were submitted — an audit
      // trail that skipped exactly the failed requests would be missing the rows
      // an auditor most wants. `responseText` is whatever arrived, or `null`.
      recordQuietly({
        body: req.body,
        ts: auditTs,
        memberId: identity.memberId,
        requestId,
        responseText: tee.text(),
      });
      res.destroy();
      return;
    }

    logger.info('Proxied a completion', {
      memberId: identity.memberId,
      tokenFingerprint: identity.tokenFingerprint,
      requestId,
      upstreamStatus: upstream.status,
      streaming: requestsStreaming(req.body),
      requestBytes: forwardedBody.byteLength,
      responseBytes: tee.total(),
      quotaUsed: reservation.used,
      quotaLimit: reservation.limit,
      durationMs,
    });

    // 7. THE AUDIT WRITE, LAST AND UNAWAITED. The member already has every byte
    // of their answer by the time this starts.
    recordQuietly({
      body: req.body,
      ts: auditTs,
      memberId: identity.memberId,
      requestId,
      responseText: tee.text(),
    });
  }

  /** A non-2xx upstream answer, relayed with its status and a SCRUBBED body. Mirrors `proxy.ts`. */
  async function relayUpstreamError(context: {
    upstream: UpstreamResponse;
    res: Response;
    identity: MemberIdentity;
    requestId: string;
    startedAt: number;
    requestBytes: number;
  }): Promise<void> {
    const { upstream, res, identity } = context;

    let rawBody: string;
    try {
      rawBody = (await upstream.text()).slice(0, MAX_UPSTREAM_ERROR_BYTES);
    } catch (error) {
      rawBody = isTimeoutError(error)
        ? 'the provider stopped sending its error body'
        : 'the provider sent an unreadable error body';
    }
    const scrubbed = scrubPayloads(rawBody);

    logger.warn('Upstream provider returned an error', {
      memberId: identity.memberId,
      tokenFingerprint: identity.tokenFingerprint,
      requestId: context.requestId,
      upstreamStatus: upstream.status,
      requestBytes: context.requestBytes,
      responseBytes: Buffer.byteLength(rawBody, 'utf8'),
      durationMs: Math.round(performance.now() - context.startedAt),
      upstreamError: scrubbed,
    });

    res.status(upstream.status).json(
      openAiErrorBody({
        message: `The upstream provider answered ${upstream.status}: ${scrubbed}`,
        type: upstream.status >= 500 ? 'api_error' : 'invalid_request_error',
        code: 'upstream_error',
      }),
    );
  }

  /** Express 4 does not catch a rejected promise from a handler — every path goes through here. */
  return function handleOrgChatCompletions(req: Request, res: Response, next: NextFunction): void {
    void (async (): Promise<void> => {
      try {
        await proxy(req, res);
      } catch (error) {
        next(error);
      }
    })();
  };
}
