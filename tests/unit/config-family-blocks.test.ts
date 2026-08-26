/**
 * The config blocks ADR-0002 added: the admin token, the gateway identity, and
 * the all-or-nothing SMTP block.
 *
 * TWO OF THESE ARE SECURITY ASSERTIONS. `GATEWAY_ADMIN_TOKEN` opens the whole
 * roster, so a short one is refused rather than accepted with a warning nobody
 * reads. And `SMTP_PASS` must never appear in a boot error — a boot failure is
 * the most-pasted text in any support thread, and an operator configuring mail
 * for the first time is exactly the person who will trigger one.
 *
 * The all-or-nothing rule exists because the half-configured state is the worst
 * of the three: the gateway boots, the invite is created, the send fails inside
 * a transport, and the operator is left holding a burnt invite and a stack trace.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_NAME,
  DEFAULT_INVITE_STORE_FILE,
  DEFAULT_MEMBER_STORE_FILE,
  MIN_ADMIN_TOKEN_LENGTH,
  loadConfig,
} from '../../src/config.js';

const MINIMAL = {
  UPSTREAM_BASE_URL: 'https://openrouter.ai/api/v1',
  UPSTREAM_API_KEY: 'sk-a-real-looking-secret',
};

const SMTP = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'gateway',
  SMTP_PASS: 'a-password-that-must-never-be-printed',
  SMTP_FROM: 'gateway@example.test',
};

const LINKS = {
  GATEWAY_PUBLIC_URL: 'https://gateway.example.test',
  CLIENT_BASE_URL: 'https://app.example.test',
};

function messageFrom(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('the defaults, so an existing .env keeps working across the upgrade', () => {
  it('leaves every ADR-0002 field at a safe default when none is set', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config).toMatchObject({
      // No admin token means the admin API does not exist at all.
      adminToken: null,
      gatewayName: DEFAULT_GATEWAY_NAME,
      advertisedModel: null,
      gatewayMode: 'family',
      gatewayPublicUrl: null,
      clientBaseUrl: null,
      mail: null,
      memberStoreFile: DEFAULT_MEMBER_STORE_FILE,
      inviteStoreFile: DEFAULT_INVITE_STORE_FILE,
    });
  });
});

describe('GATEWAY_ADMIN_TOKEN', () => {
  it('is accepted at the minimum length', () => {
    const token = 'x'.repeat(MIN_ADMIN_TOKEN_LENGTH);

    expect(loadConfig({ ...MINIMAL, GATEWAY_ADMIN_TOKEN: token }).adminToken).toBe(token);
  });

  it('is REFUSED below it, rather than accepted with a warning nobody reads', () => {
    const message = messageFrom({ ...MINIMAL, GATEWAY_ADMIN_TOKEN: 'admin' });

    expect(message).toContain('GATEWAY_ADMIN_TOKEN');
    expect(message).toContain(String(MIN_ADMIN_TOKEN_LENGTH));
  });

  it('never quotes the rejected token', () => {
    const attempt = 'hunter2-but-short';
    const message = messageFrom({ ...MINIMAL, GATEWAY_ADMIN_TOKEN: attempt });

    expect(message).toContain('GATEWAY_ADMIN_TOKEN');
    expect(message).not.toContain(attempt);
  });
});

describe('the SMTP block is all-or-nothing', () => {
  it('accepts the whole block, with the link URLs it needs', () => {
    const config = loadConfig({ ...MINIMAL, ...SMTP, ...LINKS });

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

  it('names EVERY missing SMTP variable in one message, not one restart at a time', () => {
    const message = messageFrom({ ...MINIMAL, SMTP_HOST: 'smtp.example.test' });

    for (const name of ['SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
      expect(message, name).toContain(name);
    }
    expect(message).toContain('all-or-nothing');
  });

  it('NEVER puts SMTP_PASS in the error message', () => {
    // The one assertion in this file that leaks a credential if it regresses.
    const message = messageFrom({ ...MINIMAL, SMTP_PASS: SMTP.SMTP_PASS });

    expect(message).toContain('SMTP_HOST');
    expect(message).not.toContain(SMTP.SMTP_PASS);
  });

  it('demands both link halves once SMTP is configured', () => {
    // An invite email whose link points nowhere is worse than no email: the
    // recipient gets a broken button and the invite is already spent.
    const message = messageFrom({ ...MINIMAL, ...SMTP });

    expect(message).toContain('GATEWAY_PUBLIC_URL');
    expect(message).toContain('CLIENT_BASE_URL');
  });

  it('allows the link URLs WITHOUT SMTP, because copy-link is the primary flow', () => {
    const config = loadConfig({ ...MINIMAL, ...LINKS });

    expect(config.mail).toBeNull();
    expect(config.gatewayPublicUrl).toBe('https://gateway.example.test');
    expect(config.clientBaseUrl).toBe('https://app.example.test');
  });

  it('rejects a link URL that is not absolute http(s)', () => {
    expect(() => loadConfig({ ...MINIMAL, CLIENT_BASE_URL: 'app.example.test' })).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it('reports a bad SMTP_PORT without saying it is missing', () => {
    const message = messageFrom({ ...MINIMAL, ...SMTP, ...LINKS, SMTP_PORT: 'five-eight-seven' });

    expect(message).toContain('SMTP_PORT');
    expect(message).not.toContain('SMTP_PORT: is required');
  });
});

describe('the gateway identity', () => {
  it('carries a name and an advertised model when the operator sets them', () => {
    const config = loadConfig({
      ...MINIMAL,
      GATEWAY_NAME: 'The Family Gateway',
      GATEWAY_ADVERTISED_MODEL: 'mistral-small-latest',
    });

    expect(config.gatewayName).toBe('The Family Gateway');
    expect(config.advertisedModel).toBe('mistral-small-latest');
  });

  it('treats blank values as unset rather than as the empty string', () => {
    const config = loadConfig({ ...MINIMAL, GATEWAY_NAME: '   ', GATEWAY_ADVERTISED_MODEL: '' });

    expect(config.gatewayName).toBe(DEFAULT_GATEWAY_NAME);
    expect(config.advertisedModel).toBeNull();
  });

  it('is fixed to family mode, which is the only mode that is implemented', () => {
    expect(loadConfig({ ...MINIMAL }).gatewayMode).toBe('family');
  });
});
