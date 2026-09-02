/**
 * `gw-api` end to end, in-process, over a real socket.
 *
 * `runCli` returns an exit code and takes its argv, its environment and its two
 * output sinks as arguments, so the whole CLI runs inside a test against
 * `fake-gateway-api.ts` — a real `node:http` server. Every assertion below is
 * therefore about what crossed a socket or what reached a terminal, not about
 * how a mock was called.
 *
 * THREE OF THESE ARE SECURITY ASSERTIONS, NOT ERGONOMICS:
 *
 *  1. The `Authorization` header really goes out. Without it every command would
 *     work against an admin API that never had a token configured, and fail
 *     confusingly everywhere else.
 *  2. A missing `GATEWAY_ADMIN_TOKEN` makes NO request. An unauthenticated probe
 *     is still a probe, and a CLI that sometimes works without a credential
 *     teaches an operator the credential is optional.
 *  3. A failing gateway's response body never reaches stderr. `--url` points
 *     wherever the operator says, and the things that sit at wrong URLs quote
 *     the request they rejected — recipient addresses and invite links included.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_URL,
  resolveBaseUrl,
  runCli,
  type CliIo,
} from '../../scripts/gw-api/cli.js';
import {
  LEAKED_INVITE_LINK,
  LEAKED_RECIPIENT,
  startFakeGateway,
  type FakeGateway,
} from '../support/fake-gateway-api.js';

const ADMIN_TOKEN = 'an-admin-token-that-is-long-enough';

const started: FakeGateway[] = [];

afterEach(async () => {
  await Promise.all(started.map((fake) => fake.close()));
  started.length = 0;
});

async function gateway(options: Parameters<typeof startFakeGateway>[0] = {}): Promise<FakeGateway> {
  const fake = await startFakeGateway(options);
  started.push(fake);
  return fake;
}

interface CliRun {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI with an explicit environment — never the ambient `process.env`. */
async function run(parts: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const code = await runCli({ argv: parts.argv, env: parts.env, io });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('auth wiring', () => {
  it('sends the admin token as a bearer credential', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'list', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(result.code).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it('never prints the admin token back, on success or on failure', async () => {
    const fake = await gateway({ scenario: { kind: 'leak', status: 401 } });

    const result = await run({
      argv: ['members', 'list', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(result.code).not.toBe(0);
    expect(`${result.out}\n${result.err}`).not.toContain(ADMIN_TOKEN);
    // It must still name the variable — that is the only thing the operator can act on.
    expect(result.err).toContain('GATEWAY_ADMIN_TOKEN');
  });
});

describe('target URL precedence — flag beats env beats default', () => {
  it('sends to --url when both are set', async () => {
    const flagged = await gateway({ name: 'the flag target' });
    const fromEnv = await gateway({ name: 'the env target' });

    await run({
      argv: ['members', 'list', '--url', flagged.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN, GATEWAY_URL: fromEnv.url },
    });

    expect(flagged.requests).toHaveLength(1);
    expect(fromEnv.requests).toHaveLength(0);
  });

  it('sends to GATEWAY_URL when there is no flag', async () => {
    const fromEnv = await gateway({ name: 'the env target' });

    await run({
      argv: ['members', 'list'],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN, GATEWAY_URL: fromEnv.url },
    });

    expect(fromEnv.requests).toHaveLength(1);
  });

  it('falls back to localhost:3602 when neither is set', () => {
    // Asserted through the resolver rather than a socket: the default is a FIXED
    // port, and a test that bound 3602 would fail on any machine already running
    // a gateway — which is most of the machines this suite runs on.
    expect(resolveBaseUrl({ flagUrl: undefined, envUrl: undefined })).toBe(DEFAULT_GATEWAY_URL);
    expect(DEFAULT_GATEWAY_URL).toBe('http://localhost:3602');
    expect(resolveBaseUrl({ flagUrl: undefined, envUrl: 'http://env.example:1' })).toBe(
      'http://env.example:1',
    );
    expect(resolveBaseUrl({ flagUrl: 'http://flag.example:2', envUrl: 'http://env.example:1' })).toBe(
      'http://flag.example:2',
    );
  });
});

describe('a missing admin token', () => {
  it('fails, names the variable, and makes NO request', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'list'],
      env: { GATEWAY_URL: fake.url },
    });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('GATEWAY_ADMIN_TOKEN');
    // The assertion that matters: the refusal happened before the socket.
    expect(fake.requests).toHaveLength(0);
  });

  it('treats an exported-but-blank variable as absent', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'list'],
      env: { GATEWAY_ADMIN_TOKEN: '   ', GATEWAY_URL: fake.url },
    });

    expect(result.code).not.toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('an error response that quotes the request back', () => {
  // The address passed on the command line is DELIBERATELY not the one the fake
  // echoes: that way "the recipient did not appear in stderr" can only be true
  // because the response body was never read.
  const PASSED_EMAIL = 'someone-else@example.test';

  for (const status of [401, 500]) {
    it(`carries no leaked payload into stderr on ${status}`, async () => {
      const fake = await gateway({ scenario: { kind: 'leak', status } });

      const result = await run({
        argv: ['invites', 'create', 'robin', '25', '--email', PASSED_EMAIL, '--url', fake.url],
        env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
      });

      expect(result.code).not.toBe(0);
      // It reached the server — otherwise the absence below proves nothing.
      expect(fake.requests).toHaveLength(1);

      const printed = `${result.out}\n${result.err}`;
      expect(printed).not.toContain(LEAKED_RECIPIENT);
      expect(printed).not.toContain(LEAKED_INVITE_LINK);
      expect(printed).not.toContain('/join#');
      expect(printed).not.toContain('inv_tok_must_never_print');
      // And it is still actionable: the status and the call we made.
      expect(result.err).toContain(String(status));
      expect(result.err).toContain('/admin/invites');
    });
  }
});

describe('--json', () => {
  it('prints a parseable body carrying the roster fields', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'list', '--json', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { members: { id: string; dailyLimit: number }[] };
    expect(parsed.members[0]?.id).toBe('alex');
    expect(parsed.members[0]?.dailyLimit).toBe(50);
  });
});

describe('the ordinary commands', () => {
  it('creates a member and prints the once-only token with its warning', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'add', 'robin', '25', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(result.code).toBe(0);
    expect(fake.requests[0]?.body).toEqual({ id: 'robin', dailyLimit: 25 });
    expect(result.out).toContain('gw_member_token_shown_once');
    expect(result.out).toContain('Do NOT paste it into a commit');
  });

  it('reads the healthcheck for status and the info endpoint for info', async () => {
    const fake = await gateway({ name: 'The Family Gateway' });

    const status = await run({
      argv: ['status', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const info = await run({
      argv: ['info', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(status.out).toContain('healthcheck ok');
    expect(info.out).toContain('The Family Gateway');
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/healthcheck',
      '/v1/gateway/info',
    ]);
  });

  it('refuses a daily limit that is not a whole number, before any request', async () => {
    const fake = await gateway();

    const result = await run({
      argv: ['members', 'add', 'robin', '25x', '--url', fake.url],
      env: { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN },
    });

    expect(result.code).not.toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});
