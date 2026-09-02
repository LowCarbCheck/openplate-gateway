/**
 * An in-process fake gateway: a real HTTP server on an ephemeral port that
 * answers `/admin/*`, `/v1/gateway/info` and `/healthcheck` the way the service
 * does.
 *
 * WHY A REAL SERVER RATHER THAN A STUBBED `fetch`. Everything `gw-api` can get
 * wrong is wire-shaped: whether the `Authorization` header really goes out,
 * which host the request actually reached when a flag and an environment
 * variable disagree, and what a non-2xx body does on the way back. A stub proves
 * we call a mock the way we think we do; a socket proves what crossed one. Same
 * precedent as `fake-mail-api.ts` and `fake-upstream.ts`.
 *
 * THE `leak` SCENARIO IS THE ADVERSARIAL ONE. `--url` points wherever the
 * operator says — a reverse proxy, a mail API behind a typo, a captive portal —
 * and those echo the request they rejected back inside the error body. Here that
 * body carries a recipient address and a whole invite link, so a test can assert
 * that neither reaches the operator's terminal.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type GatewayScenario =
  /** Ordinary answers, in the shapes `src/server/admin-routes.ts` returns. */
  | { kind: 'ok' }
  /** Every route answers `status` with a body quoting a recipient and an invite link. */
  | { kind: 'leak'; status: number };

export interface RecordedGatewayRequest {
  method: string;
  path: string;
  /** The raw `Authorization` header, or `null` when none was sent. */
  authorization: string | null;
  /** The parsed JSON body, or `undefined` when there was none. */
  body: unknown;
}

export interface FakeGateway {
  /** The base URL an operator would pass to `--url`. */
  url: string;
  /** A label the test can assert reached the server, to tell two fakes apart. */
  name: string;
  requests: RecordedGatewayRequest[];
  close(): Promise<void>;
}

/** What the `leak` scenario quotes back. Neither may ever appear in CLI output. */
export const LEAKED_RECIPIENT = 'robin@example.test';
export const LEAKED_INVITE_LINK =
  'https://app.example.test/join#gateway=https%3A%2F%2Fgw.example.test&ginvite=inv_tok_must_never_print';

function parseJson(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The success bodies, keyed by `METHOD path-with-the-id-collapsed`. */
function okBody(parts: { method: string; path: string; name: string }): unknown {
  const { method, path, name } = parts;
  if (method === 'GET' && path === '/healthcheck') return { status: 'ok' };
  if (method === 'GET' && path === '/v1/gateway/info') {
    return { name, model: 'test-model', auditEnabled: false, version: '0.0.0-test' };
  }
  if (method === 'GET' && path === '/admin/members') {
    return {
      members: [
        {
          id: 'alex',
          dailyLimit: 50,
          createdAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
          mode: 'family',
          consentAt: null,
        },
      ],
    };
  }
  if (method === 'POST' && path === '/admin/members') {
    return {
      member: {
        id: 'robin',
        dailyLimit: 25,
        createdAt: '2026-01-02T00:00:00.000Z',
        revokedAt: null,
        mode: 'family',
        consentAt: null,
      },
      token: 'gw_member_token_shown_once',
      tokenNote: 'Shown once.',
    };
  }
  if (method === 'GET' && path === '/admin/invites') return { invites: [] };
  if (method === 'POST' && path === '/admin/invites') {
    return {
      id: 'inv_1',
      memberId: 'robin',
      dailyLimit: 25,
      expiresAt: '2026-01-09T00:00:00.000Z',
      emailed: false,
      link: LEAKED_INVITE_LINK,
      token: 'inv_tok_must_never_print',
      tokenNote: 'Shown once.',
    };
  }
  return {};
}

export async function startFakeGateway(
  options: { scenario?: GatewayScenario; name?: string } = {},
): Promise<FakeGateway> {
  const scenario: GatewayScenario = options.scenario ?? { kind: 'ok' };
  const name = options.name ?? 'fake gateway';
  const requests: RecordedGatewayRequest[] = [];
  // Tracked so `close()` can tear down keep-alive sockets; without this a suite
  // ends and the process does not.
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const method = request.method ?? '';
      requests.push({
        method,
        path,
        authorization: request.headers.authorization ?? null,
        body: parseJson(Buffer.concat(chunks).toString('utf8')),
      });

      if (scenario.kind === 'leak') {
        response.writeHead(scenario.status, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              // Exactly the shape a proxy or a mail API returns: the request it
              // rejected, quoted whole.
              message: `rejected the request for ${LEAKED_RECIPIENT}`,
              request: { to: LEAKED_RECIPIENT, link: LEAKED_INVITE_LINK },
            },
          }),
        );
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(okBody({ method, path, name })));
    });
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  // SAFETY: bound to a TCP port above, so `address()` is an `AddressInfo`.
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    name,
    requests,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
