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
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog } from '../../src/audit/audit-log.js';
import { createAuditRecordFile } from '../../src/audit/record-file.js';
import type { AuditLog, AuditRecord } from '../../src/audit/types.js';
import { loadConfig, type AuditConfig, type Config } from '../../src/config.js';
import { createFileInviteStore, type InviteStore } from '../../src/invite-store.js';
import { createCapturingLogger, type CapturedLogLine, type Logger } from '../../src/logger.js';
import type { Mailer, OutgoingMail } from '../../src/mail/mailer.js';
import { createFileMemberStore, type MemberStore } from '../../src/member-store.js';
import { createMemoryQuotaStore } from '../../src/quota/memory-store.js';
import type { QuotaStore } from '../../src/quota/types.js';
import { createApp } from '../../src/server/create-app.js';
import { createRecordingObjectStore, type RecordingObjectStore } from './fake-object-store.js';

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
  /** OMITTED, not zero, when a test wants the store's deny-by-default to apply. */
  dailyLimit?: number;
  /** Revoked after creation, the way the admin API does it. */
  revoked?: boolean;
  /** Defaults to `family`, matching the gateway's only shipped mode. */
  mode?: 'family' | 'org';
}

export const DEFAULT_TEST_MEMBERS: readonly TestMember[] = [
  { id: 'alex', token: PRIMARY_MEMBER_TOKEN, dailyLimit: 50 },
  { id: 'sam', token: SECOND_MEMBER_TOKEN, dailyLimit: 50 },
];

/**
 * A throwaway state directory. The member and invite stores are real file
 * stores in every test, not fakes: their locking and their atomic rename are
 * part of what the behaviour under test depends on, and a fake would agree with
 * the interface while disagreeing with the thing that runs in production.
 */
export async function makeStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'opgw-test-'));
}

/**
 * Seeds members into a real store through the REAL `create`, so a test gets the
 * schema's defaulting and duplicate checks rather than a hand-made object that
 * agrees with the type but not with the store.
 */
export async function seedMembers(
  store: MemberStore,
  members: readonly TestMember[],
): Promise<void> {
  for (const member of members) {
    await store.create({
      id: member.id,
      tokenSha256: sha256Hex(member.token),
      // Deny-by-default lives in the store's schema; a test that omits the
      // field is asking for exactly that, so zero is passed explicitly here
      // rather than left to a second defaulting layer in the harness.
      dailyLimit: member.dailyLimit ?? 0,
      mode: member.mode ?? 'family',
    });
    if (member.revoked === true) await store.revoke(member.id);
  }
}

/** A mailer that records instead of sending. No SMTP anywhere in the unit suite. */
export interface RecordingMailer extends Mailer {
  readonly sent: OutgoingMail[];
}

export function createRecordingMailer(options: { failing?: boolean } = {}): RecordingMailer {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    send: (mail: OutgoingMail): Promise<void> => {
      if (options.failing === true) return Promise.reject(new Error('smtp is down'));
      sent.push(mail);
      return Promise.resolve();
    },
  };
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

/**
 * The org-mode environment, through the REAL `loadConfig` — so an org test runs
 * against exactly the config an operator's `.env` produces, including the
 * all-or-nothing rules. The S3 values are placeholders: no test constructs the
 * real adapter, and `createRecordingObjectStore` stands in for the bucket.
 */
export function orgTestConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    UPSTREAM_BASE_URL: 'http://127.0.0.1:1/v1',
    UPSTREAM_API_KEY,
    LOG_LEVEL: 'error',
    ORG_MODE: 'true',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'openplate-audit-test',
    S3_ACCESS_KEY_ID: 'test-access-key-id',
    S3_SECRET_ACCESS_KEY: 'test-secret-access-key',
    AUDIT_RETENTION_DAYS: '30',
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
  members: MemberStore;
  invites: InviteStore;
  quota: QuotaStore;
  mailer: RecordingMailer;
  /** The throwaway directory holding the member and invite store files. */
  stateDir: string;
  logLines: CapturedLogLine[];
  /** The fake bucket, in org mode. `null` in family mode — there is nothing to store into. */
  objects: RecordingObjectStore | null;
  /** The audit log the app was wired with, in org mode. `null` in family mode. */
  audit: AuditLog | null;
  /** Every audit record on disk. `[]` in family mode, where the file is never created. */
  auditRecords(): Promise<readonly AuditRecord[]>;
  post(path: string, body: unknown, options?: RequestAuthOptions): Promise<TestResponse>;
  /** Sends `raw` verbatim — the only way to put malformed JSON on the wire. */
  postRaw(
    path: string,
    raw: string,
    options?: RequestAuthOptions & { contentType?: string },
  ): Promise<TestResponse>;
  get(path: string, options?: RequestAuthOptions): Promise<TestResponse>;
  options(path: string, headers?: Record<string, string>): Promise<TestResponse>;
  delete(path: string, options?: RequestAuthOptions): Promise<TestResponse>;
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
  mailer?: RecordingMailer;
  /** Reuse a state directory across two `startTestApp` calls, to test a second boot. */
  stateDir?: string;
  /**
   * Boots the gateway in ORG_MODE, with a fake bucket and an audit log rooted in
   * the state directory. Members default to `mode: 'org'` so they authenticate —
   * a family-stamped member is refused by an org gateway, which is the behaviour
   * `member-revocation.test.ts` already covers.
   */
  org?: boolean;
  /** Overrides for the org audit block — retention and the body cap. */
  auditOverrides?: Partial<Pick<AuditConfig, 'retentionDays' | 'maxBodyBytes'>>;
  /** Inject a bucket, e.g. one whose `put` fails. Defaults to a fresh recording one. */
  objects?: RecordingObjectStore;
  /** Inject the audit log itself — for asserting it is never touched in family mode. */
  audit?: AuditLog;
}

/** A generated admin token that clears the configured minimum length. */
export function makeAdminToken(): string {
  return `opgwa_${randomBytes(24).toString('base64url')}`;
}

/** How a test names the admin credential it wants on the wire. */
export function adminAuth(token: string): RequestAuthOptions {
  return { authorization: `Bearer ${token}` };
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
  const stateDir = options.stateDir ?? (await makeStateDir());
  if (configOverrides.memberStoreFile === undefined) {
    configOverrides.memberStoreFile = join(stateDir, 'member-store.json');
  }
  if (configOverrides.inviteStoreFile === undefined) {
    configOverrides.inviteStoreFile = join(stateDir, 'invite-store.json');
  }

  const isOrg = options.org === true;
  if (isOrg && configOverrides.audit === undefined) {
    // The audit log must live in the throwaway directory, not in the repository
    // root, which is where the config default points.
    const base = orgTestConfig().audit;
    if (base === null) throw new Error('orgTestConfig produced no audit block');
    configOverrides.audit = {
      ...base,
      ...options.auditOverrides,
      recordFile: join(stateDir, 'audit-log.jsonl'),
    };
  }

  const config = isOrg ? orgTestConfig(configOverrides) : testConfig(configOverrides);
  const clock = options.now === undefined ? {} : { now: options.now };
  const memberStore = createFileMemberStore(config.memberStoreFile, clock);
  const inviteStore = createFileInviteStore(config.inviteStoreFile, clock);
  const defaultMembers = isOrg
    ? DEFAULT_TEST_MEMBERS.map((member) => ({ ...member, mode: 'org' as const }))
    : DEFAULT_TEST_MEMBERS;
  await seedMembers(memberStore, options.members ?? defaultMembers);

  const quota = options.quota ?? createMemoryQuotaStore();
  const mailer = options.mailer ?? createRecordingMailer();
  const captured = createCapturingLogger();
  const logger = options.logger ?? captured.logger;

  // The bucket exists only in org mode. In family mode there is deliberately
  // nothing to store into, and `createApp` refuses an audit log it was not
  // supposed to get.
  const objects = isOrg ? (options.objects ?? createRecordingObjectStore()) : null;
  const audit = buildTestAuditLog({ config, objects, logger, injected: options.audit });

  const app = createApp({
    config,
    members: memberStore,
    invites: inviteStore,
    quota,
    mailer,
    logger,
    audit,
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
    members: memberStore,
    invites: inviteStore,
    quota,
    mailer,
    stateDir,
    logLines: captured.lines,
    objects,
    audit,
    auditRecords: async (): Promise<readonly AuditRecord[]> => {
      if (config.audit === null) return [];
      // Read through the REAL record file, so a test sees what an admin would
      // rather than an in-memory copy the harness kept.
      const { records } = await createAuditRecordFile(config.audit.recordFile).all();
      return records;
    },
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
    delete: (path, opts) => send('DELETE', path, null, authHeadersFor(opts)),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The state directory is only removed when this harness created it — a
      // caller reusing one across two boots owns its lifetime.
      if (options.stateDir === undefined) await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * The audit log a test app is wired with.
 *
 * `injected` wins even in family mode — that is deliberate, and it is what lets
 * a test prove `createApp` REFUSES an audit log on a family gateway rather than
 * quietly accepting one it will never use.
 */
function buildTestAuditLog(parts: {
  config: Config;
  objects: RecordingObjectStore | null;
  logger: Logger;
  injected?: AuditLog;
}): AuditLog | null {
  if (parts.injected !== undefined) return parts.injected;
  if (parts.objects === null || parts.config.audit === null) return null;
  return createAuditLog({
    records: createAuditRecordFile(parts.config.audit.recordFile),
    objects: parts.objects,
    retentionDays: parts.config.audit.retentionDays,
    logger: parts.logger,
  });
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

/**
 * Waits for a condition, or fails loudly.
 *
 * The org-mode audit write is deliberately NOT awaited on the request path — the
 * member has their answer before it starts — so an assertion about the record
 * has to wait for it. Bounded and explicit: a poll that could spin forever would
 * turn a real regression into a hung suite rather than a failure.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${options.what ?? 'a condition'}`);
}

/** Every string a test can see: the response text plus every captured log line. */
export function allObservableText(app: TestApp, responseText: string): string {
  return [responseText, ...app.logLines.map((line) => JSON.stringify(line))].join('\n');
}
