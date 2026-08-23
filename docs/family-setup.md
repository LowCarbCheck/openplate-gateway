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

### 2. Turn on the admin API

This is what lets you add and remove people without editing files or restarting anything.
Generate a token and put it in `.env`:

```bash
openssl rand -base64 32
```

```
GATEWAY_ADMIN_TOKEN=<paste the generated value>
```

**If you leave this unset, there is no admin API at all** — `/admin` answers "no such
endpoint" to everybody, exactly as any other unknown address does. That is deliberate: a
gateway that never wanted an admin API should not advertise that it has one. You can still
add people with `pnpm mint-token` (step 5).

Two more values let the gateway build an invite link. Set them if you want to invite people
by link, which is the easy way:

```
GATEWAY_PUBLIC_URL=http://gateway.lan:3602
CLIENT_BASE_URL=https://app.openplate.example
```

`GATEWAY_PUBLIC_URL` is how *other people on your network* reach the gateway — not
`localhost`, which only means "this machine" to them.

### 3. Start it

```bash
docker compose -f docker/compose.yml up -d
```

**Run it on your home network or your VPN.** The example binds to `127.0.0.1` deliberately.
A gateway on the open internet is a spend endpoint guarded by one bearer token.

It starts with nobody on it. That is normal — you add people next, while it runs.

### 4. Invite each person

**The easiest way is the bundled admin page**, at `http://localhost:3602/admin/ui` (or
whatever host you bound the gateway to). Sign in with `GATEWAY_ADMIN_TOKEN`, and it lists
members and invites, and creates an invite — with a **copy link** button — in a couple of
clicks. Everything below this point is the curl equivalent, for scripting or for when you
would rather not open a browser.

One request per person. `memberId` is a short id that will appear in your logs; `dailyLimit`
is how many requests they get per day.

```bash
curl -s -X POST http://localhost:3602/admin/invites \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"memberId":"alex","dailyLimit":50}'
```

You get back a **link**. Send it to that person however you like:

```json
{
  "id": "9f2c1b7a4e8d0361",
  "expiresAt": "2026-08-26T14:00:00.000Z",
  "link": "https://app.openplate.example/connect-gateway?gateway=...&invite=opgwi_...",
  "emailed": false
}
```

They open it, and openplate connects itself to your gateway. There is nothing for them to
paste and nothing for you to explain.

**The link works once, and expires in 72 hours.** That is the whole reason invites exist: the
thing sitting in your chat history afterwards is worthless. Pass `"ttlHours": 168` for up to a
week if somebody is away.

**To email it instead**, add `"email": "alex@example.com"` and configure SMTP (see
`.env.example`). The response still contains the link, so you are never stuck if the mail does
not arrive — `"emailed": false` tells you it did not.

**To see outstanding invites:** open `/admin/ui`, or:

```bash
curl -s http://localhost:3602/admin/invites -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
```

Each one shows `pending`, `redeemed`, `expired` or `revoked` — this is also where "why
doesn't my invite work" gets answered fastest: the admin page shows the status of every
invite you have sent, so you can see at a glance whether it expired, was already redeemed, or
was revoked, without going near the logs. To withdraw one before it is used,
`DELETE /admin/invites/<id>` (or the matching button in `/admin/ui`).

**Second device, or a lost phone:** send that member a fresh invite. Invites are per member,
not per device — redeeming a new one does not touch their existing token or their quota, it
just gives them another way to connect. Nothing needs to be revoked first.

### 5. Or hand someone a token directly

If you would rather not use invites at all:

```bash
pnpm install
pnpm mint-token alex 50
```

This prints the token **once** and adds the member to the store. It is not saved anywhere and
cannot be recovered — if it is lost, mint a new one. **A running gateway picks the new member
up on the next request; no restart.**

That person then opens openplate → **Settings → AI**, chooses the **OpenAI-compatible**
provider, and enters:

- **Base URL** — the gateway, e.g. `http://gateway.lan:3602/v1`
- **API key** — their own token

Take one photo to confirm it works.

### Running it

**To see who is on the gateway:**

```bash
curl -s http://localhost:3602/admin/members -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
```

Tokens and their digests are never returned by this — or by anything except the one response
that created them.

**To see who is spending what**, read `quota-store.json`, or watch the log — every request
logs the member id and the day's running count. No request or response body is ever logged,
by design.

**To revoke one person:**

```bash
curl -s -X DELETE http://localhost:3602/admin/members/alex \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
```

**This takes effect on their very next request. No restart.** Revocation is per member:
everyone else keeps working untouched, and the revoked token cannot be reused anywhere,
because the gateway is the only thing that ever accepted it.

The member is kept as a revoked record rather than deleted. That is on purpose — it is what
stops the token being quietly reinstated by an old `members.json` or a restored backup.

**To change someone's allowance**, revoke them and invite them again with the new limit. The
gateway does not edit a live member's limit in place, so there is never a moment where it is
unclear which cap applied to which request.

**Allowances reset at UTC midnight**, not at your local midnight. A household can span time
zones, and a local reset would quietly give someone in another zone a second allowance.

**A member with no daily limit gets nothing.** That is deliberate: the failure mode of
"unlimited by default" is one you find out about on a bill.

### Upgrading from a hand-edited `members.json`

Nothing to do. On the first start after the upgrade, the gateway reads your `members.json`,
copies it to `members.json.bak` beside the state files, and folds every entry into the new
store. Everyone's existing token keeps working.

It happens **once**. After that the store is the authority and `members.json` is ignored — so
somebody you revoke through the admin API stays revoked, even though the old file still names
them. You can delete the old file whenever you like.

### If something breaks

**Everything returns 401.** The token does not match any active member. Either it was
revoked, or it was never right — mint or invite a fresh one. A token cannot be recovered.

**Everything returns 403 with `reconsent_required`.** The gateway's privacy mode changed since
that person joined. Their token is real but stale: send them a new invite, which records that
they accepted the current terms.

**Everything returns 429.** Either the day's quota is used up, or the per-minute burst limit
is tripping. The response says which, and carries `Retry-After`.

**`/admin` returns 404.** `GATEWAY_ADMIN_TOKEN` is not set, or the container did not pick it
up. There is no admin API without it, by design.

**An invite link does not work.** The person gets one message for every cause, on purpose — it
would otherwise tell anybody guessing at links which guesses were close. **Check `/admin/ui`
first** — it shows that invite's status (`expired`, `redeemed`, `revoked`) without you needing
to touch the log. If you need the raw event, it is also in your log: search for `Invite
redemption rejected` and read the `reason` field.

**Everyone's allowance reset unexpectedly.** The quota file was lost. It must be on durable
storage — the compose example puts it on a named volume for exactly this reason.

**Nobody can log in after a restart, and the log says there are no members.** The member store
was lost. It must be on the same durable volume as the quota file. Losing it is worse than
losing the counters: it revokes everybody.
