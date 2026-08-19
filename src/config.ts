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

/** `'*'` means "any origin". Anything else is an exact-match allowlist. */
export type CorsAllowedOrigins = readonly string[] | '*';

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
  /** JSON file mapping member tokens to names and daily quotas. */
  membersFile: string;
  /** JSON file holding per-member spend counters. Written at runtime. */
  quotaStoreFile: string;
  /** Bodies above this are refused with 413 before anything is forwarded upstream. */
  maxRequestBytes: number;
  upstreamTimeoutMs: number;
  rateLimitPerMinute: number;
  /** Already split and trimmed — see `CorsAllowedOrigins`. */
  corsAllowedOrigins: CorsAllowedOrigins;
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

const EnvSchema = z.object({
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
  MAX_REQUEST_BYTES: positiveInt.default(DEFAULT_MAX_REQUEST_BYTES),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(DEFAULT_UPSTREAM_TIMEOUT_MS),
  RATE_LIMIT_PER_MINUTE: positiveInt.default(DEFAULT_RATE_LIMIT_PER_MINUTE),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('*')
    .refine(namesAtLeastOneOrigin, {
      message: 'must be `*` or a comma-separated list of origins',
    }),
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
    maxRequestBytes: raw.MAX_REQUEST_BYTES,
    upstreamTimeoutMs: raw.UPSTREAM_TIMEOUT_MS,
    rateLimitPerMinute: raw.RATE_LIMIT_PER_MINUTE,
    corsAllowedOrigins: parseCorsAllowedOrigins(raw.CORS_ALLOWED_ORIGINS),
  };
}
