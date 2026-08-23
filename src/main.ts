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
 *   3. Member store, and a ONE-TIME merge of any legacy `members.json`. An
 *      absent legacy file is normal after ADR-0002; one that exists and does
 *      not parse is still FATAL, because the operator believes in the members
 *      inside it and booting without them silently revokes the household.
 *   4. Quota store, invite store, mailer, then listen.
 *
 * THE LEGACY MERGE RUNS EXACTLY ONCE PER STORE, and takes a backup first. Both
 * properties matter and neither is decoration:
 *   - Once, because merging on every boot would reinstate a member the operator
 *     revoked through the admin API while the old file sat there unchanged.
 *     `legacyMigratedAt` in the store is the stamp that makes boot two a no-op.
 *   - With a backup, because the merge is the moment the old file stops being
 *     the source of truth. `members.json.bak` next to the store is what an
 *     operator restores from if the migration turns out to have been a mistake.
 *
 * AN EMPTY MEMBER STORE IS NO LONGER FATAL. It used to be: a gateway that
 * authenticates nobody reads as broken. But after ADR-0002 an empty store is the
 * normal first-boot state — the operator populates it through the admin API or
 * `pnpm mint-token`, with the service already running. It is logged loudly
 * instead of killing the process.
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
import { createAuditForMode } from './audit/create-audit-log.js';
import { startAuditRetention } from './audit/retention.js';
import { createLogger, type Logger } from './logger.js';
import { loadConfig, type AuditConfig } from './config.js';
import type { GatewayMode } from './member-store.js';
import { createFileInviteStore } from './invite-store.js';
import { migrateLegacyMembers } from './legacy-migration.js';
import { createMailer } from './mail/mailer.js';
import { createFileMemberStore } from './member-store.js';
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

/**
 * The mode line. Two fixed sentences, one per mode, with counts and flags beside
 * them — never the bucket credentials, and never the endpoint's credentials-in-a
 * -query-string cousin. An operator reading the first ten lines of a boot log
 * must be able to tell, without looking anything up, whether this gateway stores
 * what its members send.
 */
function logStartupMode(mode: GatewayMode, audit: AuditConfig | null, logger: Logger): void {
  if (mode === 'org' && audit !== null) {
    logger.warn(
      'ORGANISATION MODE: submitted images and completions are STORED and auditable by admins.',
      {
        mode,
        retentionDays: audit.retentionDays,
        maxBodyBytes: audit.maxBodyBytes,
        // Which bucket, at which host — never the keys.
        bucket: audit.s3.bucket,
        s3Host: upstreamHostOf(audit.s3.endpoint),
        forcePathStyle: audit.s3.forcePathStyle,
      },
    );
    return;
  }
  logger.info('FAMILY MODE: request bodies are relayed and never stored or logged.', { mode });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger: Logger = createLogger({ component: 'openplate-gateway', level: config.logLevel });

  const members = createFileMemberStore(config.memberStoreFile);
  await migrateLegacyMembers({
    legacyMembersFile: config.membersFile,
    memberStoreFile: config.memberStoreFile,
    members,
    logger,
  });

  const quota = createFileQuotaStore(config.quotaStoreFile);
  const invites = createFileInviteStore(config.inviteStoreFile);
  const mailer = createMailer(config.smtp);

  // THE MODE, SAID PLAINLY AND EARLY. It is the first thing an operator should
  // see in the log, because it is the one setting that changes what happens to
  // the photographs their members send — see ADR-0003.
  logStartupMode(config.gatewayMode, config.audit, logger);

  // `null` in family mode, and NOTHING that can store an image is constructed:
  // `createAuditForMode` is the only caller of the S3 adapter.
  const audit = createAuditForMode({ config, logger });

  const app = createApp({ config, members, invites, quota, mailer, logger, audit });

  if (audit !== null && config.audit !== null) {
    // Once now, then daily. Retention that only ran on a timer would never fire
    // on a container that restarts every day.
    startAuditRetention({ audit, logger, retentionDays: config.audit.retentionDays });
  }

  const roster = await members.all();
  const activeMembers = roster.filter((member) => member.revokedAt === undefined).length;
  if (activeMembers === 0) {
    // Loud, but not fatal — see the module header. An operator seeing this on a
    // fresh install is where they are supposed to be; one seeing it after an
    // upgrade has a migration to look at.
    logger.warn('No active members. Nobody can use this gateway until one is created.', {
      adminApiEnabled: config.adminToken !== null,
    });
  }

  const server = app.listen(config.port, () => {
    logger.info('openplate-gateway listening', {
      port: config.port,
      members: activeMembers,
      mode: config.gatewayMode,
      adminApiEnabled: config.adminToken !== null,
      // Whether mail is configured, never where or as whom.
      smtpConfigured: config.smtp !== null,
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
