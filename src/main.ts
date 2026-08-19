/**
 * Service entry point — the only module in `src/` that reads `process.env`,
 * touches the filesystem at boot, opens a socket, or decides when the process
 * should die. Everything below it takes its dependencies as arguments, which is
 * what lets the test suite boot the real app without any of this.
 *
 * BOOT ORDER, AND WHY IT FAILS WHERE IT DOES:
 *   1. Config. A misconfiguration kills the process here, before a logger
 *      exists — `LOG_LEVEL` is one of the things config decides.
 *   2. Logger.
 *   3. Member registry, read eagerly. An unreadable registry is FATAL by
 *      design (see `members.ts`): a gateway that starts with zero members
 *      authenticates nobody, which looks like a broken deployment and gets
 *      "fixed" by someone disabling auth. Refusing to start says what actually
 *      happened, once, at the top of the log.
 *   4. Quota store, then listen.
 *
 * A BOOT FAILURE PRINTS THE MESSAGE, NEVER THE VALUE. `loadConfig` names the
 * offending VARIABLE and never interpolates its contents, and the catch below
 * prints `error.message` only — no stack, no `cause` chain. A stack can quote a
 * source line; a `cause` is where a wrapped library error's echoed input hides.
 * `UPSTREAM_API_KEY` is one shared provider key funding a whole household, and a
 * crash log is the most-pasted text in any support thread.
 *
 * THE STARTUP LINE NAMES THE UPSTREAM HOST, NOT THE URL AND NOT THE KEY. The
 * host is what an operator needs to confirm they are pointed at the provider
 * they meant; a full URL can carry a key in its query string, which is a shape
 * some providers still hand out.
 */
import { createLogger, type Logger } from './logger.js';
import { loadConfig } from './config.js';
import { loadMembersFile } from './members.js';
import { createFileQuotaStore } from './quota/file-store.js';
import { createApp } from './server/create-app.js';

/**
 * How long a shutdown waits for in-flight requests before giving up. A proxied
 * completion can legitimately take two minutes, so this is not "close now" — it
 * is the bound that stops one wedged upstream stream from holding a container
 * open forever and turning a rolling deploy into an outage.
 */
const SHUTDOWN_GRACE_MS = 30_000;

/** Host only — see the module header. Never the full URL, never the key. */
function upstreamHostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'unparseable';
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger: Logger = createLogger({ component: 'openplate-gateway', level: config.logLevel });

  const registry = await loadMembersFile(config.membersFile);
  const quota = createFileQuotaStore(config.quotaStoreFile);

  const app = createApp({ config, registry, quota, logger });

  const server = app.listen(config.port, () => {
    logger.info('openplate-gateway listening', {
      port: config.port,
      members: registry.members.length,
      upstreamHost: upstreamHostOf(config.upstreamBaseUrl),
      rateLimitPerMinute: config.rateLimitPerMinute,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      maxRequestBytes: config.maxRequestBytes,
    });
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    // A second Ctrl-C must not restart the grace timer, and an orchestrator
    // that sends SIGTERM twice must not get two exit paths racing.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('Forcing exit; requests were still in flight', {
        graceMs: SHUTDOWN_GRACE_MS,
      });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // `message` only. See the module header: no stack, no cause, no value.
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
