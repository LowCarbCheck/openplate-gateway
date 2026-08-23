/**
 * `SERVICE_VERSION` is a constant in `src/`, so this closes the one gap that
 * choice opens.
 *
 * Importing `package.json` into `src/` would need a JSON import attribute under
 * NodeNext and would pull the whole manifest — dependency list included — into
 * the shipped bundle. A constant costs one line and one risk: that somebody
 * bumps the manifest and not the constant, and `/v1/gateway/info` reports the
 * wrong number for a whole release cycle with nothing to notice it. This turns
 * that into a red test at the moment of the bump.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_VERSION } from '../../src/version.js';

describe('SERVICE_VERSION', () => {
  it('matches the version in package.json', async () => {
    const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };

    expect(SERVICE_VERSION).toBe(manifest.version);
  });
});
