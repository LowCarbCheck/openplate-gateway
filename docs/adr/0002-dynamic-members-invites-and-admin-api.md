# ADR-0002 — Dynamic members, invites, and an admin API

- **Status:** accepted
- **Date:** 2026-08-23
- **Supersedes:** nothing. **Amends:** ADR-0001's description of the member registry.

## Context

ADR-0001 built the gateway around a hand-edited `members.json` read once at boot. Adding a
person meant minting a token, pasting JSON into a file, and restarting the service. Removing
one meant deleting a line and restarting again.

That was the right amount of machinery for the first version, and it fails in three specific
ways once real households use it:

1. **Revocation needs a restart.** The moment you most want to remove somebody's access —
   a lost phone, a household that has split up — is the moment you least want to drop every
   in-flight request and hope the container comes back. In practice this means revocation
   gets deferred, which is the same as not having it.
2. **Onboarding means sending a live credential over chat.** A member token has no expiry
   and is a spend credential. Handing it over on WhatsApp puts it in a message history
   forever, on two devices and a backup, and there is no way to withdraw it.
3. **Editing JSON on a server is the actual barrier.** The people this feature exists for
   are running a container on a NAS. "SSH in and edit a JSON file, carefully, without
   breaking the syntax, at 23:00 because your partner cannot log in" is not a flow they will
   complete.

## Decision

### Members move to a runtime store

`member-store.json` replaces `members.json` as the authority. It is written at runtime by the
admin API, by an invite redemption, and by `pnpm mint-token`, through the same atomic-rename
and in-process-lock discipline the quota store already uses.

Authentication reads the store **on every request**. That is the point: revocation takes
effect on the next call, with no restart. For a household roster this is one small file read
behind a lock, which is nothing beside the upstream model call it gates. Caching it would put
a staleness window on precisely the operation that must not have one.

Three properties are kept from the old file and are not negotiable:

- **The store holds a SHA-256 digest, never a token.** Tokens are shown once and are not
  recoverable. A backup, a stray `cat`, or a volume snapshot hands nobody a credential.
- **`dailyLimit` defaults to zero, not to unlimited.** The other default is discovered on a
  bill.
- **Revocation is a tombstone, not a delete.** The row stays with `revokedAt` set. Deleting
  it would make a revoked token merely *unknown*, and an unknown token is one that a legacy
  merge or a restored backup is happy to reinstate.

`member-auth.ts` rejects a revoked member with the **same** 401 as an unknown token, after the
**same** full-scan comparison. Filtering revoked members out before the scan is shorter and
faster, and it makes them cheaper to reject — a timing oracle for "this person used to be a
member here".

### The legacy file is migrated exactly once, with a backup

On boot, an existing `members.json` is folded into the store. It runs **once per store**,
recorded by `legacyMigratedAt`, and copies the file to `<state-dir>/members.json.bak` first.

Once-only rather than merge-on-every-boot, because those differ exactly where it hurts: an
operator who revokes a legacy member through the admin API, leaving the old file in place,
would have them reinstated on the next restart. A revocation silently undoing itself is the
worst shape a security bug can take. A test boots the migration three times against one state
directory, with a revocation in the middle, and asserts neither duplication nor resurrection.

An absent `members.json` is now normal. One that **exists and does not parse** is still fatal:
the operator believes in the members inside it, and booting without them silently revokes the
household.

An empty store is no longer fatal either. It used to be, on the reasoning that a gateway
authenticating nobody reads as broken. After this ADR it is the normal first-boot state, and
the operator fills it through the admin API with the service already running. It is logged
loudly instead.

### The admin API is guarded by `GATEWAY_ADMIN_TOKEN`, and answers 404 when unset

If `GATEWAY_ADMIN_TOKEN` is not configured, the whole `/admin` tree answers the ordinary
unknown-endpoint 404 — to every caller, credentialed or not. Not 401.

A 401 would confirm that an admin surface exists on this host and is merely locked, which is
an invitation to return with a wordlist, and the operator who never wanted an admin API has no
idea they are advertising one. A family gateway that never set the variable should be
indistinguishable from a build that never had the feature.

This is subtler than "do not mount the router". Everything after the routing table is behind
member auth, so an unmounted `/admin` **falls through to a 401** — which is the exact signal
the 404 exists to withhold. The 404 terminator is therefore mounted explicitly, before
authentication. A test caught this; the naive version shipped a 401.

The token has a 24-character minimum. Not a strength estimate — it is generated, not chosen —
but a floor that rejects what people paste in when they are in a hurry. Comparison is SHA-256
plus `timingSafeEqual`, the same as member auth: `===` is a prefix oracle, and
`timingSafeEqual` on raw strings is a length oracle.

Admin authentication failures **are logged**, unlike member ones. A member 401 is routine —
a stale token in a phone nobody updated — and logging each is noise. Nobody but the operator
has business calling `/admin`, so every failure there is either a fumbled paste or a probe.
The line carries the method, path and caller address; never the presented value, a prefix of
it, or its length.

Rate limiting sits **in front of** admin auth, keyed on the caller's address. What is worth
limiting is guesses at the admin token, and a limiter behind the authentication it protects
never sees one. That limiter is scoped to `/admin`, `/v1/invites` and `/v1/gateway` — an
IP-keyed limiter in front of the spend route would bucket an entire household behind one NAT
together, which is the unfairness the per-member limiter exists to avoid.

### Invites are one-shot, and every failure looks identical

An invite is a short-lived, single-use credential that becomes a member. It carries the
`opgwi_` prefix so a string found in a log or a chat is identifiable at a glance, and so
pasting one into the wrong field fails cleanly.

`POST /v1/invites/redeem` answers **400 with a byte-identical body** for unknown, expired,
already-redeemed and revoked alike — and for a malformed body, which would otherwise be a
fifth distinguishable answer telling a prober what shape the field takes. This endpoint is
unauthenticated by definition: it is the only way in, so it is the first thing anybody probing
this gateway finds. "Already redeemed" confirms a token existed; "expired" confirms it existed
and narrows when it was issued.

**The real reason is logged server-side at info level**, with the invite id. A self-hoster
whose family member says "the link does not work" has no other way to tell a lapsed invite
from a used one, and the log is the one channel an attacker cannot read.

Redemption claims the invite **first**, in one critical section, and creates the member after.
The reverse order is tempting — a crash between the two would then leave a usable invite
rather than a lost one — and it is wrong: a crash in that order leaves a live invite that has
already produced a member, and the next redemption produces another. One lost invite costs an
operator thirty seconds; an invite that mints members repeatedly is an unbounded spend.

**Copy-link is the primary flow.** `POST /admin/invites` always returns the link and the
token, whether or not mail was sent. Most self-hosters have no SMTP and never will, and a flow
that only worked with a mail server would put the feature out of their reach. Email is an
optional extra: a failed send returns `emailed: false` with a 201, because the invite already
exists and the operator already has the link — failing the request would destroy a working
invite and teach them to retry, creating a second one.

`GET /admin/invites` reports a **derived** status (`pending` / `redeemed` / `expired` /
`revoked`). Derived rather than stored, because a stored status would need a sweeper to ever
become `expired` and would lie until it ran.

### Every member record carries the mode it joined under

`mode` is the gateway's privacy posture at the moment the member was created, and
`member-auth.ts` refuses a member whose mode no longer matches the gateway's, with **403 and
`{"error": "reconsent_required"}`**.

Only `family` is reachable today; the audit pipeline that gives `org` meaning is a later
milestone. The field exists **now** because adding it later would mean every pre-existing row
defaulting into whichever mode the code happened to pick — which is the exact failure it
prevents. An operator who flips a family gateway into an audited org gateway has changed what
happens to their household's requests, and inheriting the old members would apply a new data
policy to people who agreed to the previous one, silently.

This is the one rejection in the service that is **deliberately distinguishable**, and it is
not free: it confirms to whoever holds the token that the token is real. That is the price of
telling a legitimate member their access needs re-issuing rather than leaving them with an
indistinguishable 401 and no next step. The price is only paid after a mode flip an operator
performed on purpose. `consentAt` records the moment a member accepted, at redemption.

### Store format is versioned, and single-process

Both store files carry a top-level `version: 1`. It is the seam a future migration needs: a
later build reads the number and knows which upgrade to run, instead of guessing from which
keys happen to be present. It is defaulted on read so this build accepts a file it wrote
before the field existed.

Mutations serialise on an **in-process** lock. Two gateway processes pointed at one state
directory will lose updates to each other. That is the same assumption the quota store already
makes, it is stated in each module header, and a deployment large enough to break it has
outgrown this design.

### Non-goal: redeeming an invite does NOT create a sync account

An invite produces a **gateway member** — a spending identity, and nothing else. It does not
create, require, or touch an openplate-sync account, and it does not reintroduce a login to
openplate.

This is stated explicitly because the two are easy to conflate and must not be. ADR-0001's
reasoning stands unchanged: a sync account is an *encryption* identity for a zero-knowledge
service; a gateway member is a *spending* identity for a service that forwards plaintext
photographs. They have different lifecycles, different revocation semantics, and no reason to
be the same record. A member redeeming an invite gets a base URL and a key, exactly as anybody
pointing openplate at their own inference box does.

## What this ADR does NOT change

**ADR-0001's no-body-logging guarantee is untouched.** Every property it claims still holds,
by the same mechanisms:

- The logger's field type still admits primitives only, so a body, a Buffer or a request
  cannot be passed to a log call.
- There is still no configuration flag that turns body logging on.
- Every string that could have touched a request still passes through `scrub.ts`.
- The test that drives a real image through the real service and asserts the bytes reach
  neither the logs nor the response is unchanged and still passing.

Nothing added here logs a request body, and the new surfaces carry their own version of the
rule: the invite link is a credential and is never logged; the recipient address is never
logged; an SMTP error is discarded rather than logged, because a mail library's message
routinely quotes the envelope it was rejected on — which is the recipient's address.

## Consequences

- **A dependency.** `nodemailer` is now in the tree, for a feature most operators will not
  configure. It is CommonJS, so it is on the esbuild `external` list; inlining it into the ESM
  bundle produces a dynamic-require shim that would not throw until an operator with SMTP
  configured tried to send an invite — in production, on somebody else's box.
- **`pnpm mint-token` now writes.** Its previous refusal to touch a file was a defence against
  corrupting a hand-edited registry. The store removed that hazard rather than working around
  it: writes are read-modify-write under a lock followed by an atomic rename, and a file that
  does not parse stops the operation instead of being replaced with an empty one. The paste
  step bought nothing the store does not now guarantee, and cost the operator a manual JSON
  edit at the exact moment they were in a hurry.
- **More surface to probe.** Two unauthenticated endpoints and an optional admin API, where
  there were none. This is the reason for the indistinguishable-failure discipline, the
  404-when-unset rule, and the IP-keyed limiter in front of all three.
- **The state directory now holds three files** — quota counters, members, invites — plus a
  one-time `members.json.bak`. All must be on durable storage. Losing the member store is
  worse than losing the quota file: it revokes everybody.
