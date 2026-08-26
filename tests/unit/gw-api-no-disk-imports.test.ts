/**
 * `gw-api` must be runnable with nothing but a URL and an admin token.
 *
 * That property is what lets an operator drive a gateway from a laptop that has
 * never held the upstream provider key, never mounted the state directory, and
 * has no copy of `member-store.json`. It is also easy to lose by accident: one
 * convenient `import { DEFAULT_MEMBER_STORE_FILE } from '../src/config.js'` —
 * exactly the import `scripts/mint-token.ts` legitimately makes — drags a zod
 * schema, a store module and the whole file layer into this CLI's graph. From
 * there, "just read the store directly when the API is down" is one small commit
 * away, and the thin client stops being thin.
 *
 * A grep over `scripts/` cannot express this, because `mint-token.ts` is the
 * OTHER entrypoint and its disk access is the entire point of it. So this test
 * walks the static import graph reachable from `scripts/gw-api/main.ts`
 * specifically. Modelled on `nicotinepouch-org`'s `np-api-no-db-imports` guard,
 * which exists for the same reason.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entrypoint = resolve(repoRoot, 'scripts/gw-api/main.ts');

/**
 * Specifiers that mean "this module can touch disk or the service's own state".
 * `node:fs` and its promises form; the config module, which is what makes a
 * process need an upstream key; and every store.
 */
const FORBIDDEN = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  '../src/config.js',
  '../../src/config.js',
] as const;

/** Any specifier reaching these directories is a store or a server module. */
const FORBIDDEN_FRAGMENTS = [
  'src/member-store',
  'src/invite-store',
  'src/store/',
  'src/quota/',
  'src/config',
  'src/audit/',
  'src/server/',
] as const;

/** Every `from '…'` specifier in a source file, imports and re-exports alike. */
function readSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/**
 * Resolve a relative specifier to a file inside the repo, or null when it is a
 * package. `.js` is rewritten to `.ts`: this is NodeNext source, so every local
 * import names the emitted extension.
 */
function resolveLocal(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

interface GraphEdge {
  file: string;
  specifier: string;
}

interface ImportGraph {
  files: string[];
  specifiers: GraphEdge[];
}

/** Walk the static import graph from the entrypoint, collecting every specifier. */
function collectGraph(): ImportGraph {
  const seen = new Set<string>();
  const queue = [entrypoint];
  const specifiers: GraphEdge[] = [];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of readSpecifiers(file)) {
      specifiers.push({ file, specifier });
      const local = resolveLocal(specifier, file);
      if (local !== null && !seen.has(local)) queue.push(local);
    }
  }

  return { files: [...seen], specifiers };
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

describe('the gw-api import graph — the no-disk-imports guard', () => {
  it('reaches past its entrypoint, so the walker is really walking', () => {
    // Without this, a broken resolver would make every assertion below vacuous:
    // an empty graph names no forbidden module either.
    const { files } = collectGraph();

    expect(files.map(relative)).toContain('scripts/gw-api/cli.ts');
    expect(files.map(relative)).toContain('scripts/gw-api/client.ts');
  });

  it('names no disk, config or store module anywhere in the graph', () => {
    const { specifiers } = collectGraph();

    const offenders = specifiers.filter(
      ({ specifier }) =>
        FORBIDDEN.some((banned) => specifier === banned) ||
        FORBIDDEN_FRAGMENTS.some((fragment) => specifier.includes(fragment)),
    );

    expect(offenders.map(({ file, specifier }) => `${relative(file)} → ${specifier}`)).toEqual([]);
  });

  it('reaches nothing under src/ at all', () => {
    // The stronger statement, and the one that keeps the CLI honest: this is an
    // HTTP client over a running service, so it has no business importing the
    // service. Every rule it appears to enforce is really enforced by the
    // server, once, in `src/server/admin-routes.ts`.
    const { files } = collectGraph();

    expect(files.filter((file) => relative(file).startsWith('src/')).map(relative)).toEqual([]);
  });
});
