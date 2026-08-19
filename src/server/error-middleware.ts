/**
 * The terminal error handler — and the reason it is not optional twice over.
 *
 * FIRST: SHAPE. Every non-2xx body must be an OpenAI error envelope
 * (`{"error": {message, type, param, code}}`), because the caller is an
 * OpenAI-compatible client and anything else is an unparseable surprise.
 * Express's own default handler does not honour that: it renders an HTML page
 * with a stack trace in development and a bare status line otherwise, on
 * precisely the failure paths (413, malformed JSON) a client meets in the field.
 *
 * SECOND: PRIVACY. This is the one place in the service that sees every
 * unhandled error, which makes it the one place a plate photograph could leak
 * out of. Three rules, all load-bearing:
 *
 *   - THE REQUEST BODY IS NEVER LOGGED AND NEVER ECHOED. Not the parsed body,
 *     not a truncated preview, not "just the keys". The body is where the image
 *     is.
 *   - EVERY STRING THAT REACHES A LOG LINE OR THE RESPONSE PASSES THROUGH
 *     `describeError`/`scrubPayloads` FIRST. Our own call sites are disciplined
 *     — `logger.ts`'s field type will not even accept a Buffer. The gap is
 *     somebody else's string: a dependency that quotes the input it choked on,
 *     an upstream provider echoing the request it rejected, one `${error}` added
 *     next year. On the happy path none of that fires, which is exactly why the
 *     happy path passing proves nothing.
 *   - THE TOKEN IS NEVER LOGGED. The member id and the 8-char fingerprint are,
 *     and they are enough to find the member without being able to become them.
 *
 * Unexpected errors get one fixed sentence, so an internal detail cannot escape
 * through a message nobody wrote carefully.
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { isHttpError, type HttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { describeError, scrubPayloads } from '../scrub.js';
import { getMemberIdentity } from './member-auth.js';

/** `body-parser` marks its own failures with a `type` field. */
const BODY_PARSER_TOO_LARGE = 'entity.too.large';
const BODY_PARSER_PARSE_FAILED = 'entity.parse.failed';

/**
 * The one thing this handler reads off an arbitrary thrown value. Anything
 * without a string `type` — including every error we raise ourselves — parses as
 * a miss and falls through to the unexpected-error branch.
 */
const BodyParserErrorSchema = z.looseObject({ type: z.string() });

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export function openAiErrorBody(options: {
  message: string;
  type: string;
  param?: string;
  code?: string;
}): OpenAiErrorBody {
  return {
    error: {
      message: options.message,
      type: options.type,
      param: options.param ?? null,
      code: options.code ?? null,
    },
  };
}

/**
 * `HttpError` carries a status and nothing else, so the OpenAI `type`/`code`
 * pair is derived from it here — in one table, rather than at each factory in
 * `errors.ts`, which has no business knowing about a wire format.
 */
function describeStatus(status: number): { type: string; code: string } {
  switch (status) {
    case 400:
      return { type: 'invalid_request_error', code: 'invalid_request' };
    case 401:
      return { type: 'invalid_request_error', code: 'invalid_api_key' };
    case 413:
      return { type: 'invalid_request_error', code: 'payload_too_large' };
    case 429:
      return { type: 'rate_limit_error', code: 'rate_limit_exceeded' };
    case 502:
      return { type: 'api_error', code: 'upstream_error' };
    case 504:
      return { type: 'api_error', code: 'upstream_timeout' };
    default:
      return status >= 500
        ? { type: 'api_error', code: 'internal_error' }
        : { type: 'invalid_request_error', code: 'invalid_request' };
  }
}

function sendHttpError(res: Response, error: HttpError): void {
  if (error.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  const { type, code } = describeStatus(error.status);
  res.status(error.status).json(
    openAiErrorBody({
      // Scrubbed on the way OUT as well as into the log. An `HttpError` message
      // is the one error string this service returns verbatim, so it is the one
      // place a message built around the payload would escape — and "our
      // messages are written by us" is a promise about today's code, not
      // tomorrow's.
      message: scrubPayloads(error.message),
      type,
      code,
    }),
  );
}

export function createErrorMiddleware(logger: Logger): ErrorRequestHandler {
  // Express hands the terminal handler whatever a route threw, and JS permits
  // throwing any value at all. `unknown` is the honest annotation, and it is
  // what forces each branch below to establish the shape it reads before it
  // reads it; a narrower type would be a guess this handler cannot make.
  return function handleError(
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Headers already flushed means a handler answered and then failed —
    // typically a streamed completion that died mid-body. There is no status
    // left to set and no valid JSON to append, so hand it back to Express,
    // whose default behaviour at this point is to destroy the socket. That
    // truncation is what tells the client the stream is not complete.
    if (res.headersSent) {
      next(error);
      return;
    }

    const identity = getMemberIdentity(req);
    const memberId = identity?.memberId ?? null;
    const tokenFingerprint = identity?.tokenFingerprint ?? null;

    if (isHttpError(error)) {
      // Expected, client-visible failures. Logged at warn with metadata only —
      // method, path, status, member. Never the body.
      logger.warn('Request rejected', {
        method: req.method,
        path: req.path,
        status: error.status,
        memberId,
        tokenFingerprint,
      });
      sendHttpError(res, error);
      return;
    }

    const parsedBodyParserError = BodyParserErrorSchema.safeParse(error);
    const bodyParserType = parsedBodyParserError.success ? parsedBodyParserError.data.type : null;

    if (bodyParserType === BODY_PARSER_TOO_LARGE) {
      logger.warn('Request body exceeded the parser limit', {
        method: req.method,
        path: req.path,
        memberId,
        tokenFingerprint,
      });
      res.status(413).json(
        openAiErrorBody({
          message: 'Request body exceeds the maximum accepted size.',
          type: 'invalid_request_error',
          code: 'payload_too_large',
        }),
      );
      return;
    }

    if (bodyParserType === BODY_PARSER_PARSE_FAILED) {
      // `body-parser`'s own message for this quotes the fragment it choked on —
      // which, for this service, is a slice of a base64 image. It is discarded
      // here rather than scrubbed, because a fixed sentence is worth more to the
      // client than a redacted one.
      logger.warn('Request body was not valid JSON', {
        method: req.method,
        path: req.path,
        memberId,
        tokenFingerprint,
      });
      res.status(400).json(
        openAiErrorBody({
          message: 'Request body is not valid JSON.',
          type: 'invalid_request_error',
          code: 'invalid_json',
        }),
      );
      return;
    }

    // Genuinely unexpected. `describeError` scrubs it, drops the stack and drops
    // the `cause` chain — which is where a wrapped library error's echoed input
    // hides. The response says nothing about it at all.
    logger.error('Unhandled request error', {
      method: req.method,
      path: req.path,
      memberId,
      tokenFingerprint,
      error: describeError(error),
    });
    res.status(500).json(
      openAiErrorBody({
        message: 'Internal server error.',
        type: 'api_error',
        code: 'internal_error',
      }),
    );
  };
}

/** 404 in the OpenAI shape, so an unknown path does not fall through to Express's HTML default either. */
export function handleNotFound(req: Request, res: Response): void {
  res.status(404).json(
    openAiErrorBody({
      // Scrubbed: the path is client-controlled, and a client that has just
      // put an image into a URL is exactly the mistake this sentence would echo.
      message: scrubPayloads(`Unknown endpoint: ${req.method} ${req.path}`),
      type: 'invalid_request_error',
      code: 'unknown_endpoint',
    }),
  );
}
