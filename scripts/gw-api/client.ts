/**
 * The `gw-api` transport: one `fetch` per command, and a deliberately deaf ear
 * for what comes back on a failure.
 *
 * ── IT READS NOTHING FROM DISK, AND THAT IS ENFORCED ────────────────────────
 * No config module, no member store, no `node:fs`. The whole client is a base
 * URL and a bearer token handed in by the caller, so `gw-api` runs from a laptop
 * that has never seen the state directory or the upstream provider key.
 * `tests/unit/gw-api-no-disk-imports.test.ts` walks the static import graph from
 * the entrypoint and fails if that ever stops being true.
 *
 * ── A FAILURE RESPONSE BODY IS NEVER READ, LET ALONE PRINTED ────────────────
 * This is the same rule `maybeSendInvite` follows in `src/server/admin-routes.ts`
 * and the one `tests/unit/invite-http-mail-leak.test.ts` exists to pin, applied
 * on the client side. An error body from *this* gateway is a scrubbed envelope,
 * but `--url` points wherever the operator says: a reverse proxy, a mail API
 * behind a typo, a captive portal. Those quote the request they rejected —
 * recipient addresses and invite links included — and an operator pastes a CLI
 * error into a chat window without thinking about it.
 *
 * So the status code is the only thing taken from a non-2xx response. The body
 * is not read at all rather than read-and-discarded: a value that was never in a
 * variable cannot be added to a message by a later edit. The detail an operator
 * loses is in the gateway's own log, which is the channel that is allowed to
 * hold it.
 *
 * ── THE ADMIN TOKEN NEVER APPEARS IN ANY STRING BUILT HERE ──────────────────
 * It goes into one `Authorization` header and nowhere else. Not in an error, not
 * echoed back on a 401, not in the "could not reach" message. A CLI that quoted
 * the credential it just sent would put it in the operator's scrollback and,
 * from there, in the issue they open.
 */

/** Everything `gw-api` reports to the operator is one of these. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** The verbs the admin API actually uses. Anything else is a typo, not a feature. */
export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface GatewayRequest {
  readonly method: HttpMethod;
  /** Absolute path on the gateway, e.g. `/admin/members`. */
  readonly path: string;
  /** JSON request body, or absent for GET and DELETE. */
  readonly body?: unknown;
}

export interface GatewayClientOptions {
  readonly baseUrl: string;
  readonly adminToken: string;
  /** Injected in tests; the real entrypoint passes the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A status the operator can act on, without quoting anything the far end said.
 *
 * 401 names the environment variable because that is the one thing they can
 * change; it does not say whether the token was absent, stale or simply wrong,
 * which is the same indistinguishability the server-side auth keeps.
 */
function describeStatus(status: number, method: HttpMethod, path: string): string {
  const where = `${method} ${path}`;
  if (status === 401) {
    return `The gateway rejected the admin token (401 on ${where}). Check GATEWAY_ADMIN_TOKEN — it must be the same value the gateway was started with.`;
  }
  if (status === 404) {
    return `The gateway answered 404 for ${where}. Either the id does not exist, or this gateway has no admin API — /admin answers 404 when GATEWAY_ADMIN_TOKEN is unset on the server.`;
  }
  if (status === 409) {
    return `The gateway refused ${where} as a conflict (409): that member id is already taken.`;
  }
  if (status === 400) {
    return `The gateway rejected ${where} as invalid (400). A member id is 1–32 characters of lowercase letters, digits, "-" or "_"; a daily limit is a whole number.`;
  }
  if (status === 429) {
    return `The gateway rate-limited ${where} (429). Wait a minute and try again.`;
  }
  return `The gateway answered ${status} for ${where}. Its own log has the reason — this message deliberately does not quote the response body.`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * One request, one parsed JSON answer. Returns `unknown`: the caller narrows
 * with a schema-free view function, because a CLI that trusted a response shape
 * would crash on the far end being something other than this gateway.
 */
export class GatewayClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(request: GatewayRequest): Promise<unknown> {
    const url = joinUrl(this.baseUrl, request.path);
    const headers: Record<string, string> = {
      // THE ONLY PLACE THE ADMIN TOKEN IS EVER WRITTEN. See the module header.
      Authorization: `Bearer ${this.adminToken}`,
      Accept: 'application/json',
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.send({
      url,
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });

    if (!response.ok) {
      // The body is NOT read. See the module header — this is the whole point.
      throw new CliError(describeStatus(response.status, request.method, request.path));
    }

    return this.readJson(response, url);
  }

  private async send(parts: {
    url: string;
    method: HttpMethod;
    headers: Record<string, string>;
    body?: string;
  }): Promise<Response> {
    try {
      return await this.fetchImpl(parts.url, {
        method: parts.method,
        headers: parts.headers,
        ...(parts.body === undefined ? {} : { body: parts.body }),
      });
    } catch {
      // The transport error is discarded rather than quoted: undici's message
      // is "fetch failed" plus a cause chain that has, on occasion, carried the
      // request headers. The address is ours and is worth naming; nothing else
      // from that error is.
      throw new CliError(
        `Could not reach the gateway at ${parts.url}. Is it running, and is --url (or GATEWAY_URL) right?`,
      );
    }
  }

  private async readJson(response: Response, url: string): Promise<unknown> {
    const raw = await response.text();
    if (raw === '') return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // A 2xx that is not JSON means the URL reached something that is not this
      // gateway — an HTML login page from a reverse proxy is the usual one. The
      // text is not quoted, for the same reason an error body is not.
      throw new CliError(
        `${url} answered with something that is not JSON. That address is probably not an openplate-gateway.`,
      );
    }
  }
}
