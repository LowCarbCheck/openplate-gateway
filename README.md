# openplate-gateway

Share one AI provider key across a household — or run a small hosted tier — without
handing anyone the key.

The gateway is an **OpenAI-compatible proxy**. It holds one upstream provider key and
issues each member their own token with a hard daily quota. Members point
[openplate](https://github.com/LowCarbCheck/openplate) at the gateway exactly the way they
would point it at any other OpenAI-compatible endpoint. The payer sees usage per member and
can revoke one member without disturbing the others.

**It never logs a request or response body.** That is a property of the code, not a setting
you can switch on, and there is a test that proves it. This repository exists partly so you
can check that claim yourself rather than take it on trust.

**It also never *stores* one — unless you deliberately turn on organisation mode.**
`ORG_MODE=true` is an opt-in for organisations (a clinic, a care home) that are accountable
for what is submitted through them: it stores submitted images in your own S3-compatible
bucket and keeps an audit trail. It is off by default, it fails loudly if half-configured,
it re-consents every member when you enable it, and a family gateway constructs none of it.
See [docs/org-mode.md](docs/org-mode.md) and
[ADR-0003](docs/adr/0003-organization-mode-amends-the-no-body-logging-guarantee.md).

## Do you actually need this?

Probably not, and it is worth two minutes to find out.

**If your provider is OpenRouter, you do not need the gateway.** OpenRouter already issues
sub-keys with their own credit limits. Mint one per family member in the OpenRouter
dashboard, give each member their sub-key, and you are finished in five minutes with no
server to run. See [docs/family-setup.md](docs/family-setup.md).

**Run the gateway when** your provider is Mistral or anything else without per-key spend
limits, or you are pointing the family at your own
[openplate-inference](https://github.com/LowCarbCheck/openplate-inference) box, or you want
per-member *daily request* caps rather than per-key credit caps.

## What it does not do

- It does not touch anyone's food diary. openplate keeps diaries on the device; the gateway
  carries AI requests only. Members of a household share spend, not data.
- It is not an accounts system. There is no signup and no user table — members are added by
  an invite from the operator, or by editing the member store directly.
- It does not add a model. It forwards to a provider you choose.

## Quickstart

```bash
git clone https://github.com/LowCarbCheck/openplate-gateway
cd openplate-gateway
cp .env.example .env
```

Fill in two values in `.env`:

```
UPSTREAM_BASE_URL=https://api.mistral.ai/v1
UPSTREAM_API_KEY=<the payer's real provider key>
```

Set `GATEWAY_ADMIN_TOKEN` in `.env` (`openssl rand -base64 32` makes one), then start the
gateway:

```bash
docker compose -f docker/compose.yml up -d
```

`.env` is read by **docker compose only** — the gateway has no dotenv dependency and is not
getting one. `pnpm dev` and `pnpm start` read your shell environment instead, so export the
file first if you run them:

```bash
set -a && . ./.env && set +a && pnpm dev
```

Open `http://localhost:3602/admin/ui`, sign in with `GATEWAY_ADMIN_TOKEN`, and create an
invite. Send the link it gives you to the member — they open it and openplate connects
itself, with nothing to paste.

Prefer a terminal? `pnpm gw-api` does the same things over the same API:

```bash
pnpm install
export GATEWAY_ADMIN_TOKEN='...'          # the value you put in .env
pnpm gw-api invites create alex 50        # prints the invite link, once
```

**No admin API at all?** If you deliberately left `GATEWAY_ADMIN_TOKEN` unset, `/admin`
answers 404 to everybody and no HTTP client can help. Mint a token offline instead — no
restart needed, either way:

```bash
pnpm install
pnpm mint-token alex 50     # member id, requests per day
```

That person then opens openplate → **Settings → AI**, chooses the **OpenAI-compatible**
provider, and enters:

- **Base URL** — your gateway's address, e.g. `http://gateway.lan:3602/v1`
- **API key** — that member's token

That is the whole setup.

## Topologies

Three compose files, one per shape. Pick one; they are alternatives, not layers.

| File | Shape |
|---|---|
| [`docker/compose.yml`](docker/compose.yml) | The gateway on its own. Point `UPSTREAM_BASE_URL` at whatever you already use. |
| [`docker/topologies/compose.household.yml`](docker/topologies/compose.household.yml) | A family with one GPU/CPU box: openplate + [openplate-inference](https://github.com/LowCarbCheck/openplate-inference) + the gateway in front of it. No provider bill at all. |
| [`docker/topologies/compose.hosted.yml`](docker/topologies/compose.hosted.yml) | No hardware: the gateway alone in front of a managed provider. The household shares one bill; per-member daily limits still apply. |

## Where to run it

**On your LAN or your VPN.** The example compose file binds to `127.0.0.1` on purpose.

A gateway on the open internet is a spend endpoint protected by one bearer token, so if you
do expose it, put something in front of it and keep `RATE_LIMIT_PER_MINUTE` tight. The
per-member daily quota limits the damage of a leaked token; it does not prevent one.

## Spend safety

Two caps, and you want both:

1. **Per-member daily quotas**, here. A member with no `dailyLimit` gets **zero**, not
   unlimited — the failure mode of "unlimited by default" is one you discover on a bill.
2. **A hard spend cap on the upstream key itself**, at the provider. The gateway counts
   requests, not currency, and a request's cost depends on the model and the image. Only
   the provider can stop the money.

Quota counters reset at **UTC** midnight, not local midnight — a household can span time
zones, and a local reset would hand someone a second allowance.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The two required ones are
`UPSTREAM_BASE_URL` and `UPSTREAM_API_KEY`; everything else has a working default.

The quota counter file **must** be on durable storage. If it is lost, every member starts
the day again with a full allowance.

## Inviting members

Set `GATEWAY_ADMIN_TOKEN` and the gateway grows an admin API for adding and removing people
without editing files or restarting anything — leave it unset and `/admin` answers "no such
endpoint" to everybody, exactly like the rest of this gateway's opt-in surfaces. The primary
way to use it is the bundled admin page at `/admin/ui`: sign in with the token, list members
and invites, create an invite, and copy the link. Everything it does is also a plain `curl`
call, for scripting. See [docs/family-setup.md](docs/family-setup.md) for the full walk-through,
including the openplate side: an invite link opens `/connect-gateway` in the client and the
member is connected with nothing to paste.

### `gw-api` — the admin API from a terminal

`pnpm gw-api` is a thin HTTP client over the same `/admin` endpoints the admin page uses. It
is the primary command-line interface and the one that grows; it reads no files and needs no
access to the gateway's state, so it runs from any machine that can reach the address.

```bash
export GATEWAY_ADMIN_TOKEN='...'      # the same value the gateway was started with

pnpm gw-api status                    # reachable? healthy?
pnpm gw-api info                      # name, model, mode, version
pnpm gw-api members list              # the roster — never shows tokens
pnpm gw-api members add alex 50       # PRINTS THE MEMBER TOKEN, once
pnpm gw-api members revoke alex
pnpm gw-api invites list
pnpm gw-api invites create robin 25 --email robin@example.com
pnpm gw-api invites revoke inv_...
```

| Option | Meaning |
|---|---|
| `--url <url>` | Which gateway. Beats `GATEWAY_URL`; defaults to `http://localhost:3602`. |
| `--json` | The raw response, for scripts. |
| `--email <addr>` | `invites create` only — also email the invite, if this gateway has a mailer. |

Auth is `GATEWAY_ADMIN_TOKEN` and nothing else. There is **no `--token` flag**: an argument
is visible in shell history and in `ps` to every other user on the host. There is no
`--production` flag either — openplate-gateway has no canonical instance, so use `--url`.

`members add` and `invites create` print a credential that the gateway shows **once** and
cannot recover. That is the point of them. Never paste that output into a commit, an issue,
a chat or a bug report.

## Organisation mode

Off by default, and it is meant to stay off for a household. `ORG_MODE=true` turns this into
an audited gateway for organisations — a clinic, a care home — that are accountable for what
is submitted through them: it stores every submitted image in your own S3-compatible bucket
and keeps an admin-readable, exportable, erasable audit trail with a retention period you set.
It is not a substitute for a DPA or a compliance programme — see
[docs/org-mode.md](docs/org-mode.md) for what it changes, what it does not give you, and its
known limitations.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | member token | The proxy. Streaming is passed through. |
| `GET` | `/healthcheck` | none | Liveness. |
| `GET` | `/v1/gateway/info` | none | Gateway identity (name, model, version) and `auditEnabled` — read by a client before it has a token to authenticate with. |
| `POST` | `/v1/invites/redeem` | none | Turns a one-shot invite token into a member token. What an invite link's `/connect-gateway` step calls. |
| `GET` | `/admin/ui` | admin token | The bundled admin page — members, invites, links. `pnpm gw-api` is the terminal equivalent. |
| `*` | `/admin/*` | admin token | The admin API `/admin/ui` is built on. 404 if `GATEWAY_ADMIN_TOKEN` is unset. See docs/family-setup.md. |
| `*` | `/admin/audit*` | admin token, org mode | The audit trail. Gated on top of the admin token by `ORG_MODE=true` — 404 on a family gateway even with a valid admin token, same as any unknown path. See docs/org-mode.md. |

## Development

```bash
nix develop       # optional — node 22 + pnpm, no global install
pnpm install
pnpm dev          # tsx watch — reads your SHELL environment, not .env
pnpm typecheck
pnpm test
pnpm build        # esbuild → dist/main.js
```

## Related

- [openplate](https://github.com/LowCarbCheck/openplate) — the food tracker itself.
  Accountless, device-local, bring-your-own-key.
- [openplate-inference](https://github.com/LowCarbCheck/openplate-inference) — run the
  vision model yourself instead of using a provider.
- [openplate-sync](https://github.com/LowCarbCheck/openplate-sync) — optional
  end-to-end-encrypted sync between your own devices.

## Licence

MIT. See [LICENSE](LICENSE).
