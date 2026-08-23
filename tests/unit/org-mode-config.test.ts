/**
 * The `ORG_MODE` config matrix.
 *
 * TWO OF THESE ARE THE FEATURE'S SAFETY RAILS, not tidiness:
 *
 *  - A gateway is `family` unless the operator wrote `ORG_MODE=true`. Every
 *    typo, every truthy-looking value, every half-migration lands on the mode
 *    that stores nothing.
 *  - `ORG_MODE=false` with an `S3_BUCKET` beside it is REFUSED at boot rather
 *    than ignored. An ignored bucket is an operator who believes images are
 *    being kept, and they would have no way to find out otherwise.
 *
 * And `S3_SECRET_ACCESS_KEY` must never appear in a boot error, for the same
 * reason `SMTP_PASS` must not: a boot failure is the most-pasted text in any
 * support thread.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_MAX_BODY_BYTES,
  DEFAULT_AUDIT_STORE_FILE,
  loadConfig,
} from '../../src/config.js';

const MINIMAL = {
  UPSTREAM_BASE_URL: 'https://openrouter.ai/api/v1',
  UPSTREAM_API_KEY: 'sk-a-real-looking-secret',
};

const S3_SECRET = 'a-bucket-secret-that-must-never-be-printed';

const ORG = {
  ORG_MODE: 'true',
  S3_ENDPOINT: 'http://minio.clinic.internal:9000',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'plate-audit',
  S3_ACCESS_KEY_ID: 'clinic-access-key',
  S3_SECRET_ACCESS_KEY: S3_SECRET,
  AUDIT_RETENTION_DAYS: '30',
};

function messageFrom(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('the default is family mode, and nothing else', () => {
  it('leaves a gateway with no ORG_MODE in family mode with no audit block', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config.gatewayMode).toBe('family');
    expect(config.audit).toBeNull();
  });

  it('treats ORG_MODE=false as family', () => {
    const config = loadConfig({ ...MINIMAL, ORG_MODE: 'false' });

    expect(config.gatewayMode).toBe('family');
    expect(config.audit).toBeNull();
  });

  it('REFUSES a value that is neither true nor false, rather than guessing', () => {
    // `ORG_MODE=yes` reads as "on" to a human and would be a silent no-op under
    // a `Boolean(value)` parse. The one thing it must not do is quietly disable
    // an audit trail the operator believes they turned on.
    const message = messageFrom({ ...MINIMAL, ORG_MODE: 'yes' });

    expect(message).toContain('ORG_MODE');
    expect(message).toContain('`true` or `false`');
  });
});

describe('ORG_MODE=true demands the whole audit block', () => {
  it('accepts the complete block and exposes it as config.audit', () => {
    const config = loadConfig({ ...MINIMAL, ...ORG });

    expect(config.gatewayMode).toBe('org');
    expect(config.audit).toEqual({
      s3: {
        endpoint: 'http://minio.clinic.internal:9000',
        region: 'eu-central-1',
        bucket: 'plate-audit',
        accessKeyId: 'clinic-access-key',
        secretAccessKey: S3_SECRET,
        forcePathStyle: false,
      },
      retentionDays: 30,
      maxBodyBytes: DEFAULT_AUDIT_MAX_BODY_BYTES,
      recordFile: DEFAULT_AUDIT_STORE_FILE,
    });
  });

  it('names EVERY missing variable in one message, not one restart at a time', () => {
    const message = messageFrom({ ...MINIMAL, ORG_MODE: 'true' });

    for (const name of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'AUDIT_RETENTION_DAYS',
    ]) {
      expect(message, name).toContain(name);
    }
    expect(message).toContain('all-or-nothing');
  });

  it('requires AUDIT_RETENTION_DAYS rather than picking a retention period for the operator', () => {
    const { AUDIT_RETENTION_DAYS: _omitted, ...withoutRetention } = ORG;
    const message = messageFrom({ ...MINIMAL, ...withoutRetention });

    expect(message).toContain('AUDIT_RETENTION_DAYS');
  });

  it('refuses a zero or negative retention', () => {
    expect(messageFrom({ ...MINIMAL, ...ORG, AUDIT_RETENTION_DAYS: '0' })).toContain(
      'AUDIT_RETENTION_DAYS',
    );
    expect(messageFrom({ ...MINIMAL, ...ORG, AUDIT_RETENTION_DAYS: '-5' })).toContain(
      'AUDIT_RETENTION_DAYS',
    );
  });

  it('NEVER puts S3_SECRET_ACCESS_KEY in the error message', () => {
    // The one assertion in this file that leaks a credential if it regresses.
    const message = messageFrom({ ...MINIMAL, ORG_MODE: 'true', S3_SECRET_ACCESS_KEY: S3_SECRET });

    expect(message).toContain('S3_ENDPOINT');
    expect(message).not.toContain(S3_SECRET);
  });

  it('takes the optional settings when they are given', () => {
    const config = loadConfig({
      ...MINIMAL,
      ...ORG,
      S3_FORCE_PATH_STYLE: 'true',
      AUDIT_MAX_BODY_BYTES: '1048576',
      AUDIT_STORE_FILE: '/app/state/audit.jsonl',
    });

    expect(config.audit?.s3.forcePathStyle).toBe(true);
    expect(config.audit?.maxBodyBytes).toBe(1_048_576);
    expect(config.audit?.recordFile).toBe('/app/state/audit.jsonl');
  });

  it('rejects an S3_ENDPOINT that is not an absolute http(s) URL', () => {
    expect(messageFrom({ ...MINIMAL, ...ORG, S3_ENDPOINT: 'minio.clinic.internal:9000' })).toContain(
      'absolute http(s) URL',
    );
  });
});

describe('the audit block is REFUSED when ORG_MODE is off', () => {
  it('rejects a leftover S3 credential on a family gateway', () => {
    // A half-finished migration, or a copied .env. Both deserve a boot failure:
    // ignoring the variable leaves somebody believing images are being kept.
    const message = messageFrom({ ...MINIMAL, S3_BUCKET: 'plate-audit' });

    expect(message).toContain('S3_BUCKET');
    expect(message).toContain('ORG_MODE=true');
  });

  it('rejects every audit variable, including the ones that have defaults', () => {
    for (const [name, value] of Object.entries({
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'eu-central-1',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: 'true',
      AUDIT_RETENTION_DAYS: '30',
      AUDIT_MAX_BODY_BYTES: '1000',
      AUDIT_STORE_FILE: './audit.jsonl',
    })) {
      expect(messageFrom({ ...MINIMAL, ORG_MODE: 'false', [name]: value }), name).toContain(name);
    }
  });
});
