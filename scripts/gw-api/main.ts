/**
 * `pnpm gw-api ...` — the entrypoint, and nothing but the process boundary.
 *
 * All of the behaviour is in `cli.ts`, which returns an exit code instead of
 * calling `process.exit`. That split is what lets the whole CLI run inside a
 * unit test against a real `node:http` server, so the `Authorization` header,
 * the `--url` precedence and the absence of a leaked response body are asserted
 * over a socket rather than assumed.
 *
 * `process.exitCode` rather than `process.exit()`: the latter can truncate a
 * pending stdout write on a pipe, which for this CLI would mean a member token
 * that was printed but never arrived.
 */
import { runCli } from './cli.js';

const io = {
  out: (text: string): void => {
    process.stdout.write(`${text}\n`);
  },
  err: (text: string): void => {
    process.stderr.write(`${text}\n`);
  },
};

// The `void (async () => { ... })()` shape, not `.then().catch()` — the same
// one `src/server/async-handler.ts` uses, and for the same reason: oxlint's
// promise rules reject a `then` that returns nothing, and a try/catch reads as
// what it is.
void (async (): Promise<void> => {
  try {
    process.exitCode = await runCli({ argv: process.argv.slice(2), env: process.env, io });
  } catch (error: unknown) {
    io.err(error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  }
})();
