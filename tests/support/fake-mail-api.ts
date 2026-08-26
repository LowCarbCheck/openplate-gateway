/**
 * An in-process fake mail API: a real HTTP server on an ephemeral port that
 * answers the way Resend and pigeon answer.
 *
 * WHY A REAL SERVER RATHER THAN A STUBBED `fetch`. Everything the HTTP mail
 * adapter can get wrong is wire-shaped — the method, the `Authorization`
 * header, whether `to` goes out as an array (pigeon refuses a bare string, and
 * a mocked `fetch` would happily accept one), and what a non-2xx does on the
 * way back. A stub asserts that we call a mock the way we think we do; a socket
 * asserts what really crossed one. Same precedent as `fake-upstream.ts`.
 *
 * THE `echo` SCENARIO IS THE ADVERSARIAL ONE, AND IT IS NOT HYPOTHETICAL. Both
 * Resend and pigeon quote the request they rejected back inside the error body:
 * the recipient address, the subject, and the html — which carries the invite
 * link, which carries the token. That body is the single most likely way an
 * invite credential escapes this process, so a test needs a server that really
 * sends one.
 *
 * IT RECORDS THE REQUEST BODY, unlike `fake-upstream.ts` which deliberately
 * does not. The distinction is what the body IS: there, a plate photograph the
 * service promised never to store; here, an invite message the test itself
 * caused to be built. No privacy assertion in this suite reads from `requests`
 * — the leak tests read log lines and error messages.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type MailApiScenario =
  /** Accepted, in the `{id, status}` shape both providers return. */
  | { kind: 'ok' }
  /** A non-2xx whose body QUOTES the request it was sent, verbatim. */
  | { kind: 'echo'; status: number }
  /** Accepts the request and never answers — what a bound has to survive. */
  | { kind: 'silent' };

export interface RecordedMailRequest {
  method: string;
  /** The path the adapter POSTed to, so a test can prove the whole URL is used verbatim. */
  path: string;
  /** The raw `Authorization` header, or `null` when none was sent. */
  authorization: string | null;
  contentType: string | null;
  /** The parsed JSON body, or `undefined` when it did not parse. */
  body: unknown;
}

export interface FakeMailApi {
  /** The FULL send endpoint, the way an operator writes `MAIL_API_URL`. */
  url: string;
  requests: RecordedMailRequest[];
  setScenario(scenario: MailApiScenario): void;
  close(): Promise<void>;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function startFakeMailApi(
  initialScenario: MailApiScenario = { kind: 'ok' },
): Promise<FakeMailApi> {
  let scenario = initialScenario;
  const requests: RecordedMailRequest[] = [];
  // Tracked so `close()` can tear down a connection the `silent` scenario is
  // still holding open. Without this, a suite ends and the process does not.
  const sockets = new Set<Socket>();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization ?? null,
        contentType: request.headers['content-type'] ?? null,
        body: parseJson(raw),
      });

      // Deliberately no response, not even headers.
      if (scenario.kind === 'silent') return;

      if (scenario.kind === 'ok') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'msg_fake_0001', status: 'queued' }));
        return;
      }

      response.writeHead(scenario.status, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          message: 'the mail API rejected this request',
          // The whole request, echoed. See the module header.
          request: parseJson(raw),
        }),
      );
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
    url: `http://127.0.0.1:${port}/v1/emails`,
    requests,
    setScenario: (next: MailApiScenario): void => {
      scenario = next;
    },
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
