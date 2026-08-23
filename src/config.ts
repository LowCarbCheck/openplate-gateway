/**
 * Environment → typed config, zod-validated, with a PURE reader (`loadConfig`)
 * that takes the env bag as an argument. Nothing in this module reads
 * `process.env`, so every rule below is unit-testable by handing it an object.
 *
 * FAIL FAST, AND FAIL ONCE. A misconfiguration throws at boot rather than
 * degrading — a gateway that starts with no upstream address answers every
 * request with a 502, and an operator reads that as "the product is broken".
 * The throw names EVERY bad variable in one message: an operator bringing this
 * up for the first time typically has three things wrong, and a reader that
 * reports them one restart at a time turns that into three restarts.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. `UPSTREAM_API_KEY` IS NEVER LOGGED OR PUT IN AN ERROR MESSAGE. It is one
 *     shared provider key funding a whole household; leaking it is somebody
 *     else's bill. The messages below therefore name the VARIABLE and never
 *     interpolate its value — which is also why the key's schema is a bare
 *     `min(1)`: any richer validation would be tempted to quote what it
 *     rejected. Same discipline applies to `describeError`-style helpers: this
 *     module hands out no value-carrying strings at all.
 *  2. THIS MODULE MUST NOT IMPORT THE LOGGER. Config is what decides
 *     `LOG_LEVEL`, so it necessarily runs before a logger exists; a runtime
 *     import would be a bootstrap cycle waiting to happen. The one import from
 *     `logger.ts` below is `import type`, erased at compile time, so there is
 *     no runtime edge — it exists only so `Config.logLevel` and the logger
 *     agree on the same four names.
 *
 * `.env.example` is the operator-facing counterpart to this file and must be
 * kept in step with it.
 */
import { z } from 'zod';
import type { LogLevel } from './logger.js';
import type { GatewayMode } from './member-store.js';

/** Not 3600/3601 — those are taken by neighbouring services on the same host. */
export const DEFAULT_PORT = 3602;

/** 8 MB. A phone photo is 2–5 MB, and a base64 data URI inflates it by a third; this is headroom, not a target. */
export const DEFAULT_MAX_REQUEST_BYTES = 8_000_000;

/**
 * 120 s. A vision completion on a busy provider routinely takes 30–60 s, and
 * the failure mode of a short bound is worse than the failure mode of a long
 * one: we have already paid for the upstream call by the time we give up on it.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

/** Per member token, per minute. A burst guard, not the spend control — the daily quota is that. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

export const DEFAULT_MEMBERS_FILE = './members.json';
export const DEFAULT_QUOTA_STORE_FILE = './quota-store.json';
export const DEFAULT_MEMBER_STORE_FILE = './member-store.json';
export const DEFAULT_INVITE_STORE_FILE = './invite-store.json';
export const DEFAULT_AUDIT_STORE_FILE = './audit-log.jsonl';

/**
 * 20 MB. The org-mode audit path is the one path that BUFFERS a request rather
 * than streaming it, so this is a memory bound as much as a policy: it is the
 * most one request may hold in this process at once. It sits above
 * `DEFAULT_MAX_REQUEST_BYTES` so the ordinary size refusal stays the one an
 * operator tunes, and this stays the backstop.
 */
export const DEFAULT_AUDIT_MAX_BODY_BYTES = 20_971_520;

/** What `/v1/gateway/info` calls this instance when the operator has not named it. */
export const DEFAULT_GATEWAY_NAME = 'openplate gateway';

/**
 * 24 characters. Not a strength estimate — an admin token is minted by a
 * generator, not chosen by a human — but a floor that rejects the values people
 * actually paste in when they are in a hurry ("admin", a short password, a
 * date). The admin API can create members and read the whole roster, so a
 * guessable value here is a household-wide compromise.
 */
export const MIN_ADMIN_TOKEN_LENGTH = 24;

/** `'*'` means "any origin". Anything else is an exact-match allowlist. */
export type CorsAllowedOrigins = readonly string[] | '*';

/**
 * SMTP settings, ALL OR NOTHING.
 *
 * A half-configured mailer is the worst of the three states: the gateway boots,
 * the admin creates an invite with an email address, the send fails somewhere
 * inside a transport, and the operator is left with a burnt invite and a stack
 * trace. Either every field is present and this is an object, or none is and
 * this is `null` — there is no partial value to check for at a call site.
 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  /** The `From:` address. Never logged with the password beside it. */
  readonly from: string;
}

/**
 * Where org mode puts the images it stores. S3-COMPATIBLE, NOT AWS-SPECIFIC:
 * `endpoint` is mandatory precisely so MinIO, Garage, Ceph and a clinic's own
 * on-premise object store are first-class rather than a workaround. A gateway
 * that audits patient photographs is exactly the deployment that will not be
 * allowed to send them to us-east-1.
 *
 * ALL OR NOTHING, like `SmtpConfig` and for the same reason — a half-configured
 * bucket means the gateway boots, the requests flow, and the images silently go
 * nowhere while the operator believes they are being kept.
 */
export interface S3Config {
  /** Absolute http(s) URL. Required even on AWS, so there is one code path. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  /** Never logged, never put in an error message — same rule as `UPSTREAM_API_KEY`. */
  readonly secretAccessKey: string;
  /** MinIO and most self-hosted stores need this; AWS does not. */
  readonly forcePathStyle: boolean;
}

/** The org-mode audit block. Present exactly when `gatewayMode === 'org'`. */
export interface AuditConfig {
  readonly s3: S3Config;
  /** Records and their objects are deleted once they are older than this. */
  readonly retentionDays: number;
  /** Hard ceiling on a buffered request body. Over it: 413, nothing forwarded, nothing stored. */
  readonly maxBodyBytes: number;
  /** The JSONL file holding audit records. Written at runtime — see `audit/record-file.ts`. */
  readonly recordFile: string;
}

export interface Config {
  port: number;
  logLevel: LogLevel;
  /**
   * Base address of the upstream OpenAI-compatible provider. Any trailing
   * slash has been removed, so a caller may concatenate a path (`/v1/models`)
   * without checking. The trailing `/v1` is NOT stripped: unlike a local model
   * runtime, providers disagree about whether it belongs in the base URL, so
   * whatever the operator configured is what we call.
   */
  upstreamBaseUrl: string;
  /** The single shared provider key. Never log this, never put it in an error. */
  upstreamApiKey: string;
  /**
   * The LEGACY hand-edited registry, read once at boot and folded into the
   * member store. Absent is normal on an installation that never had one.
   */
  membersFile: string;
  /** JSON file holding per-member spend counters. Written at runtime. */
  quotaStoreFile: string;
  /** The authoritative member registry. Written at runtime — see `member-store.ts`. */
  memberStoreFile: string;
  /** Outstanding and spent invites. Written at runtime — see `invite-store.ts`. */
  inviteStoreFile: string;
  /** Bodies above this are refused with 413 before anything is forwarded upstream. */
  maxRequestBytes: number;
  upstreamTimeoutMs: number;
  rateLimitPerMinute: number;
  /** Already split and trimmed — see `CorsAllowedOrigins`. */
  corsAllowedOrigins: CorsAllowedOrigins;

  // ── The family/organisation surface ──────────────────────────────────────
  // Everything below arrived with ADR-0002. It is grouped rather than
  // interleaved so the next block (org mode and its audit settings) has an
  // obvious place to land, and so the diff that adds it does not touch the
  // upstream/limits fields above.

  /**
   * `null` DISABLES THE ADMIN API ENTIRELY, and the routes answer 404 rather
   * than 401 — see `admin-routes.ts`. A family gateway with no admin token must
   * not advertise that an admin surface exists at all.
   */
  adminToken: string | null;
  /** Shown to members by `/v1/gateway/info`, so they can tell two instances apart. */
  gatewayName: string;
  /** The model id members should ask for, or `null` if the operator has not pinned one. */
  advertisedModel: string | null;
  /**
   * The gateway's privacy posture, set by `ORG_MODE` and stamped onto every
   * member record. `family` is the default and keeps ADR-0001's no-body-storage
   * guarantee absolutely; `org` opts in to the audit pipeline described in
   * ADR-0003. A member stamped with one mode is refused by a gateway running the
   * other — see `member-auth.ts`.
   */
  gatewayMode: GatewayMode;
  /**
   * `null` IN FAMILY MODE, AND THAT NULL IS THE GUARANTEE. Nothing that can
   * write an image exists unless this is set: `create-app.ts` selects the audit
   * handler from `gatewayMode` once, at wiring time, and `audit/create-audit-log.ts`
   * is the only place an S3 client is constructed.
   */
  audit: AuditConfig | null;
  /** This gateway's externally reachable base URL. Required to build an invite link. */
  gatewayPublicUrl: string | null;
  /** Where the openplate client lives. Required to build an invite link. */
  clientBaseUrl: string | null;
  /** `null` when no SMTP is configured: invites are then copy-link only. */
  smtp: SmtpConfig | null;
}

/**
 * Strips absent and blank values so a `FOO=` line in a `.env` file means
 * "unset" rather than "the empty string". Without this, `z.coerce.number()`
 * turns `''` into `0` and a blank `RATE_LIMIT_PER_MINUTE=` would silently
 * configure a limiter that refuses every request.
 */
function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const compacted = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed) compacted.set(key, trimmed);
  }
  return Object.fromEntries(compacted);
}

const positiveInt = z.coerce.number().int().positive();

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

/**
 * True unless the value is a comma-salad that names no origin at all
 * (`","`, `", ,"`). Left as a string check rather than a transform so the
 * complaint lands in the same aggregated error as everything else.
 */
function namesAtLeastOneOrigin(value: string): boolean {
  return value === '*' || splitOrigins(value).length > 0;
}

function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** The five variables that make up the SMTP block. All or none — see `SmtpConfig`. */
const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

/**
 * The audit block's REQUIRED members: every one of these must be set when
 * `ORG_MODE=true`, and none of them may be set when it is not.
 *
 * `AUDIT_RETENTION_DAYS` is in this list rather than defaulted deliberately. A
 * default retention is a policy decision, and it is not ours to make: the
 * operator running an org gateway is the data controller, their retention
 * period comes from their own obligations, and a gateway that silently picked
 * ninety days would be answering a legal question on their behalf.
 */
const REQUIRED_AUDIT_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'AUDIT_RETENTION_DAYS',
] as const;

/** The audit block's OPTIONAL members. Defaulted in `loadConfig`, not in the schema — see below. */
const OPTIONAL_AUDIT_KEYS = ['S3_FORCE_PATH_STYLE', 'AUDIT_MAX_BODY_BYTES', 'AUDIT_STORE_FILE'] as const;

/**
 * `true`/`false`, and the digits people type instead. Deliberately NOT
 * "any non-empty string is true": `ORG_MODE=no` and `ORG_MODE=off` read as
 * "disabled" to every human being, and a flag that turns on audited storage of
 * photographs must never be enabled by a value the operator meant as "off".
 * Anything unrecognised is refused at boot rather than guessed at.
 */
const booleanFlag = z
  .string()
  .transform((value) => value.toLowerCase())
  .refine((value) => ['true', 'false', '1', '0'].includes(value), {
    message: 'must be `true` or `false`',
  })
  .transform((value) => value === 'true' || value === '1');

const absoluteHttpUrl = z.string().refine((value) => /^https?:\/\//.test(value), {
  message: 'must be an absolute http(s) URL',
});

const EnvSchemaFields = z.object({
  PORT: positiveInt.max(65_535).default(DEFAULT_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  UPSTREAM_BASE_URL: z.string().refine((value) => /^https?:\/\//.test(value), {
    message: 'must be an absolute http(s) URL, e.g. https://openrouter.ai/api/v1',
  }),
  // Deliberately just "non-empty": see rule 1 in the module header. A richer
  // check (prefix, length, charset) would differ per provider and would want to
  // quote the value it rejected.
  UPSTREAM_API_KEY: z.string().min(1, { message: 'must not be empty' }),
  MEMBERS_FILE: z.string().min(1).default(DEFAULT_MEMBERS_FILE),
  QUOTA_STORE_FILE: z.string().min(1).default(DEFAULT_QUOTA_STORE_FILE),
  MEMBER_STORE_FILE: z.string().min(1).default(DEFAULT_MEMBER_STORE_FILE),
  INVITE_STORE_FILE: z.string().min(1).default(DEFAULT_INVITE_STORE_FILE),
  MAX_REQUEST_BYTES: positiveInt.default(DEFAULT_MAX_REQUEST_BYTES),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(DEFAULT_UPSTREAM_TIMEOUT_MS),
  RATE_LIMIT_PER_MINUTE: positiveInt.default(DEFAULT_RATE_LIMIT_PER_MINUTE),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('*')
    .refine(namesAtLeastOneOrigin, {
      message: 'must be `*` or a comma-separated list of origins',
    }),

  // ── The family/organisation surface (ADR-0002) ───────────────────────────
  // Every one of these is optional: a gateway that sets none of them behaves
  // exactly as it did before ADR-0002, which is what keeps an existing `.env`
  // working across the upgrade.
  //
  // The length floor is the only validation on the admin token, for the same
  // reason `UPSTREAM_API_KEY` gets only `min(1)`: a richer check would be
  // tempted to quote what it rejected, and this value opens the roster.
  GATEWAY_ADMIN_TOKEN: z
    .string()
    .min(MIN_ADMIN_TOKEN_LENGTH, {
      message: `must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters — generate it, do not choose it`,
    })
    .optional(),
  GATEWAY_NAME: z.string().min(1).default(DEFAULT_GATEWAY_NAME),
  GATEWAY_ADVERTISED_MODEL: z.string().min(1).optional(),
  GATEWAY_PUBLIC_URL: absoluteHttpUrl.optional(),
  CLIENT_BASE_URL: absoluteHttpUrl.optional(),

  // ── Organisation mode and its audit block (ADR-0003) ─────────────────────
  // `ORG_MODE` is the ONE switch. Everything else in this block is refused
  // unless it is on — see the `superRefine` below — because an S3 credential
  // sitting in the environment of a family gateway is either a mistake or a
  // half-finished migration, and both deserve a boot failure rather than a
  // quietly ignored variable.
  //
  // The two defaulted values are `.optional()` here and defaulted in
  // `loadConfig` instead, so the "was this set?" test in the `superRefine` is
  // the same for every variable in the block. A schema default would make them
  // indistinguishable from an operator who set them by hand.
  ORG_MODE: booleanFlag.optional(),
  S3_ENDPOINT: absoluteHttpUrl.optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  // Bare `min(1)`, for the same reason as `UPSTREAM_API_KEY`: a richer check
  // would be tempted to quote what it rejected.
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanFlag.optional(),
  AUDIT_RETENTION_DAYS: positiveInt.optional(),
  AUDIT_MAX_BODY_BYTES: positiveInt.optional(),
  AUDIT_STORE_FILE: z.string().min(1).optional(),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: positiveInt.max(65_535).optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
});

/**
 * The cross-field rules, applied only after every field parsed.
 *
 * They live in a `superRefine` rather than in `loadConfig`'s body so their
 * complaints join the SAME aggregated message as everything else — an operator
 * setting up mail for the first time typically has two of these wrong at once,
 * and reporting them one restart at a time is the thing this module exists to
 * prevent. None of them may quote a value: `SMTP_PASS` is in scope here.
 */
const EnvSchema = EnvSchemaFields.superRefine((raw, ctx) => {
  const configuredSmtpKeys = SMTP_KEYS.filter((key) => raw[key] !== undefined);
  const isSmtpPartial = configuredSmtpKeys.length > 0 && configuredSmtpKeys.length < SMTP_KEYS.length;

  if (isSmtpPartial) {
    for (const key of SMTP_KEYS) {
      if (raw[key] !== undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required once any other SMTP_* variable is set (the block is all-or-nothing)',
      });
    }
  }

  // An invite email whose link points nowhere is worse than no email: the
  // recipient gets a broken button and the invite is already spent from the
  // operator's point of view. So mail configured at all demands both halves of
  // the link — see `mail/invite-message.ts`.
  const isSmtpConfigured = configuredSmtpKeys.length === SMTP_KEYS.length;
  if (isSmtpConfigured && raw.GATEWAY_PUBLIC_URL === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['GATEWAY_PUBLIC_URL'],
      message: 'is required when SMTP is configured — an invite email needs a link to this gateway',
    });
  }
  if (isSmtpConfigured && raw.CLIENT_BASE_URL === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['CLIENT_BASE_URL'],
      message: 'is required when SMTP is configured — an invite email needs a link to the client',
    });
  }

  // ── The audit block, all-or-nothing AND mode-gated ─────────────────────────
  //
  // Two rules, and the SECOND one is the interesting half:
  //
  //  1. ORG_MODE=true demands the whole block. A gateway that promises its
  //     members an audit trail and then cannot write one is worse than a family
  //     gateway: the promise is what the member consented on.
  //  2. ORG_MODE off REFUSES the block. A leftover `S3_BUCKET` on a family
  //     gateway is an operator who believes images are being kept — or a
  //     half-finished migration that will surprise somebody. Ignoring the
  //     variable silently is the one outcome that leaves them wrong for months.
  const isOrgMode = raw.ORG_MODE === true;
  if (isOrgMode) {
    for (const key of REQUIRED_AUDIT_KEYS) {
      if (raw[key] !== undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required when ORG_MODE=true (the audit block is all-or-nothing)',
      });
    }
    return;
  }

  for (const key of [...REQUIRED_AUDIT_KEYS, ...OPTIONAL_AUDIT_KEYS]) {
    if (raw[key] === undefined) continue;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: 'is only used when ORG_MODE=true — set ORG_MODE=true or remove this variable',
    });
  }
});

/** Drops trailing slashes so URL building never doubles them. */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** `'*'` passes through; anything else becomes a de-duplicated exact-match allowlist. */
function parseCorsAllowedOrigins(raw: string): CorsAllowedOrigins {
  if (raw === '*') return '*';
  return [...new Set(splitOrigins(raw))];
}

/**
 * Builds the config from an arbitrary env bag. Throws a single `Error` naming
 * every invalid or missing variable — never a value.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const present = compactEnv(env);
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        // zod renders an ABSENT variable as "expected string, received
        // undefined", which reads like a type bug rather than the thing the
        // operator actually has to do, so absent variables are rewritten to
        // "is required". Everything else keeps zod's own wording — a variable
        // the operator DID set is not missing, and telling them to set it
        // costs exactly the restart this module exists to save.
        //
        // Absence is decided by membership in `present`, the compacted bag
        // that is the authoritative record of what survived blank-stripping.
        // DO NOT "simplify" this back to `issue.input === undefined`: in zod 4
        // `input` is an internal raw-issue field, stripped from the finalized
        // issues `safeParse` returns, so it is ALWAYS undefined. That test is
        // a constant `true` and reports every unparseable value as unset.
        //
        // Neither branch may quote the offending value (rule 1 in the module
        // header). zod's own messages describe the expectation, not the input.
        const name = issue.path[0];
        const isAbsent =
          issue.code === 'invalid_type' && typeof name === 'string' && !Object.hasOwn(present, name);
        return `${issue.path.join('.') || '(root)'}: ${isAbsent ? 'is required' : issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid configuration — ${details} (see .env.example)`);
  }
  const raw = parsed.data;

  return {
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    upstreamBaseUrl: stripTrailingSlashes(raw.UPSTREAM_BASE_URL),
    upstreamApiKey: raw.UPSTREAM_API_KEY,
    membersFile: raw.MEMBERS_FILE,
    quotaStoreFile: raw.QUOTA_STORE_FILE,
    memberStoreFile: raw.MEMBER_STORE_FILE,
    inviteStoreFile: raw.INVITE_STORE_FILE,
    maxRequestBytes: raw.MAX_REQUEST_BYTES,
    upstreamTimeoutMs: raw.UPSTREAM_TIMEOUT_MS,
    rateLimitPerMinute: raw.RATE_LIMIT_PER_MINUTE,
    corsAllowedOrigins: parseCorsAllowedOrigins(raw.CORS_ALLOWED_ORIGINS),
    adminToken: raw.GATEWAY_ADMIN_TOKEN ?? null,
    gatewayName: raw.GATEWAY_NAME,
    advertisedModel: raw.GATEWAY_ADVERTISED_MODEL ?? null,
    // `family` unless the operator explicitly asked for the other thing. The
    // default is the mode that stores nothing — see ADR-0003.
    gatewayMode: raw.ORG_MODE === true ? 'org' : 'family',
    audit: parseAudit(raw),
    gatewayPublicUrl: raw.GATEWAY_PUBLIC_URL ?? null,
    clientBaseUrl: raw.CLIENT_BASE_URL ?? null,
    smtp: parseSmtp(raw),
  };
}

/**
 * `null` unless the whole block is present. The `superRefine` above has already
 * rejected a partial block, so reaching here with some-but-not-all is
 * impossible — the checks below are what make that impossibility legible to the
 * type system rather than an assertion.
 */
/**
 * `null` unless `ORG_MODE=true`. The `superRefine` above has already rejected
 * both partial states — an org gateway missing a bucket, and a family gateway
 * carrying one — so the checks below are what make those impossibilities legible
 * to the type system rather than an assertion.
 *
 * THE `null` IS LOAD-BEARING. It is what `create-app.ts` and
 * `audit/create-audit-log.ts` branch on, and it is why a family-mode process
 * never constructs an S3 client at all.
 */
function parseAudit(raw: z.infer<typeof EnvSchemaFields>): AuditConfig | null {
  if (raw.ORG_MODE !== true) return null;
  const {
    S3_ENDPOINT,
    S3_REGION,
    S3_BUCKET,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    AUDIT_RETENTION_DAYS,
  } = raw;
  if (
    S3_ENDPOINT === undefined ||
    S3_REGION === undefined ||
    S3_BUCKET === undefined ||
    S3_ACCESS_KEY_ID === undefined ||
    S3_SECRET_ACCESS_KEY === undefined ||
    AUDIT_RETENTION_DAYS === undefined
  ) {
    return null;
  }
  return {
    s3: {
      endpoint: stripTrailingSlashes(S3_ENDPOINT),
      region: S3_REGION,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      forcePathStyle: raw.S3_FORCE_PATH_STYLE ?? false,
    },
    retentionDays: AUDIT_RETENTION_DAYS,
    maxBodyBytes: raw.AUDIT_MAX_BODY_BYTES ?? DEFAULT_AUDIT_MAX_BODY_BYTES,
    recordFile: raw.AUDIT_STORE_FILE ?? DEFAULT_AUDIT_STORE_FILE,
  };
}

function parseSmtp(raw: z.infer<typeof EnvSchemaFields>): SmtpConfig | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = raw;
  if (
    SMTP_HOST === undefined ||
    SMTP_PORT === undefined ||
    SMTP_USER === undefined ||
    SMTP_PASS === undefined ||
    SMTP_FROM === undefined
  ) {
    return null;
  }
  return { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, pass: SMTP_PASS, from: SMTP_FROM };
}
