/**
 * `gw-api` — the operator's command line over the admin API.
 *
 * ── IT IS AN HTTP CLIENT, AND NOTHING ELSE ─────────────────────────────────
 * Every command here is one call to an endpoint in `src/server/admin-routes.ts`
 * or `src/server/public-routes.ts`. It imports no store, no config module and no
 * `node:fs`, so the rules the server enforces — quota ceilings, id patterns,
 * the once-only token, the member-exists check before an invite — are enforced
 * for this CLI too, by the same code, instead of being restated here where they
 * could drift. `pnpm mint-token` is the opposite arrangement and the reason this
 * one is worth having: see the header of `scripts/mint-token.ts`.
 *
 * ── AUTH IS `GATEWAY_ADMIN_TOKEN`, AND ONLY THAT ───────────────────────────
 * The same variable name the server reads, so one `export` serves a dev loop and
 * this CLI at once. There is deliberately NO `--token` flag: a credential passed
 * as an argument lands in shell history and is readable in `ps` by every other
 * user on the box, whereas one process's environment is not. There is no dotenv
 * here either — `.env` is a docker compose file in this repo (see `.env.example`)
 * — and no `~/.config` file, because a credential written to disk by a
 * convenience feature outlives the reason it was written.
 *
 * The token is required for every command, including the two that hit
 * unauthenticated endpoints. A rule with no exceptions needs no table.
 *
 * ── IT PRINTS CREDENTIALS ON PURPOSE ───────────────────────────────────────
 * `members add` prints a member token and `invites create` prints an invite link
 * that carries one. Both are shown ONCE by the server and cannot be recovered,
 * so an operator's terminal is exactly where they belong. THAT OUTPUT MUST NEVER
 * BE PASTED INTO A COMMIT, AN ISSUE, A PASTEBIN OR A WORKLOG — a member token
 * spends the payer's provider key, and an invite link mints one. Redact before
 * you share a terminal transcript.
 *
 * The ADMIN token itself is never printed, never echoed back in an error, and
 * never logged. `client.ts` puts it in one header and builds no string from it.
 *
 * ── `runCli` RETURNS AN EXIT CODE, IT DOES NOT EXIT ────────────────────────
 * The process boundary lives in `main.ts`. Keeping it out of here is what lets
 * the whole CLI run inside a test against a real `node:http` server, which is
 * how the auth header, the URL precedence and the absence of a leaked payload
 * are actually asserted rather than assumed.
 */
import { parseArgs } from 'node:util';
import { CliError, GatewayClient } from './client.js';

/** Where the gateway listens when nobody said otherwise — `DEFAULT_PORT` in src/config.ts. */
export const DEFAULT_GATEWAY_URL = 'http://localhost:3602';

/** The environment variable that carries the admin credential. Named in the error when it is missing. */
export const ADMIN_TOKEN_VAR = 'GATEWAY_ADMIN_TOKEN';

/** The environment variable that carries the target address. Beaten by `--url`. */
export const GATEWAY_URL_VAR = 'GATEWAY_URL';

const USAGE = `gw-api — openplate-gateway admin API client

Usage: pnpm gw-api [options] <command>

Commands
  status                                    Is the gateway reachable, and is it healthy?
  info                                      This gateway's name, model, mode and version
  members list                              The roster (never shows tokens)
  members add <id> <dailyLimit>             Create a member — PRINTS THE TOKEN ONCE
  members revoke <id>                       Revoke a member's token
  invites list                              Outstanding and spent invitations
  invites create <memberId> <dailyLimit>    Create an invite — PRINTS THE LINK ONCE
  invites revoke <id>                       Withdraw an unredeemed invite

Options
  --url <url>      Gateway base URL. Beats ${GATEWAY_URL_VAR}; default ${DEFAULT_GATEWAY_URL}
  --email <addr>   invites create only: also email the invite, if the gateway has a mailer
  --json           Print the raw JSON response instead of a table
  --help           This text

Auth
  ${ADMIN_TOKEN_VAR} must be exported. There is no --token flag on purpose:
  an argument is visible in shell history and in ps to every user on the host.

    export ${ADMIN_TOKEN_VAR}='...'   # the same value the gateway was started with

  A .env file in this repo is read by docker compose only — export it yourself:
    set -a && . ./.env && set +a
`;

/** Where output goes. Injected so a test can read what was printed. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunCliInput {
  /** Arguments AFTER the node binary and the script path. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly io: CliIo;
  /** Injected in tests; production passes nothing and the global `fetch` is used. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Flag beats environment beats default — the most explicit instruction wins, and
 * an operator who typed an address on the line they are looking at is never
 * overruled by a variable they exported in another window.
 *
 * There is deliberately no `--production` flag. openplate-gateway has no
 * canonical instance: every deployment is somebody's own box, and a flag naming
 * one would contradict the entire product.
 */
export function resolveBaseUrl(parts: {
  flagUrl: string | undefined;
  envUrl: string | undefined;
}): string {
  const flag = parts.flagUrl?.trim();
  if (flag !== undefined && flag !== '') return flag;
  const env = parts.envUrl?.trim();
  if (env !== undefined && env !== '') return env;
  return DEFAULT_GATEWAY_URL;
}

/**
 * The admin credential, or a refusal that names the variable. Blank counts as
 * absent: an exported-but-empty variable is the shape a failed `set -a` leaves
 * behind, and treating it as a token turns a configuration slip into a 401.
 */
export function resolveAdminToken(env: NodeJS.ProcessEnv): string {
  const token = env[ADMIN_TOKEN_VAR]?.trim();
  if (token === undefined || token === '') {
    throw new CliError(
      `${ADMIN_TOKEN_VAR} is not set. Export the same admin token the gateway was started with:\n` +
        `  export ${ADMIN_TOKEN_VAR}='...'\n` +
        'There is no --token flag: an argument would be readable in shell history and in ps.',
    );
  }
  return token;
}

/**
 * `Number.parseInt` is deliberately not used, for the reason spelled out in
 * `scripts/mint-token.ts`: it reads `50x` as 50 and `1e3` as 1, and a spend cap
 * is the wrong place for a lenient parse. Zero is allowed and means "may make no
 * requests" — the server's own default.
 */
function parseDailyLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(`Daily limit must be a whole number of requests per day, not "${raw}".`);
  }
  return value;
}

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly url: string | undefined;
  readonly email: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        url: { type: 'string' },
        email: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    return {
      positionals: parsed.positionals,
      url: parsed.values.url,
      email: parsed.values.email,
      json: parsed.values.json === true,
      help: parsed.values.help === true,
    };
  } catch (error) {
    // `parseArgs` names the offending option and nothing else, so this one is
    // safe to pass through — it quotes the operator's own argument, never a
    // response.
    throw new CliError(error instanceof Error ? error.message : 'Could not read the arguments.');
  }
}

/* ── reading a response without trusting its shape ─────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A field rendered for a human. Anything absent or oddly-typed becomes a dash, never `undefined`. */
function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '—';
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/**
 * The banner a once-only credential is printed inside. It exists so the warning
 * travels with the value: whoever reads the terminal, or the transcript of it,
 * sees why it must not be pasted anywhere.
 */
function secretBlock(lines: readonly string[]): string {
  const rule = '='.repeat(72);
  return ['', rule, ...lines, '', '  Shown ONCE — it is not stored and cannot be recovered.',
    '  Do NOT paste it into a commit, an issue, a chat or a worklog.', rule, ''].join('\n');
}

/* ── the commands ─────────────────────────────────────────────────────────── */

interface CommandContext {
  readonly client: GatewayClient;
  readonly args: ParsedArgs;
  readonly io: CliIo;
  readonly baseUrl: string;
}

/** Prints the raw body and reports whether it did, so each command can skip its own rendering. */
function printedJson(context: CommandContext, body: unknown): boolean {
  if (!context.args.json) return false;
  context.io.out(JSON.stringify(body, null, 2));
  return true;
}

function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined || value === '') {
    throw new CliError(`Missing <${name}>. Run "pnpm gw-api --help" for the usage.`);
  }
  return value;
}

async function commandStatus(context: CommandContext): Promise<void> {
  const body = await context.client.request({ method: 'GET', path: '/healthcheck' });
  if (printedJson(context, body)) return;
  context.io.out(`${context.baseUrl} — reachable, healthcheck ${field(asRecord(body), 'status')}`);
}

async function commandInfo(context: CommandContext): Promise<void> {
  const body = await context.client.request({ method: 'GET', path: '/v1/gateway/info' });
  if (printedJson(context, body)) return;
  const info = asRecord(body);
  context.io.out(
    [
      `Name          ${field(info, 'name')}`,
      `Model         ${field(info, 'model')}`,
      `Version       ${field(info, 'version')}`,
      `Audit enabled ${field(info, 'auditEnabled')}`,
    ].join('\n'),
  );
}

async function commandMembersList(context: CommandContext): Promise<void> {
  const body = await context.client.request({ method: 'GET', path: '/admin/members' });
  if (printedJson(context, body)) return;
  const members = asArray(asRecord(body).members).map(asRecord);
  if (members.length === 0) {
    context.io.out('No members yet. Add one with: pnpm gw-api members add <id> <dailyLimit>');
    return;
  }
  context.io.out(
    renderTable(
      ['ID', 'DAILY LIMIT', 'MODE', 'CREATED', 'REVOKED'],
      members.map((member) => [
        field(member, 'id'),
        field(member, 'dailyLimit'),
        field(member, 'mode'),
        field(member, 'createdAt'),
        field(member, 'revokedAt'),
      ]),
    ),
  );
}

async function commandMembersAdd(context: CommandContext): Promise<void> {
  const id = requirePositional(context.args, 2, 'id');
  const dailyLimit = parseDailyLimit(requirePositional(context.args, 3, 'dailyLimit'));

  const body = await context.client.request({
    method: 'POST',
    path: '/admin/members',
    body: { id, dailyLimit },
  });
  if (printedJson(context, body)) return;

  const created = asRecord(body);
  const member = asRecord(created.member);
  context.io.out(
    secretBlock([
      `  Member token for "${field(member, 'id')}":`,
      '',
      `    ${field(created, 'token')}`,
    ]),
  );
  context.io.out(`Daily limit: ${field(member, 'dailyLimit')} requests per UTC day.`);
}

async function commandMembersRevoke(context: CommandContext): Promise<void> {
  const id = requirePositional(context.args, 2, 'id');
  const body = await context.client.request({ method: 'DELETE', path: `/admin/members/${encodeURIComponent(id)}` });
  if (printedJson(context, body)) return;
  const member = asRecord(asRecord(body).member);
  context.io.out(`Revoked "${field(member, 'id')}" at ${field(member, 'revokedAt')}.`);
}

async function commandInvitesList(context: CommandContext): Promise<void> {
  const body = await context.client.request({ method: 'GET', path: '/admin/invites' });
  if (printedJson(context, body)) return;
  const invites = asArray(asRecord(body).invites).map(asRecord);
  if (invites.length === 0) {
    context.io.out('No invites. Create one with: pnpm gw-api invites create <memberId> <dailyLimit>');
    return;
  }
  context.io.out(
    renderTable(
      ['ID', 'MEMBER', 'DAILY LIMIT', 'STATUS', 'EXPIRES', 'EMAIL'],
      invites.map((invite) => [
        field(invite, 'id'),
        field(invite, 'memberId'),
        field(invite, 'dailyLimit'),
        field(invite, 'status'),
        field(invite, 'expiresAt'),
        field(invite, 'email'),
      ]),
    ),
  );
}

async function commandInvitesCreate(context: CommandContext): Promise<void> {
  const memberId = requirePositional(context.args, 2, 'memberId');
  const dailyLimit = parseDailyLimit(requirePositional(context.args, 3, 'dailyLimit'));
  const email = context.args.email;

  const body = await context.client.request({
    method: 'POST',
    path: '/admin/invites',
    body: { memberId, dailyLimit, ...(email === undefined ? {} : { email }) },
  });
  if (printedJson(context, body)) return;

  const invite = asRecord(body);
  // The link when the gateway could build one, the raw token when it could not
  // — the server returns both and null is a real answer, not a failure. See the
  // `buildLinkOrNull` note in admin-routes.ts.
  const handover = invite.link === null ? `invite token: ${field(invite, 'token')}` : field(invite, 'link');
  context.io.out(
    secretBlock([`  Invite for "${field(invite, 'memberId')}":`, '', `    ${handover}`]),
  );
  context.io.out(
    `Expires ${field(invite, 'expiresAt')} · daily limit ${field(invite, 'dailyLimit')} · emailed: ${field(invite, 'emailed')}`,
  );
}

async function commandInvitesRevoke(context: CommandContext): Promise<void> {
  const id = requirePositional(context.args, 2, 'id');
  const body = await context.client.request({ method: 'DELETE', path: `/admin/invites/${encodeURIComponent(id)}` });
  if (printedJson(context, body)) return;
  const invite = asRecord(asRecord(body).invite);
  context.io.out(`Revoked invite ${field(invite, 'id')} for "${field(invite, 'memberId')}".`);
}

type CommandHandler = (context: CommandContext) => Promise<void>;

/** Space-joined verb path → handler. A flat table beats a nest of switches. */
const COMMANDS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ['status', commandStatus],
  ['info', commandInfo],
  ['members list', commandMembersList],
  ['members add', commandMembersAdd],
  ['members revoke', commandMembersRevoke],
  ['invites list', commandInvitesList],
  ['invites create', commandInvitesCreate],
  ['invites revoke', commandInvitesRevoke],
]);

function selectCommand(positionals: readonly string[]): CommandHandler {
  const one = positionals[0] ?? '';
  const two = `${one} ${positionals[1] ?? ''}`.trim();
  const handler = COMMANDS.get(two) ?? COMMANDS.get(one);
  if (handler === undefined) {
    throw new CliError(
      one === ''
        ? 'No command given. Run "pnpm gw-api --help" for the usage.'
        : `Unknown command "${two}". Run "pnpm gw-api --help" for the usage.`,
    );
  }
  return handler;
}

/** Usage and configuration problems. Distinct from 1 so a script can tell them apart. */
const EXIT_USAGE = 2;
const EXIT_FAILED = 1;

/**
 * Runs one command and returns the exit code. Never throws, never calls
 * `process.exit` — see the module header.
 */
export async function runCli(input: RunCliInput): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(input.argv);
  } catch (error) {
    input.io.err(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  if (args.help || args.positionals.length === 0) {
    input.io.out(USAGE);
    return args.help ? 0 : EXIT_USAGE;
  }

  // Both of these are resolved BEFORE anything is sent. A missing credential
  // must not produce a request — an unauthenticated probe is still a probe, and
  // it teaches the operator that the CLI "sometimes works" without a token.
  let handler: CommandHandler;
  let token: string;
  try {
    handler = selectCommand(args.positionals);
    token = resolveAdminToken(input.env);
  } catch (error) {
    input.io.err(error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const baseUrl = resolveBaseUrl({ flagUrl: args.url, envUrl: input.env[GATEWAY_URL_VAR] });
  const client = new GatewayClient({
    baseUrl,
    adminToken: token,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });

  try {
    await handler({ client, args, io: input.io, baseUrl });
    return 0;
  } catch (error) {
    // `CliError` messages are written here and carry no response body. Anything
    // else is an unexpected fault in this process, and its message is ours too —
    // nothing from the wire reaches this branch, by construction in `client.ts`.
    input.io.err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }
}
