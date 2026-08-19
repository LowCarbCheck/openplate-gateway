# ADR-0001 — A separate gateway service

- **Status:** accepted
- **Date:** 2026-08-19

## Context

openplate is bring-your-own-key: each person supplies their own AI provider key, and it
never leaves their device. That is the right default for one person and a poor one for a
household, where one person is willing to pay for everyone.

The obvious fix — give everyone the same key — is how keys leak, and it gives nobody a way
to see or cap what each person spends.

A second, initially unrelated problem has the same shape. Some people would rather not run
or configure anything, and would accept a small operated service that does the AI part for
them. That service also needs to hold one provider key and spend it on behalf of several
people who must not hold it.

They are one problem: **spend one key on behalf of many identities, with a cap per
identity.**

## Decision

Build a separate, self-contained service — an OpenAI-compatible proxy that holds one
upstream key and issues per-member tokens with hard daily quotas.

It is a **new repository**, not a feature of an existing one.

### Why not a mode of openplate-inference

`openplate-inference` runs a vision model. Its image carries a llama.cpp runtime, its
sizing assumes a GPU, and it exists to make model weights easy to serve.

A family gateway must run on whatever box is already in the house — a Raspberry Pi, a NAS,
a small VPS. It must not carry a model runtime it will never load. Merging the two would
mean either shipping a GB-scale image to people who want a 20 MB proxy, or splitting the
image and maintaining both variants of one repo.

There is also an authentication mismatch. `openplate-inference` authenticates with a set of
static bearer keys and has no notion of *which* key matched, because it does not need one.
Per-member quotas need exactly that, and retrofitting it changes the meaning of the
existing configuration.

### Why not part of openplate-sync

`openplate-sync` is deliberately zero-knowledge. It stores ciphertext it holds no key for,
and that single property is what makes it safe to run and safe to trust.

The gateway forwards **plaintext photographs**. Putting those two things in one service
would destroy the sync service's only security claim, and would make its threat model
impossible to explain — "this service cannot read your data, except on the other endpoint,
where it can".

Its accounts are also the wrong kind. A sync account is an encryption identity. A gateway
member is a spending identity. They have different lifecycles, different revocation
semantics, and no reason to be the same record.

### Why the client does not change

openplate already ships an `openai-compatible` provider whose base URL and key are supplied
by the user. A gateway member token is exactly that: a base URL and a key.

So there is nothing to build on the client, and — more importantly — **no accounts return
to it**. openplate has no login, and the gateway does not reintroduce one through a side
door. A member pastes two strings into a settings form, the same as anyone pointing the app
at their own inference box.

### Why region is chosen, never detected

Where an operated instance runs is a property of the instance, not of the visitor. Each
deployment has its own hostname, and the token a person is given names the endpoint they
were signed up for.

The alternative — inspecting the caller's IP address to route them — would mean processing
personal data in order to decide where to send health-adjacent personal data, for a
decision the user could simply have made. It also misroutes anyone using a VPN or
travelling, which is a bad experience on top of an unnecessary legal exposure.

### Why no request body is ever logged

The service carries photographs of people's meals. "We do not log them" is a claim, and a
claim that cannot be checked is worth little.

So it is a property of the code rather than a setting:

- The logger's field type admits primitives only, which makes passing a body, a buffer or a
  request into a log call a compile error rather than a code-review question.
- There is no configuration flag that turns body logging on. There is nothing to switch.
- Every string that could have touched a request — in particular an upstream provider's
  error message, which may quote the input that caused it — is scrubbed of data URIs and
  long base64 runs before it reaches a log line or a response.
- A test drives a real request carrying an image through the real service, forces an error
  that *does* echo the payload, and asserts the bytes appear in neither the logs nor the
  response.

This is the argument for the service being open source at all. A closed service can promise
the same thing; this one can be read.

## Consequences

- A fourth repository to maintain, release and document.
- Most families will never need it: a provider that issues sub-keys with credit limits
  already solves this without software, and `docs/family-setup.md` says so first, before
  describing the gateway.
- The gateway counts requests, not currency. A request's cost depends on the model and the
  image, so an upstream spend cap at the provider remains necessary. The documentation
  states this rather than implying the quota is a financial control.
- Quota state is a file. That is enough for a household and for a small operated instance,
  and it keeps the service free of a database. A deployment large enough to need more has
  outgrown this design, which is a good problem and a later decision.
