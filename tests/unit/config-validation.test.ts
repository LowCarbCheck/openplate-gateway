/**
 * `loadConfig` is pure — it takes the env bag as an argument — so every rule it
 * enforces can be tested by handing it an object.
 *
 * TWO OF THESE ARE SECURITY ASSERTIONS, NOT ERGONOMICS. `UPSTREAM_API_KEY` is
 * one shared provider key funding a whole household, and a boot failure is the
 * most-pasted text in any support thread; the error message must name the
 * VARIABLE and never its value. And a blank `FOO=` line must mean "unset"
 * rather than "the empty string", because `z.coerce.number()` turns `''` into
 * `0` — a blank `RATE_LIMIT_PER_MINUTE=` would otherwise configure a limiter
 * that refuses every request, which reads as a broken deployment.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  loadConfig,
} from '../../src/config.js';

const MINIMAL = {
  UPSTREAM_BASE_URL: 'https://openrouter.ai/api/v1',
  UPSTREAM_API_KEY: 'sk-a-real-looking-secret',
};

describe('loadConfig', () => {
  it('fills every default from the two required variables', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config).toMatchObject({
      port: DEFAULT_PORT,
      logLevel: 'info',
      upstreamBaseUrl: 'https://openrouter.ai/api/v1',
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
      rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
      corsAllowedOrigins: '*',
    });
  });

  it('names EVERY bad variable in one message, not one restart at a time', () => {
    // An operator bringing this up for the first time typically has three things
    // wrong. Reporting them one at a time turns that into three restarts.
    let message = '';
    try {
      loadConfig({ PORT: 'not-a-number', RATE_LIMIT_PER_MINUTE: '-4' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('UPSTREAM_BASE_URL');
    expect(message).toContain('UPSTREAM_API_KEY');
    expect(message).toContain('PORT');
    expect(message).toContain('RATE_LIMIT_PER_MINUTE');
    expect(message).toContain('.env.example');
  });

  it('says "is required" for an absent variable rather than a type-bug sentence', () => {
    expect(() => loadConfig({})).toThrow(/UPSTREAM_BASE_URL: is required/);
  });

  it('does NOT say "is required" for a variable that is set but unparseable', () => {
    // The distinction this whole message exists for. Telling an operator to set
    // MAX_REQUEST_BYTES when they can see MAX_REQUEST_BYTES=8mb in their .env
    // buys them exactly the extra restart the aggregated error was meant to
    // save, and sends them looking in the wrong file.
    for (const env of [
      { ...MINIMAL, MAX_REQUEST_BYTES: '8mb' },
      { ...MINIMAL, PORT: 'eighty' },
      { ...MINIMAL, UPSTREAM_TIMEOUT_MS: '2min' },
    ]) {
      let message = '';
      try {
        loadConfig(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toBe('');
      expect(message).not.toContain('is required');
      // ...and it still has to say something about the value, not just the name.
      expect(message).toMatch(/expected number/);
    }
  });

  it('distinguishes an absent variable from a present-but-invalid one in one message', () => {
    // Both failures in a single throw, each with its own wording.
    let message = '';
    try {
      loadConfig({ UPSTREAM_API_KEY: 'sk-a-real-looking-secret', PORT: 'eighty' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('UPSTREAM_BASE_URL: is required');
    expect(message).toContain('PORT: ');
    expect(message).not.toContain('PORT: is required');
  });

  it('never quotes the rejected value, even for a variable that was set', () => {
    // The wording fix must not be paid for by pasting the input into the error:
    // the same message would happily carry UPSTREAM_API_KEY's value.
    let message = '';
    try {
      loadConfig({ ...MINIMAL, MAX_REQUEST_BYTES: '8mb', PORT: 'eighty' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('MAX_REQUEST_BYTES');
    expect(message).toContain('PORT');
    expect(message).not.toContain('8mb');
    expect(message).not.toContain('eighty');
    expect(message).not.toContain(MINIMAL.UPSTREAM_API_KEY);
  });

  it('NEVER puts the provider key in the error message', () => {
    // The one assertion in this file that costs money if it regresses.
    const secret = 'sk-super-secret-do-not-print-me';
    let message = '';
    try {
      loadConfig({ UPSTREAM_BASE_URL: 'not-a-url', UPSTREAM_API_KEY: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('UPSTREAM_BASE_URL');
    expect(message).not.toContain(secret);
  });

  it('names variables and NEVER the values they were given', () => {
    // The generalisation of the assertion above, and the one that actually
    // discriminates: a reader that appended `(got \${input})` to each issue
    // would pass every other test in this file and print a secret the first
    // time an operator got two variables wrong at once.
    const secret = 'sk-super-secret-do-not-print-me';
    let message = '';
    try {
      loadConfig({
        UPSTREAM_BASE_URL: 'ftp://wrong-scheme.test',
        UPSTREAM_API_KEY: secret,
        PORT: 'definitely-not-a-port',
        RATE_LIMIT_PER_MINUTE: '-9',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('UPSTREAM_BASE_URL');
    expect(message).toContain('PORT');
    expect(message).toContain('RATE_LIMIT_PER_MINUTE');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('ftp://wrong-scheme.test');
    expect(message).not.toContain('definitely-not-a-port');
  });

  it('treats a blank value as unset rather than as the empty string', () => {
    const config = loadConfig({ ...MINIMAL, RATE_LIMIT_PER_MINUTE: '   ', LOG_LEVEL: '' });

    // A coerced '' would be 0 — a limiter that refuses every request.
    expect(config.rateLimitPerMinute).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(config.logLevel).toBe('info');
  });

  it('strips trailing slashes from the base URL but keeps the /v1', () => {
    // Providers disagree about whether `/v1` belongs in the base URL, so whatever
    // the operator configured is what we call.
    const config = loadConfig({ ...MINIMAL, UPSTREAM_BASE_URL: 'https://example.test/api/v1///' });
    expect(config.upstreamBaseUrl).toBe('https://example.test/api/v1');
  });

  it('rejects a base URL that is not absolute http(s)', () => {
    expect(() => loadConfig({ ...MINIMAL, UPSTREAM_BASE_URL: 'example.test/v1' })).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it('parses a CORS allowlist, trimming and de-duplicating it', () => {
    const config = loadConfig({
      ...MINIMAL,
      CORS_ALLOWED_ORIGINS: 'https://a.test, https://b.test ,https://a.test',
    });
    expect(config.corsAllowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  it('rejects a comma salad that names no origin at all', () => {
    expect(() => loadConfig({ ...MINIMAL, CORS_ALLOWED_ORIGINS: ' , , ' })).toThrow(
      /must be `\*` or a comma-separated list/,
    );
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadConfig({ ...MINIMAL, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...MINIMAL, PORT: '0' })).toThrow(/PORT/);
  });

  it('rejects an unknown log level rather than silently falling back', () => {
    expect(() => loadConfig({ ...MINIMAL, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
