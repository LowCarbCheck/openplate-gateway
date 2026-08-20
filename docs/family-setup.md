# Sharing one AI key with your family

openplate is bring-your-own-key: each person points it at an AI provider and pays for their
own plate photographs. In a household that is silly — one person is happy to pay, and
nobody wants four separate provider accounts.

There are two ways to fix that. **Most families should use the first one**, which needs no
software at all.

## Which one do you need?

**Use OpenRouter sub-keys if** your provider is OpenRouter. Five minutes, no server, no
maintenance. Skip straight to the next section and you are done.

**Run the gateway if** any of these is true:

- Your provider is Mistral, or anything else that cannot issue per-key spend limits.
- You are pointing the family at your own
  [openplate-inference](https://github.com/LowCarbCheck/openplate-inference) box, which has
  a single shared key and no per-person notion at all.
- You want a **daily request cap per person** rather than a credit balance per person.

**Your food diary is never shared by either option.** openplate keeps each person's diary
in their own browser's storage, on their own device, and nothing in this page changes that.
Both options carry AI requests — a photograph goes out, an estimate comes back — and
nothing else. What your household shares is the bill, not the data. The person paying
cannot see what anyone ate; they can see how many requests each person made.

---

## Option 1 — OpenRouter sub-keys (no software)

OpenRouter can mint sub-keys under your account, each with its own credit limit. That is
exactly the feature you want, and it already exists.

1. Sign in to OpenRouter as the person paying, and open the **Keys** page.
2. Create one key per family member. Give each a name you will recognise later — their
   actual name works well.
3. Set a **credit limit** on each key. This is the cap; without it the key can spend your
   whole balance.
4. Send each person their own key. Nobody but you ever sees the account.
5. Each person opens openplate → **Settings → AI**, picks **OpenRouter**, and pastes their
   key.

**To see who is spending what**, look at the per-key usage on the OpenRouter dashboard.

**To revoke one person**, delete their key. Revocation is per key: nobody else is affected,
nobody else has to change a setting, and the person you revoked cannot fall back to
anything — their key was the only credential they ever had.

**To give someone more**, raise that key's limit. No restart, no redeploy.

That is the whole thing. You do not need the rest of this page.

---

## Option 2 — run the gateway

The gateway sits between your family and the provider. It holds the one real key; each
person gets a token that only works through the gateway and only up to their daily limit.

### 1. Get it running

```bash
git clone https://github.com/LowCarbCheck/openplate-gateway
cd openplate-gateway
cp .env.example .env
```

Edit `.env` and set the two values that have no default:

```
UPSTREAM_BASE_URL=https://api.mistral.ai/v1
UPSTREAM_API_KEY=<your real provider key>
```

`UPSTREAM_BASE_URL` is whichever provider you are paying. Some examples:

| Provider | Base URL |
| --- | --- |
| Mistral | `https://api.mistral.ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Your own openplate-inference | `http://inference:8300/v1` |

**Put a hard spend cap on that upstream key at the provider as well.** The gateway counts
*requests*; only the provider can count *money*. A request's cost depends on the model and
the image, so the two caps are not substitutes for each other.

### 2. Mint a token for each person

```bash
pnpm install
pnpm mint-token alex 50
```

The first argument is a short id that will appear in your logs. The second is how many
requests that person gets per day.

This prints the token **once**. It is not stored and not recoverable — if it is lost, mint a
new one. It also prints a JSON block; paste that into `members.json` (copy
`members.example.json` to start). The file holds only a digest of the token, so someone who
reads it still cannot use it.

Repeat for each person.

### 3. Start it

```bash
mkdir -p config && cp members.json config/members.json
docker compose -f docker/compose.yml up -d
```

**Run it on your home network or your VPN.** The example binds to `127.0.0.1` deliberately.
A gateway on the open internet is a spend endpoint guarded by one bearer token.

### 4. Point each person at it

Each person opens openplate → **Settings → AI**, chooses the **OpenAI-compatible** provider,
and enters:

- **Base URL** — the gateway, e.g. `http://gateway.lan:3602/v1`
- **API key** — their own token

Take one photo to confirm it works.

### Running it

**To see who is spending what**, read `quota-store.json`, or watch the log — every request
logs the member id and the day's running count. No request or response body is ever logged,
by design.

**To revoke one person**, delete their entry from `members.json` and restart. Revocation is
per member: everyone else keeps working untouched, and the revoked token stops matching
immediately — it cannot be reused anywhere, because the gateway is the only thing that ever
accepted it.

**To change someone's allowance**, edit their `dailyLimit` and restart.

**Allowances reset at UTC midnight**, not at your local midnight. A household can span time
zones, and a local reset would quietly give someone in another zone a second allowance.

**A member with no `dailyLimit` gets nothing.** That is deliberate: the failure mode of
"unlimited by default" is one you find out about on a bill.

### If something breaks

**Everything returns 401.** The token does not match any digest in `members.json`. Mint a
fresh one — a token cannot be recovered from the file.

**Everything returns 429.** Either the day's quota is used up, or the per-minute burst limit
is tripping. The response says which, and carries `Retry-After`.

**Everyone's allowance reset unexpectedly.** The quota file was lost. It must be on durable
storage — the compose example puts it on a named volume for exactly this reason.

**Nothing loads at all after a restart.** The members file is missing or malformed. That is
fatal on purpose: a gateway that authenticates nobody is a bug, not a safe default. The
startup error names the problem.
