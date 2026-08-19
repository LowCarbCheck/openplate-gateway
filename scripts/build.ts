/**
 * Build script — bundles `src/main.ts` into a single ESM `dist/main.js` via
 * esbuild. That file is what `pnpm start` and the container image run.
 *
 * WHY BUNDLE: the runtime image carries one file plus two externals rather than
 * a `node_modules` tree a self-hoster has to trust and scan, and the artifact is
 * reproducible from one command. This repo ships publicly and holds one shared
 * provider key, so the smaller the surface an operator inherits, the better.
 *
 * WHY WE CALL esbuild's JS API RATHER THAN ITS CLI: the CLI shim is broken in
 * this environment, so `esbuild --bundle ...` from a package script does not
 * run at all. `import { build }` goes straight to the same implementation and
 * needs no shim — which is the whole reason this file exists instead of a
 * one-line script entry.
 *
 * WHY THESE TWO ARE EXTERNAL (there is no `sharp` here — this service decodes
 * nothing, it relays bytes):
 *  - `express` relies on `instanceof` in a few internals, so a second bundled
 *    copy misbehaves in ways that are extremely unfun to debug.
 *  - `undici` is CommonJS and `require()`s its node builtins lazily. Inlined
 *    into an ESM bundle it produces exactly the dynamic-require shim asserted
 *    against below — the bundled copy throws `Dynamic require of "node:assert"
 *    is not supported` on its first line.
 *
 * `zod` is pure ESM and is bundled.
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/**
 * esbuild's shim for a CommonJS `require()` it could not resolve at build time.
 * Its presence means some inlined dependency throws on its first line at runtime
 * — a build that succeeds and an artifact that cannot start.
 *
 * This check exists because that failure is invisible to everything else:
 * typecheck passes, the test suite passes (it runs TypeScript sources and never
 * touches `dist/`), and esbuild reports success. The grep costs a millisecond
 * and is the only thing standing between a green push and a container that
 * crash-loops on its first line.
 *
 * If it fires, add the offending package to `external` below.
 */
const DYNAMIC_REQUIRE_SHIM = 'Dynamic require of';

async function assertBundleHasNoDynamicRequire(outfile: string): Promise<void> {
  const bundle = await readFile(outfile, 'utf8');
  if (!bundle.includes(DYNAMIC_REQUIRE_SHIM)) return;
  throw new Error(
    `dist/main.js contains esbuild's dynamic-require shim, so it will throw on startup. ` +
      `A CommonJS dependency was inlined into the ESM bundle — add it to \`external\` in scripts/build.ts.`,
  );
}

async function main(): Promise<void> {
  const outfile = resolve(repoRoot, 'dist/main.js');
  await build({
    entryPoints: [resolve(repoRoot, 'src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['express', 'undici'],
    sourcemap: true,
    logLevel: 'info',
  });
  await assertBundleHasNoDynamicRequire(outfile);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
