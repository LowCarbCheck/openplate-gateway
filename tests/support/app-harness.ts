/**
 * Boots the REAL app (`createApp`) on an ephemeral port with injectable parts.
 *
 * Every test in this suite drives the service over HTTP rather than calling
 * handlers directly, because most of what is asserted only exists on the wire:
 * status codes, `Retry-After`, the OpenAI error envelope, the CORS headers, the
 * body-parser limit. Nothing here reimplements a middleware chain — the whole
 * point of `create-app.ts` taking its dependencies as arguments is that a test
 * can boot the same chain production runs and swap only the quota store, the
 * logger and the clock.
 *
 * THE HARNESS ITSELF NEVER RECORDS A BODY. A fixture that stashed the request
 * for later inspection would be a second copy of the plate photograph in the
 * process, and `allObservableText` — the function the privacy test greps —
 * would then be asserting about a string the fixture, not the service, produced.
 */
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../../src/config.js';
import { createCapturingLogger, type CapturedLogLine, type Logger } from '../../src/logger.js';
import { parseMembers, type MemberRegistry } from '../../src/members.js';
import { createMemoryQuotaStore } from '../../src/quota/memory-store.js';
import type { QuotaStore } from '../../src/quota/types.js';
import { createApp } from '../../src/server/create-app.js';

/** The payer's key. A test asserts this never reaches the member or a log line. */
export const UPSTREAM_API_KEY = 'sk-upstream-payer-key-do-not-leak';

export const PRIMARY_MEMBER_TOKEN = 'opg_test_token_alex';
export const SECOND_MEMBER_TOKEN = 'opg_test_token_sam';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface TestMember {
  id: string;
  token: string;
  /** OMITTED, not zero, when a test wants the registry's deny-by-default to apply. */
  dailyLimit?: number;
}

export const DEFAULT_TEST_MEMBERS: readonly TestMember[] = [
  { id: 'alex', token: PRIMARY_MEMBER_TOKEN, dailyLimit: 50 },
  { id: 'sam', token: SECOND_MEMBER_TOKEN, dailyLimit: 50 },
];

/**
 * Builds a registry through the REAL `parseMembers`, so a test gets the schema's
 * defaulting and duplicate checks rather than a hand-made object that agrees
 * with the type but not with the parser.
 */
export function testRegistry(members: readonly TestMember[] = DEFAULT_TEST_MEMBERS): MemberRegistry {
  return parseMembers({
    members: members.map((member) => ({
      id: member.id,
      tokenSha256: sha256Hex(member.token),
      ...(member.dailyLimit === undefined ? {} : { dailyLimit: member.dailyLimit }),
    })),
  });
}

/**
 * Config through the real `loadConfig`, so the defaults and coercions under test
 * elsewhere are the ones every other test runs against too.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    // Unroutable by default: a test that forgets to point at the fake upstream
    // fails fast rather than reaching the internet.
    UPSTREAM_BASE_URL: 'http://127.0.0.1:1/v1',
    UPSTREAM_API_KEY,
    LOG_LEVEL: 'error',
  });
  return { ...base, ...overrides };
}

export interface TestResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

/** How a test names the credential it wants on the wire. */
export interface RequestAuthOptions {
  /** `null` omits the header. Omit the field for the primary member's token. */
  token?: string | null;
  /** A raw `Authorization` value, for the malformed-header cases. Wins over `token`. */
  authorization?: string | null;
}

export interface TestApp {
  baseUrl: string;
  config: Config;
  registry: MemberRegistry;
  quota: QuotaStore;
  logLines: CapturedLogLine[];
  post(path: string, body: unknown, options?: RequestAuthOptions): Promise<TestResponse>;
  /** Sends `raw` verbatim — the only way to put malformed JSON on the wire. */
  postRaw(
    path: string,
    raw: string,
    options?: RequestAuthOptions & { contentType?: string },
  ): Promise<TestResponse>;
  get(path: string, options?: RequestAuthOptions): Promise<TestResponse>;
  options(path: string, headers?: Record<string, string>): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface StartTestAppOptions {
  members?: readonly TestMember[];
  config?: Partial<Config>;
  /** Convenience: sets `config.upstreamBaseUrl` unless the config override already did. */
  upstreamBaseUrl?: string;
  quota?: QuotaStore;
  now?: () => Date;
  logger?: Logger;
}

function authHeadersFor(options: RequestAuthOptions | undefined): Record<string, string> {
  if (options?.authorization !== undefined) {
    return options.authorization === null ? {} : { Authorization: options.authorization };
  }
  if (options?.token === null) return {};
  return { Authorization: `Bearer ${options?.token ?? PRIMARY_MEMBER_TOKEN}` };
}

export async function startTestApp(options: StartTestAppOptions = {}): Promise<TestApp> {
  const configOverrides: Partial<Config> = { ...options.config };
  if (options.upstreamBaseUrl !== undefined && configOverrides.upstreamBaseUrl === undefined) {
    configOverrides.upstreamBaseUrl = options.upstreamBaseUrl;
  }
  const config = testConfig(configOverrides);
  const registry = testRegistry(options.members ?? DEFAULT_TEST_MEMBERS);
  const quota = options.quota ?? createMemoryQuotaStore();
  const captured = createCapturingLogger();

  const app = createApp({
    config,
    registry,
    quota,
    logger: options.logger ?? captured.logger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  // SAFETY: `app.listen` has already fired its `listening` event above, and this
  // server is bound to a TCP port (not a UNIX socket), so `address()` is an
  // `AddressInfo` here and never `null` or the pipe-name string.
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function send(
    method: string,
    path: string,
    rawBody: string | null,
    headers: Record<string, string>,
  ): Promise<TestResponse> {
    const init: RequestInit = { method, headers };
    if (rawBody !== null) init.body = rawBody;
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  return {
    baseUrl,
    config,
    registry,
    quota,
    logLines: captured.lines,
    post: (path, body, opts) =>
      send('POST', path, JSON.stringify(body), {
        'Content-Type': 'application/json',
        ...authHeadersFor(opts),
      }),
    postRaw: (path, raw, opts) =>
      send('POST', path, raw, {
        'Content-Type': opts?.contentType ?? 'application/json',
        ...authHeadersFor(opts),
      }),
    get: (path, opts) => send('GET', path, null, authHeadersFor(opts)),
    options: (path, headers = {}) => send('OPTIONS', path, null, headers),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A stand-in plate photograph.
 *
 * Deterministic rather than random so a failure is reproducible, and varied
 * rather than a repeated byte so the base64 is distinctive — a needle taken
 * from `AAAAAAAA...` could match a log line by accident and the assertion would
 * be worthless.
 */
export function makePhotoBytes(byteLength = 30_000): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let seed = 0x1234_5678;
  for (let index = 0; index < byteLength; index += 1) {
    // Numerical Recipes' LCG; both operands stay under 2^53, so the arithmetic
    // is exact and the sequence is byte-for-byte reproducible.
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    bytes[index] = (seed >>> 16) & 0xff;
  }
  // JPEG magic, so the payload is shaped like the thing it stands in for.
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

export function toDataUri(bytes: Buffer, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * A long, distinctive slice of the payload — what a leak would look like. 64
 * chars is above `scrub.ts`'s 48-char threshold, so a needle that survives is
 * unambiguously an unscrubbed payload rather than a short identifier.
 */
export function payloadNeedle(dataUri: string): string {
  return dataUri.slice(dataUri.indexOf(',') + 1, dataUri.indexOf(',') + 1 + 64);
}

/** The OpenAI-compatible request openplate sends: a text part, then the image part. */
export function chatRequest(dataUri: string, overrides: { model?: string; stream?: boolean } = {}) {
  return {
    model: overrides.model ?? 'some-vision-model',
    stream: overrides.stream ?? false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Identify the foods on this plate.' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };
}

/** Every string a test can see: the response text plus every captured log line. */
export function allObservableText(app: TestApp, responseText: string): string {
  return [responseText, ...app.logLines.map((line) => JSON.stringify(line))].join('\n');
}
