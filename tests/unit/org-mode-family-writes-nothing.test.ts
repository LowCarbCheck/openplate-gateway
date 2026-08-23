/**
 * THE TEST ORG MODE EXISTS TO BE CHECKED AGAINST: with `ORG_MODE` off, this
 * service constructs no object-store client and writes no request byte anywhere.
 *
 * ADR-0003 makes org mode an explicit amendment to ADR-0001's no-body-storage
 * guarantee. An amendment is only safe if the unamended default is provably
 * unchanged, and "provably" cannot mean "we read the code and there is an `if`".
 * So this file asserts the three structural facts the design rests on:
 *
 *  1. THE S3 CLIENT IS NEVER CONSTRUCTED. `createAuditForMode` is the only place
 *     in the service that builds one, and a family config returns before it.
 *  2. `createApp` REFUSES an audit log on a family gateway. There is no wiring —
 *     not even a mistaken one — in which the family path holds an audit sink.
 *  3. A REAL REQUEST WITH A REAL PHOTOGRAPH LEAVES NOTHING BEHIND. Every file in
 *     the state directory is read after the round trip and none of them contains
 *     the payload; no audit log file exists at all.
 *
 * Assertion 3 is the one that would catch a future regression that assertions 1
 * and 2 are too structural to see.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditForMode } from '../../src/audit/create-audit-log.js';
import { createAuditLog } from '../../src/audit/audit-log.js';
import { createAuditRecordFile } from '../../src/audit/record-file.js';
import type { ObjectStore } from '../../src/audit/types.js';
import { createSilentLogger } from '../../src/logger.js';
import { createRecordingObjectStore } from '../support/fake-object-store.js';
import {
  chatRequest,
  makePhotoBytes,
  orgTestConfig,
  payloadNeedle,
  startTestApp,
  testConfig,
  toDataUri,
  type TestApp,
} from '../support/app-harness.js';
import { startFakeUpstream, type FakeUpstream } from '../support/fake-upstream.js';

let app: TestApp | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = undefined;
  upstream = undefined;
});

/** Every regular file under a directory, recursively, as [path, contents]. */
async function readAllFiles(directory: string): Promise<[string, string][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: [string, string][] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readAllFiles(path)));
      continue;
    }
    files.push([path, await readFile(path, 'utf8')]);
  }
  return files;
}

describe('the mode gate', () => {
  it('constructs NO object-store client in family mode', () => {
    let constructed = 0;
    const spyingFactory = (): ObjectStore => {
      constructed += 1;
      return createRecordingObjectStore();
    };

    const audit = createAuditForMode({
      config: testConfig(),
      logger: createSilentLogger(),
      createObjectStore: spyingFactory,
    });

    expect(audit).toBeNull();
    expect(constructed).toBe(0);
  });

  it('constructs exactly one in org mode, and only then', () => {
    let constructed = 0;
    const spyingFactory = (): ObjectStore => {
      constructed += 1;
      return createRecordingObjectStore();
    };

    const audit = createAuditForMode({
      config: orgTestConfig(),
      logger: createSilentLogger(),
      createObjectStore: spyingFactory,
    });

    expect(audit).not.toBeNull();
    expect(constructed).toBe(1);
  });
});

describe('createApp refuses a mismatched wiring rather than ignoring it', () => {
  it('throws when an audit log is handed to a family-mode gateway', async () => {
    const objects = createRecordingObjectStore();
    const strayAudit = createAuditLog({
      records: createAuditRecordFile('/dev/null/never-written'),
      objects,
      retentionDays: 30,
      logger: createSilentLogger(),
    });

    await expect(startTestApp({ audit: strayAudit })).rejects.toThrow(/family-mode gateway/);
    // The sink was never even reached — the refusal happens at wiring time.
    expect(objects.objects).toHaveLength(0);
  });

  it('throws when an org-mode config arrives with no audit log', async () => {
    await expect(
      startTestApp({ config: orgTestConfig().audit === null ? {} : { audit: orgTestConfig().audit } }),
    ).rejects.toThrow(/no audit log/);
  });
});

describe('a real completion in family mode', () => {
  it('leaves not one byte of the photograph on disk', async () => {
    const photo = toDataUri(makePhotoBytes());
    const needle = payloadNeedle(photo);
    upstream = await startFakeUpstream({ kind: 'ok' });
    app = await startTestApp({ upstreamBaseUrl: upstream.baseUrl });

    const response = await app.post('/v1/chat/completions', chatRequest(photo));
    expect(response.status).toBe(200);

    // The harness reports no bucket and no audit log at all in family mode.
    expect(app.objects).toBeNull();
    expect(app.audit).toBeNull();
    expect(await app.auditRecords()).toEqual([]);

    const files = await readAllFiles(app.stateDir);
    // The member and invite stores ARE written — this is not "nothing was
    // written", it is "nothing carrying a body was".
    expect(files.length).toBeGreaterThan(0);
    for (const [path, contents] of files) {
      expect(path, 'no audit log file exists').not.toContain('audit');
      expect(contents, path).not.toContain(needle);
    }
  });
});
