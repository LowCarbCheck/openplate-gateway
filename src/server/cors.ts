/**
 * CORS — load-bearing, not convenient.
 *
 * openplate is a browser app served from a DIFFERENT origin to this gateway
 * (its own domain, or a self-hoster's, or `localhost:5173` in development).
 * The vision call is made from the page, so without these headers the browser
 * refuses the request before it is ever sent and "point openplate at your own
 * gateway" is false.
 *
 * WHAT MAKES A WIDE POLICY SAFE HERE IS THE ABSENCE OF AMBIENT CREDENTIALS.
 * This service issues no cookies and reads none; authentication is a bearer
 * token the client attaches deliberately (see `member-auth.ts`). A hostile page
 * can therefore make a cross-origin request and get a `401`, because the
 * browser has nothing to attach on its behalf. That is exactly the CSRF
 * property cookie auth lacks — and it is why `Access-Control-Allow-Credentials`
 * is NEVER sent: browsers reject it alongside `*`, and sending it would signal
 * an intent (cookie auth) this service must not develop.
 *
 * `Vary: Origin` IS NOT OPTIONAL ON THE ALLOWLIST PATH. When the allowed origin
 * is echoed back, the response genuinely differs per origin. Any cache in front
 * of this service — a CDN, a corporate proxy, the browser's own — would
 * otherwise store the first origin's `Access-Control-Allow-Origin` and serve it
 * to the next origin, which either breaks a legitimate client or hands a
 * disallowed one a pass. It is sent for a MISS too: the absence of the header is
 * just as origin-dependent as its presence.
 *
 * Hand-rolled rather than the `cors` package: a few dozen lines against a
 * dependency every self-hoster inherits and has to trust with a service that
 * carries photographs.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { CorsAllowedOrigins } from '../config.js';

const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * The token rides in `Authorization`; `Content-Type` is needed because a JSON
 * body makes the request non-simple. Nothing else is accepted — a browser that
 * asks for a header not on this list is told no, which is the point.
 */
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/**
 * Response headers a cross-origin script is allowed to READ. Without this the
 * backpressure contract is unreadable to exactly the client that has to obey
 * it: `Retry-After` on a 429, and the quota counters that tell a member how much
 * of the day's allowance is left.
 */
const EXPOSED_HEADERS = 'Retry-After, X-Quota-Used, X-Quota-Limit';

/** 24h. The policy is static, so re-asking on every request is pure latency. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/**
 * Exact string match, per the Origin header's grammar (`scheme://host[:port]`,
 * no path, no trailing slash). No prefix or suffix matching: `startsWith`
 * against `https://app.example.com` would also admit
 * `https://app.example.com.attacker.test`.
 */
function isAllowed(allowedOrigins: readonly string[], origin: string): boolean {
  return allowedOrigins.includes(origin);
}

/**
 * Sets the CORS headers and answers the `OPTIONS` preflight.
 *
 * MOUNT THIS FIRST — the preflight is answered and returned here, before auth.
 * A browser sends `OPTIONS` with no `Authorization` header (it is asking whether
 * it may send one), so an auth middleware in front of this would reject every
 * preflight with a 401 and no cross-origin client would ever get as far as its
 * real request.
 */
export function createCors(allowedOrigins: CorsAllowedOrigins): RequestHandler {
  return function applyCors(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));

    if (allowedOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      // One constant answer per origin, so it must never be cached across them.
      res.setHeader('Vary', 'Origin');
      const origin = req.header('origin');
      if (origin !== undefined && isAllowed(allowedOrigins, origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }

    if (req.method === 'OPTIONS') {
      // 204 with no body. A disallowed origin gets this too, without an
      // `Access-Control-Allow-Origin` — the browser is what enforces the refusal,
      // and it needs a well-formed answer to read the absence from.
      res.status(204).end();
      return;
    }
    next();
  };
}
