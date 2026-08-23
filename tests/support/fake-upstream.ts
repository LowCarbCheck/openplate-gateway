/**
 * An in-process fake AI provider: a real express app on an ephemeral port that
 * speaks the OpenAI-compatible dialect the gateway forwards to.
 *
 * WHY A REAL SERVER RATHER THAN A MOCKED `fetch`. What is under test here is
 * mostly wire behaviour — which `Authorization` header actually goes out, what
 * a non-2xx body does on the way back, whether the relay streams. Stubbing
 * `fetch` would assert that we call a mock the way we think we call it; a
 * socket asserts what really crosses one. (Same precedent as the sibling
 * inference repo's `fake-runtime.ts`.)
 *
 * IT RECORDS METADATA, NEVER A BODY. The recorded request carries the
 * `Authorization` header it was sent and a byte COUNT — never the bytes. A
 * fixture that kept the payload would put a second copy of the plate photograph
 * in the process and would undercut the privacy test one directory over.
 *
 * The `echo` scenario is the adversarial one, and it is not hypothetical: a
 * provider that rejects a request routinely quotes the whole request back
 * inside its error body, image and all. That response is the single most likely
 * way a photograph escapes this process.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type UpstreamScenario =
  /** A well-formed completion. */
  | { kind: 'ok'; body?: unknown }
  /** A non-2xx with a body we control. */
  | { kind: 'status'; status: number; body?: unknown }
  /** A non-2xx whose body QUOTES the request it was sent, verbatim. */
  | { kind: 'echo'; status: number }
  /**
   * A server-sent-events stream, the shape `stream: true` really produces.
   * Org mode records `responseText: null` for these on purpose — see
   * `org-proxy.ts` — so a test needs a response that is genuinely SSE rather
   * than JSON with a hopeful content type.
   */
  | { kind: 'sse'; frames?: readonly string[] };

export interface RecordedUpstreamRequest {
  /** The raw `Authorization` header, or `null` when none was sent. */
  authorization: string | null;
  contentType: string | null;
  /** A COUNT, never the bytes. */
  requestBytes: number;
  /** Header names only — enough to prove we build headers rather than copy them. */
  headerNames: string[];
}

export interface FakeUpstream {
  /** Includes the `/v1` suffix, the way a provider's documented base URL does. */
  baseUrl: string;
  requests: RecordedUpstreamRequest[];
  setScenario(scenario: UpstreamScenario): void;
  close(): Promise<void>;
}

const DEFAULT_COMPLETION = {
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'rice, chicken' }, finish_reason: 'stop' }],
};

export async function startFakeUpstream(
  initialScenario: UpstreamScenario = { kind: 'ok' },
): Promise<FakeUpstream> {
  let scenario = initialScenario;
  const requests: RecordedUpstreamRequest[] = [];

  const app = express();
  app.disable('x-powered-by');
  // `text` rather than `json`: the echo scenario needs the bytes exactly as they
  // arrived, and a re-serialised body would not be the thing a real provider
  // quotes back.
  app.use(express.text({ type: () => true, limit: '64mb' }));

  app.post('/v1/chat/completions', (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    requests.push({
      authorization: req.header('authorization') ?? null,
      contentType: req.header('content-type') ?? null,
      requestBytes: Buffer.byteLength(raw, 'utf8'),
      headerNames: Object.keys(req.headers).toSorted(),
    });

    if (scenario.kind === 'ok') {
      res.status(200).json(scenario.body ?? DEFAULT_COMPLETION);
      return;
    }
    if (scenario.kind === 'sse') {
      const frames = scenario.frames ?? [
        'data: {"choices":[{"delta":{"content":"rice"}}]}',
        'data: {"choices":[{"delta":{"content":", chicken"}}]}',
        'data: [DONE]',
      ];
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      for (const frame of frames) res.write(`${frame}\n\n`);
      res.end();
      return;
    }
    if (scenario.kind === 'status') {
      res.status(scenario.status).json(
        scenario.body ?? { error: { message: 'upstream said no', type: 'invalid_request_error' } },
      );
      return;
    }
    // `echo` — the provider quotes the request it rejected back at us.
    res.status(scenario.status).json({
      error: { message: 'invalid request', type: 'invalid_request_error' },
      request_echo: raw,
    });
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  // SAFETY: bound to a TCP port after `listening`, so `address()` is an `AddressInfo`.
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setScenario: (next: UpstreamScenario): void => {
      scenario = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
