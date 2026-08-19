/**
 * `POST /v1/chat/completions` — the proxy itself, and the only place in this
 * service where a plate photograph exists.
 *
 * WHAT IT IS. A member posts an ordinary OpenAI-compatible request with their
 * OWN token. We spend one unit of their daily allowance, swap their token for
 * the payer's real provider key, forward the body untouched, and relay the
 * answer back. The member never learns the provider key; the provider never
 * learns the member token.
 *
 * THE BODY IS A PLATE PHOTOGRAPH. It arrives here, it is serialised once, it is
 * handed to `undici`, and it is dropped when the promise settles. Nothing writes
 * it, nothing caches it, and nothing logs it — see the "never log a body" rule
 * below and `logger.ts`, whose field type will not even accept a Buffer.
 *
 * ORDER OF OPERATIONS, and every step is where it is on purpose:
 *   1. identity   — no member on the request is a WIRING bug; fail closed (401).
 *   2. size       — refuse an oversized body before it costs an upstream call.
 *   3. RESERVE    — before the call, never after. See `quota/types.ts`: counting
 *                   after the fact has a window in which N parallel requests all
 *                   read the old count and all go through.
 *   4. forward    — the member's `Authorization` is REPLACED, not merged.
 *   5. release?   — only when the provider cannot have billed us. See the
 *                   spent-vs-released table below; it is the money question.
 *   6. relay      — piped, never buffered, so `stream: true` streams.
 *
 * ── WHAT COUNTS AS SPENT ────────────────────────────────────────────────────
 * "Spent" means: keep the reservation, the member has used one of their daily
 * requests. "Released" means: give it back, the money was never at risk.
 *
 *   connect error / DNS / refused   RELEASED — the request never left this host
 *   headers timeout (no bytes yet)  RELEASED — nothing was served to us; our own
 *                                   bound gave up before the provider answered
 *   upstream 4xx                    RELEASED — the provider REFUSED the request
 *                                   (malformed, unknown model, bad key, edge
 *                                   429). It never reached a model, so nobody
 *                                   billed it, and charging the member for our
 *                                   own misconfiguration is the worst outcome:
 *                                   a broken gateway would silently eat the
 *                                   household's whole allowance in one minute.
 *   upstream 5xx                    SPENT — the provider accepted the request
 *                                   and failed while serving it. Generation may
 *                                   have run and may be billed. Releasing here
 *                                   hands out a free infinite retry loop against
 *                                   a flaky provider, which is exactly when the
 *                                   client retries hardest.
 *   body timeout / stream aborted   SPENT — headers already arrived, so the
 *                                   provider ran the request. That we failed to
 *                                   read the answer is our problem, not a refund.
 *   upstream 2xx                    SPENT — obviously.
 *
 * ── THE THREE HARD RULES ────────────────────────────────────────────────────
 *  1. NEVER LOG A BODY. Not the request, not the response, not a prefix, not a
 *     decoded buffer. What we log: member id, token fingerprint, upstream status,
 *     byte COUNTS, duration. Counts are not bytes.
 *  2. EVERY STRING THAT CAME OFF THE UPSTREAM WIRE GOES THROUGH `scrubPayloads`
 *     / `describeError` before it reaches a log line OR a response. A provider
 *     that rejects a request routinely echoes the request back at you — image
 *     and all — inside its error body. That string is the single most likely
 *     way a photograph escapes this process, and it is also the string a
 *     debugging instinct most wants to log verbatim.
 *  3. THE MEMBER'S OWN TOKEN IS NEVER FORWARDED. We build the upstream headers
 *     from scratch rather than copying `req.headers` and overwriting one entry;
 *     a copy-then-overwrite forwards cookies, `x-api-key`, and whatever the next
 *     provider decides to read.
 *
 * ── THE TWO UNDICI TIMEOUT SITES ────────────────────────────────────────────
 * Node's global `fetch` applies a default `headersTimeout` of 300 s that an
 * `AbortSignal` cannot RAISE — a signal can only add a tighter cap. So an
 * operator who sets `UPSTREAM_TIMEOUT_MS=600000` on a slow provider would still
 * be cut off at 300 s, with an error that names no knob. We therefore call
 * `undici`'s own `fetch` with an `Agent` we configure, which is the only way the
 * configured bound is the bound that applies.
 *
 * The two bounds then surface in DIFFERENT catch blocks, which is why there are
 * two of them below and not one:
 *
 *   headersTimeout ⇒ the `fetch()` call itself rejects
 *   bodyTimeout    ⇒ `fetch()` RESOLVES with a 200, and the failure lands later,
 *                    while reading the body, as `TypeError: terminated`
 *
 * A body timeout reaching the body-read catch reads, wrongly, as "the provider
 * sent a malformed body". It is also the site with the opposite money answer:
 * the header site releases the reservation, the body site keeps it.
 *
 * `bodyTimeout` is an IDLE bound between chunks, not a total duration, which is
 * what makes it the right one for a streaming proxy: a legitimate ten-minute
 * SSE stream that keeps producing tokens never trips it, while an upstream that
 * goes quiet mid-stream does.
 */
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Agent, fetch as undiciFetch, type Response as UpstreamResponse } from 'undici';
import { z } from 'zod';
import type { Config } from '../config.js';
import { badGateway, badRequest, gatewayTimeout, payloadTooLarge, tooManyRequests, unauthorized } from '../errors.js';
import type { Logger } from '../logger.js';
import type { QuotaStore } from '../quota/types.js';
import { utcDayKey } from '../quota/types.js';
import { describeError, scrubPayloads } from '../scrub.js';
import { openAiErrorBody } from './error-middleware.js';
import { getMemberIdentity } from './member-auth.js';

export interface ProxyDeps {
  readonly config: Config;
  readonly quota: QuotaStore;
  readonly logger: Logger;
  /** Injectable so a test can freeze the UTC day boundary the quota keys on. */
  readonly now?: () => Date;
}

/** undici's codes for "the socket was open and nothing arrived in time". */
const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** How far to follow `.cause`. The observed depth is 1; the rest is defensive. */
const MAX_CAUSE_DEPTH = 5;

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;

/**
 * The longest an upstream error body may be before we stop reading it. A
 * provider that echoes a rejected request sends the whole base64 image back; we
 * scrub it, but there is no reason to hold megabytes of it in memory first.
 */
const MAX_UPSTREAM_ERROR_BYTES = 4096;

/**
 * Reads one link of a thrown value's `cause` chain.
 *
 * Deliberately unparsed and deliberately `unknown`: these values were produced
 * by `throw`, JS permits throwing anything, and undici hangs its codes off
 * objects nobody typed. A schema here would have to invent a contract that does
 * not exist, and this classifier's only job is to be right about values nobody
 * promised anything about.
 */
function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  // SAFETY: `'code' in value` was just checked on a non-null object. The
  // assertion claims the property is PRESENT — which was checked — and says
  // nothing about its type, which is why it is read as `unknown` below.
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * `fetch` reports every transport failure as an opaque `TypeError` (`fetch
 * failed` / `terminated`) and hangs the real reason off `cause`. That chain is
 * the ONLY thing separating a two-minute timeout from an instant connection
 * refusal — same words, opposite remedies, and (here) opposite answers to
 * "did the member just spend a request?".
 */
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

/**
 * Accepts any JSON object and rejects anything else. Deliberately NOT a schema
 * of a chat-completions request: this is a proxy, and a strict schema here would
 * reject every field the provider adds next month. The upstream is the authority
 * on request shape; we only insist that there IS a body.
 */
const AnyJsonObjectSchema = z.looseObject({});

/** Only ever used as a LOG FIELD. The relay path never branches on it — it always pipes. */
function requestsStreaming(body: unknown): boolean {
  const parsed = z.looseObject({ stream: z.boolean().default(false) }).safeParse(body);
  return parsed.success ? parsed.data.stream : false;
}

/** Next UTC midnight after `now` — when a spent daily allowance comes back. */
function nextUtcMidnight(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY + MS_PER_DAY);
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / MS_PER_SECOND));
}

/** Counts bytes as they flow past, so the log line can report a size without ever holding the payload. */
function createByteCounter(): { stream: Transform; total: () => number } {
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      total += chunk.byteLength;
      callback(null, chunk);
    },
  });
  return { stream, total: (): number => total };
}

export function createChatCompletionsHandler(deps: ProxyDeps): RequestHandler {
  const { config, quota, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const upstreamUrl = `${config.upstreamBaseUrl}/chat/completions`;

  /**
   * ONE dispatcher for the life of the handler, not one per request: an `Agent`
   * owns the connection pool, so building it per call would throw away
   * keep-alive and leak a pool per plate photograph.
   */
  const dispatcher = new Agent({
    headersTimeout: config.upstreamTimeoutMs,
    bodyTimeout: config.upstreamTimeoutMs,
  });

  /**
   * A refund must never become the client's error. If the store cannot be
   * written we have over-charged one member by one request — annoying, and
   * strictly better than replacing the real upstream failure with a 500 that
   * points at the quota file.
   */
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

  async function proxy(req: Request, res: Response): Promise<void> {
    const startedAt = performance.now();

    // 1. Identity. `null` here means the auth middleware did not run on this
    // route — a wiring bug, not a caller mistake. Fail CLOSED: the alternative
    // is a spend endpoint that is open to the internet because someone
    // reordered two `app.use` calls.
    const identity = getMemberIdentity(req);
    if (!identity) {
      throw unauthorized('This request carried no member identity.');
    }

    // 2. Size, before anything is forwarded. The body parser's own limit is the
    // first stop (it refuses while still reading the socket); this is the
    // authoritative one, measured on exactly the bytes we would send upstream.
    const parsedBody = AnyJsonObjectSchema.safeParse(req.body);
    if (!parsedBody.success) {
      // The parse failure is NOT quoted: zod's message would carry the input.
      throw badRequest('Request body must be a JSON object.');
    }
    const forwardedBody = Buffer.from(JSON.stringify(req.body), 'utf8');
    if (forwardedBody.byteLength > config.maxRequestBytes) {
      throw payloadTooLarge(
        `Request body is ${forwardedBody.byteLength} bytes; the limit is ${config.maxRequestBytes}.`,
      );
    }

    // 3. Reserve BEFORE the upstream call. A refusal is a 429 with the reset
    // instant named — never a 500. Being out of allowance is the system working.
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

    // 4. Forward. Headers are BUILT, never copied — see hard rule 3.
    let upstream: UpstreamResponse;
    try {
      upstream = await undiciFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': req.header('content-type') ?? 'application/json',
          // The payer's key replaces the member's token. The member token never
          // leaves this process, and the provider key never leaves this line.
          Authorization: `Bearer ${config.upstreamApiKey}`,
        },
        body: forwardedBody,
        dispatcher,
      });
    } catch (error) {
      // TIMEOUT SITE 1 of 2 — `headersTimeout` lands HERE, together with every
      // connect-level failure. Nothing was served to us in either case, so the
      // reservation goes back.
      await releaseQuietly(identity.memberId, day);
      const timedOut = isTimeoutError(error);
      logger.warn('Upstream call failed before any response', {
        memberId: identity.memberId,
        tokenFingerprint: identity.tokenFingerprint,
        timedOut,
        requestBytes: forwardedBody.byteLength,
        durationMs: Math.round(performance.now() - startedAt),
        // Scrubbed: a transport error can quote the request it failed to send.
        error: describeError(error),
      });
      if (timedOut) {
        throw gatewayTimeout(
          `The upstream provider did not answer within ${config.upstreamTimeoutMs} ms.`,
        );
      }
      throw badGateway('The upstream provider could not be reached.');
    }

    // 5. The provider answered. A 4xx means it REFUSED the request, so nothing
    // was billed and the member gets their unit back. A 5xx means it accepted
    // the request and then failed — the money may already be gone, so it stays
    // spent. See the table in the module header.
    if (upstream.status >= 400 && upstream.status < 500) {
      await releaseQuietly(identity.memberId, day);
    }

    if (!upstream.ok) {
      await relayUpstreamError({ upstream, res, identity, startedAt, requestBytes: forwardedBody.byteLength });
      return;
    }

    // 6. Relay, piped. `stream: true` works because nothing here buffers: the
    // upstream body is a stream and it goes straight out through a byte counter.
    // We never inspect it, so a streaming format we have never heard of still
    // passes through unchanged.
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    // Server-sent events die behind a buffering proxy; say so explicitly rather
    // than hoping the deployment's reverse proxy guesses right.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Quota-Used', String(reservation.used));
    res.setHeader('X-Quota-Limit', String(reservation.limit));

    const counter = createByteCounter();
    let relayFailed: unknown = null;
    try {
      // `upstream.body` is non-null for any response undici returns from a POST
      // that reached the network; the guard keeps the type honest and turns the
      // impossible case into a 502 rather than a TypeError.
      if (!upstream.body) throw new Error('upstream response had no body');
      await pipeline(Readable.fromWeb(upstream.body), counter.stream, res);
    } catch (error) {
      // TIMEOUT SITE 2 of 2 — `bodyTimeout` lands HERE, not in the catch above:
      // `fetch()` already resolved 200 by the time the stream stalls, and undici
      // surfaces the stall as `TypeError: terminated`. Read naively that says
      // "the provider sent a malformed body", which is a confident wrong
      // diagnosis that names no knob.
      //
      // NO RELEASE. Headers arrived, so the provider ran the request and is
      // billing for it. Our failure to read the answer is not a refund.
      relayFailed = error;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    if (relayFailed !== null) {
      logger.error('Relay of the upstream response failed', {
        memberId: identity.memberId,
        tokenFingerprint: identity.tokenFingerprint,
        upstreamStatus: upstream.status,
        timedOut: isTimeoutError(relayFailed),
        responseBytes: counter.total(),
        durationMs,
        error: describeError(relayFailed),
      });
      // The status line and some bytes are already on the wire, so there is no
      // error document to send. Destroying the socket is the only signal left,
      // and it is the correct one: a truncated stream must not look complete.
      res.destroy();
      return;
    }

    logger.info('Proxied a completion', {
      memberId: identity.memberId,
      tokenFingerprint: identity.tokenFingerprint,
      upstreamStatus: upstream.status,
      streaming: requestsStreaming(req.body),
      requestBytes: forwardedBody.byteLength,
      responseBytes: counter.total(),
      quotaUsed: reservation.used,
      quotaLimit: reservation.limit,
      durationMs,
    });
  }

  /**
   * A non-2xx upstream answer, relayed with its status and a SCRUBBED body.
   *
   * The status passes through untouched — a client needs to tell "your request
   * was wrong" from "the provider is down". The body does not: this is the exact
   * string in which a provider echoes the request it rejected, plate photograph
   * included. It is scrubbed before it reaches the member and before it reaches
   * the log, and it is read through its own try/catch because reading a body is
   * the second place an undici timeout can land.
   */
  async function relayUpstreamError(context: {
    upstream: UpstreamResponse;
    res: Response;
    identity: { memberId: string; tokenFingerprint: string };
    startedAt: number;
    requestBytes: number;
  }): Promise<void> {
    const { upstream, res, identity } = context;

    let rawBody: string;
    try {
      rawBody = (await upstream.text()).slice(0, MAX_UPSTREAM_ERROR_BYTES);
    } catch (error) {
      // Same two-site rule as the success path: a stalled error body arrives
      // here, not in the `fetch` catch.
      rawBody = isTimeoutError(error)
        ? 'the provider stopped sending its error body'
        : 'the provider sent an unreadable error body';
    }
    const scrubbed = scrubPayloads(rawBody);

    logger.warn('Upstream provider returned an error', {
      memberId: identity.memberId,
      tokenFingerprint: identity.tokenFingerprint,
      upstreamStatus: upstream.status,
      requestBytes: context.requestBytes,
      responseBytes: Buffer.byteLength(rawBody, 'utf8'),
      durationMs: Math.round(performance.now() - context.startedAt),
      upstreamError: scrubbed,
    });

    // Same envelope every other failure uses, so a client parses one shape —
    // but with the UPSTREAM's status, which is the one thing a caller needs to
    // tell "your request was wrong" from "the provider is down".
    res.status(upstream.status).json(
      openAiErrorBody({
        message: `The upstream provider answered ${upstream.status}: ${scrubbed}`,
        type: upstream.status >= 500 ? 'api_error' : 'invalid_request_error',
        code: 'upstream_error',
      }),
    );
  }

  /**
   * Express 4 does not catch a rejected promise from a handler — an async
   * handler that threw would hang the request until the client gave up, which is
   * a worse failure than any error it was trying to report. Every path out of
   * `proxy` therefore goes through this one wrapper.
   */
  return function handleChatCompletions(req: Request, res: Response, next: NextFunction): void {
    void (async (): Promise<void> => {
      try {
        await proxy(req, res);
      } catch (error) {
        next(error);
      }
    })();
  };
}
