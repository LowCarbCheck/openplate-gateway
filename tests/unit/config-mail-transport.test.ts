/**
 * WHICH MAIL TRANSPORT, decided entirely by which block the operator filled in.
 *
 * There is no `MAIL_PROVIDER` variable and there is no precedence. Selection is
 * by inference — the existing house pattern, the same one `ORG_MODE` and the
 * SMTP block already use — because a fourth variable naming the transport is a
 * fourth thing that can disagree with the other three, and a precedence rule is
 * a policy an operator cannot see: they would read their own `.env`, find the
 * transport they just configured, and watch mail leave through the other one.
 *
 * So the interesting tests here are the refusals. Both blocks set is a boot
 * failure naming both. A partial block is a boot failure naming every variable
 * still missing — one message, not one restart per variable, which is the rule
 * `config.ts` exists to keep.
 *
 * `MAIL_API_KEY` can send mail as the operator, so the last test in the block
 * asserts what `config-family-blocks.test.ts` asserts about `SMTP_PASS`: a boot
 * error is the most-pasted text in any support thread, and this credential must
 * never be in one.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const MINIMAL = {
  UPSTREAM_BASE_URL: 'https://openrouter.ai/api/v1',
  UPSTREAM_API_KEY: 'sk-a-real-looking-secret',
};

const LINKS = {
  GATEWAY_PUBLIC_URL: 'https://gateway.example.test',
  CLIENT_BASE_URL: 'https://app.example.test',
};

const MAIL_API = {
  MAIL_API_URL: 'http://mail.internal.test:3601/v1/emails',
  MAIL_API_KEY: 'a-mail-api-key-that-must-never-be-printed',
  MAIL_API_FROM: 'gateway@example.test',
};

const SMTP = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'gateway',
  SMTP_PASS: 'a-password-that-must-never-be-printed',
  SMTP_FROM: 'gateway@example.test',
};

const MAIL_API_NAMES = ['MAIL_API_URL', 'MAIL_API_KEY', 'MAIL_API_FROM'] as const;

function messageFrom(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

/** Every 1-of-3 and 2-of-3 subset of the block. The all-or-nothing rule, exhaustively. */
function partialSubsets(): (typeof MAIL_API_NAMES[number])[][] {
  const subsets: (typeof MAIL_API_NAMES[number])[][] = [];
  for (const name of MAIL_API_NAMES) subsets.push([name]);
  subsets.push(['MAIL_API_URL', 'MAIL_API_KEY']);
  subsets.push(['MAIL_API_URL', 'MAIL_API_FROM']);
  subsets.push(['MAIL_API_KEY', 'MAIL_API_FROM']);
  return subsets;
}

describe('the MAIL_API block is all-or-nothing', () => {
  for (const subset of partialSubsets()) {
    it(`refuses to boot on a partial block, naming every missing variable (${subset.join('+')})`, () => {
      const env: NodeJS.ProcessEnv = { ...MINIMAL, ...LINKS };
      for (const name of subset) env[name] = MAIL_API[name];

      const message = messageFrom(env);

      expect(message).toContain('Invalid configuration');
      for (const name of MAIL_API_NAMES) {
        if (subset.includes(name)) continue;
        // In ONE message. An operator bringing mail up for the first time
        // typically has two of these wrong at once.
        expect(message, name).toContain(name);
      }
      expect(message).toContain('all-or-nothing');
    });
  }

  it('NEVER puts MAIL_API_KEY in the error message', () => {
    // The one assertion in this file that leaks a credential if it regresses.
    const message = messageFrom({ ...MINIMAL, ...LINKS, MAIL_API_KEY: MAIL_API.MAIL_API_KEY });

    expect(message).toContain('MAIL_API_URL');
    expect(message).not.toContain(MAIL_API.MAIL_API_KEY);
  });

  it('rejects a MAIL_API_URL that is not an absolute http(s) URL', () => {
    // It is POSTed to verbatim, so a host with no scheme is a send that cannot
    // work — and it would fail on the first invite, in production.
    const message = messageFrom({ ...MINIMAL, ...LINKS, ...MAIL_API, MAIL_API_URL: 'mail.internal.test/v1/emails' });

    expect(message).toContain('MAIL_API_URL');
    expect(message).toContain('absolute http(s) URL');
  });
});

describe('the two transports are mutually exclusive', () => {
  it('REFUSES a whole SMTP block and a whole MAIL_API block together, naming both', () => {
    // No precedence. Silently picking one is the outcome this refuses: the
    // operator has either half-finished a migration or edited the wrong file,
    // and both deserve to be told at boot rather than discovered from a header.
    const message = messageFrom({ ...MINIMAL, ...LINKS, ...SMTP, ...MAIL_API });

    expect(message).toContain('Invalid configuration');
    expect(message).toContain('SMTP_');
    expect(message).toContain('MAIL_API_');
    expect(message).toContain('exactly one mail transport');
  });

  it('still refuses when only the MAIL_API half would have won a precedence rule', () => {
    // Same environment, asserted from the other side: `loadConfig` throws, so
    // no `mail` value of either transport is ever produced from it.
    expect(() => loadConfig({ ...MINIMAL, ...LINKS, ...SMTP, ...MAIL_API })).toThrow();
  });
});

describe('the transport each block selects', () => {
  it('produces an http transport from the MAIL_API block alone', () => {
    const config = loadConfig({ ...MINIMAL, ...LINKS, ...MAIL_API });

    expect(config.mail).toEqual({
      transport: 'http',
      http: {
        url: MAIL_API.MAIL_API_URL,
        apiKey: MAIL_API.MAIL_API_KEY,
        from: MAIL_API.MAIL_API_FROM,
      },
    });
  });

  it('still produces an smtp transport from the SMTP block alone', () => {
    // The regression guard for the union refactor: the transport that already
    // existed must not have become the "other" case of a new type.
    const config = loadConfig({ ...MINIMAL, ...LINKS, ...SMTP });

    expect(config.mail).toEqual({
      transport: 'smtp',
      smtp: {
        host: 'smtp.example.test',
        port: 587,
        user: 'gateway',
        pass: SMTP.SMTP_PASS,
        from: 'gateway@example.test',
      },
    });
  });

  it('is null when a blank-valued block is the only thing set', () => {
    // `MAIL_API_URL=` in a `.env` file means "unset", not "the empty string" —
    // `compactEnv` strips it, so this is the no-mail deployment and NOT a
    // partial block. Getting this wrong would refuse to boot a gateway whose
    // operator commented the block out by emptying it.
    const config = loadConfig({
      ...MINIMAL,
      MAIL_API_URL: '',
      MAIL_API_KEY: '   ',
      MAIL_API_FROM: '',
    });

    expect(config.mail).toBeNull();
  });

  it('demands both link halves once the MAIL_API block is configured', () => {
    // Same rule the SMTP block already carries: an invite email whose link
    // points nowhere is worse than no email at all.
    const message = messageFrom({ ...MINIMAL, ...MAIL_API });

    expect(message).toContain('GATEWAY_PUBLIC_URL');
    expect(message).toContain('CLIENT_BASE_URL');
  });
});
