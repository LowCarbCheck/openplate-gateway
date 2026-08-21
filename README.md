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
- It is not an accounts system. There is no signup, no user table and no admin API —
  members live in a JSON file the operator edits.
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

Mint a token for each member. This prints the token **once** — it is not recoverable
afterwards, and the file stores only its digest.

```bash
pnpm install
pnpm mint-token alex 50     # member id, requests per day
```

Create the members file from the committed template, paste the printed entry into it,
then start the gateway:

```bash
mkdir -p config && cp members.example.json config/members.json
# edit config/members.json — paste the entry that mint-token printed
docker compose -f docker/compose.yml up -d
```

Each member opens openplate → **Settings → AI**, chooses the **OpenAI-compatible**
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

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | member token | The proxy. Streaming is passed through. |
| `GET` | `/healthcheck` | none | Liveness. |

## Development

```bash
nix develop       # optional — node 22 + pnpm, no global install
pnpm install
pnpm dev          # tsx watch
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
