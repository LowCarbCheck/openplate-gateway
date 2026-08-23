/**
 * The service's error vocabulary. Every failure a client can see is one of
 * these, carrying the HTTP status it should be rendered with — so the wire
 * status is decided here, once, instead of at twenty `res.status(...)` call
 * sites, and an error thrown deep in the proxy path can be surfaced correctly
 * by a single handler that knows nothing about where it came from.
 *
 * NOTHING IN HERE MAY CARRY A REQUEST BODY OR THE UPSTREAM KEY. Messages are
 * written by us, for a human reading a client-side error toast. When a message
 * has to quote something that came off the wire (a dependency's error text, an
 * upstream provider's error body), it goes through `scrub.ts#scrubPayloads`
 * first.
 *
 * The distinction between the two upstream failures is worth keeping straight,
 * because a client retries on one and not the other: `badGateway` means the
 * provider answered and we could not use the answer; `gatewayTimeout` means it
 * never answered inside our budget.
 */

export class HttpError extends Error {
  readonly status: number;
  /** Seconds. Rendered as a `Retry-After` header — only set for 429. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    // Subclassing a builtin loses the useful `name` unless it is set here, and
    // the name is what ends up in a log line's `error` field.
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * `instanceof`, not a duck-type check on `.status`. Everything in this process
 * is bundled from one module graph, so there is exactly one `HttpError` class —
 * and a structural check would happily claim a `fetch`-shaped object or an
 * upstream error DTO, which is precisely the value we must NOT hand to a client
 * verbatim.
 */
export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

/** The request is malformed: unparseable JSON, missing field, wrong shape. */
export function badRequest(message: string): HttpError {
  return new HttpError(message, 400);
}

/** No member token, an unknown one, or one that has been revoked. */
export function unauthorized(message: string): HttpError {
  return new HttpError(message, 401);
}

/**
 * The named thing does not exist — an admin asking to revoke a member id that
 * was never there.
 *
 * NOT used to hide an endpoint. `/admin` answers 404 when no admin token is
 * configured, and that 404 is produced by the router never being mounted, not
 * by this factory: the two must not be confusable, because one means "you asked
 * for something that is not here" and the other means "there is nothing here to
 * ask about".
 */
export function notFound(message: string): HttpError {
  return new HttpError(message, 404);
}

/** The request is well-formed but conflicts with what already exists — a duplicate member id. */
export function conflict(message: string): HttpError {
  return new HttpError(message, 409);
}

/** The body is larger than `MAX_REQUEST_BYTES` — refused before it is forwarded. */
export function payloadTooLarge(message: string): HttpError {
  return new HttpError(message, 413);
}

/** Per-minute rate limit or daily quota. `retryAfterSeconds` is mandatory: a 429 without it makes every client guess. */
export function tooManyRequests(message: string, retryAfterSeconds: number): HttpError {
  return new HttpError(message, 429, retryAfterSeconds);
}

/** The upstream provider answered, and the answer was unusable: non-2xx, truncated, or unparseable. */
export function badGateway(message: string): HttpError {
  return new HttpError(message, 502);
}

/** The upstream provider did not answer within `UPSTREAM_TIMEOUT_MS`. */
export function gatewayTimeout(message: string): HttpError {
  return new HttpError(message, 504);
}
