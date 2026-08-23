# ADR-0003 — Organisation mode amends the no-body-storage guarantee

- **Status:** accepted
- **Date:** 2026-08-23
- **Supersedes:** nothing. **Amends:** ADR-0001's privacy guarantee, explicitly and only when
  an operator opts in.

## Context

ADR-0001 built this gateway around one promise: a plate photograph passes THROUGH the
service and is never stored, never logged, never kept. Every design decision below it
follows from that — the streaming relay, the primitives-only logger field type, the
scrubber, the fixture that records byte counts instead of bytes.

That promise is right for the deployment it was written for: a household sharing one
provider key. It is wrong for a second deployment that keeps asking for this software.

A health clinic, a care home, a school kitchen — an ORGANISATION — cannot run a system
that keeps no record of what was submitted through it. Not because it wants surveillance,
but because it is accountable for what its staff do on its behalf, and "we have no idea
what was sent" is not an answer it is allowed to give. Its obligations run the other way
from a family's: the family wants nothing kept, the organisation is required to keep some
things and to be able to produce and delete them on request.

These are not the same product, and pretending one configuration serves both by accident
would be dishonest to whichever group we were quietly serving badly.

## Decision

Add `ORG_MODE`: an explicit, opt-in mode in which the gateway stores the submitted images
in an operator-controlled S3-compatible bucket and keeps an audit log admins can read,
export and erase.

**Family mode remains the default and keeps ADR-0001's guarantee absolutely.** Not
"mostly", not "unless configured otherwise": a gateway with `ORG_MODE` unset or false
constructs no object-store client, mounts no audit endpoints, buffers no body, and writes
nothing but the roster and the counters it already wrote.

`ORG_MODE=true` demands the whole audit block (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AUDIT_RETENTION_DAYS`) and `ORG_MODE` off
REFUSES all of it. A leftover `S3_BUCKET` on a family gateway is an operator who believes
images are being kept; a boot failure is the only outcome that tells them otherwise.

`AUDIT_RETENTION_DAYS` is required rather than defaulted. A retention period is a legal
decision belonging to the data controller, and a gateway that quietly picked ninety days
would be answering that question on their behalf.

### Rejected: a separate org-only binary

The obvious alternative, and the one with the strongest privacy story: build
`openplate-gateway-org` as a distinct artefact, so the family image *cannot* store
anything because the code is not in it. Nothing to misconfigure, nothing to invert.

**Rejected, because the product wants one gateway with an explicit checked mode.** Two
binaries mean two release trains, two images to scan, two sets of documentation, and a
migration path between them that is a redeploy rather than a config change — and the
operator most likely to move from family to org (a practice that started with one doctor's
own household) is the one least able to perform a redeploy. It also splits the security
fixes: the day a token-comparison bug is found, it has to be fixed and shipped twice, and
the second image is the one that ships late.

Instead we adopt STRUCTURAL GUARDS, which is the part of the rejected option worth keeping:

1. **A separate handler module.** `org-proxy.ts` is not a branch inside `proxy.ts`; it is
   its own file, and `create-app.ts` selects one of the two ONCE, at wiring time, from
   `config.gatewayMode`. A family gateway never constructs the audited handler. The quota
   table and relay logic are DUPLICATED between the two files rather than shared —
   deliberately, so that an org-mode change can never edit the family path.
2. **A boot-time mode log.** The first lines of an org gateway's log say, in words, that
   submitted images and completions are stored and admin-readable.
3. **A zero-write test.** `org-mode-family-writes-nothing.test.ts` asserts that a family
   config constructs no S3 client, that `createApp` REFUSES an audit log it was not
   supposed to receive, and that a real request carrying a real photograph leaves no byte
   of it anywhere in the state directory.
4. **A hard buffer cap.** The org handler is the only path that buffers a body;
   `AUDIT_MAX_BODY_BYTES` bounds it, and an over-cap request is refused with 413 before
   anything is forwarded and before anything is stored.
5. **A non-gating, asynchronous audit.** The audit write happens after the member already
   has their answer and can never delay or fail the AI call.

### Consent is not inherited

Every member record carries the mode it was created under (ADR-0002). After a flip, members
who joined in family mode are refused with `reconsent_required` and must accept a fresh
invite. They are NOT silently absorbed into a mode they never agreed to.

The other half of that sentence has to be said out loud, because it is the thing an
operator will assume wrongly: **requests made BEFORE org mode was enabled were never
audited, and no record of them exists or can be reconstructed.** The audit trail starts at
the moment the flip is deployed. An organisation that turns org mode on today cannot answer
questions about yesterday, and any process that assumes otherwise is built on a
misunderstanding.

## Consequences

### Known limitation: a crash loses the in-flight record

The audit write is deliberately not awaited before the member's response is delivered.
**If the process dies between forwarding a request and completing the audit write, that
request's record is lost.** The completion was served, the member was charged for it, and
nothing records that it happened.

This is the direct price of "the audit never gates the AI call", and it is the right trade
for this system: the alternative is a clinic whose object store hiccups and whose staff
cannot use the tool at all. But it means **this audit trail is not a guaranteed-complete
ledger** and must not be relied on as one. An organisation with a completeness requirement
needs a design where the write is durable before the answer is returned — which is a
different product with a different failure mode, not a setting.

Two smaller consequences of the same ordering: images are uploaded before the record is
appended, so a failure in between leaves ORPHANED OBJECTS in the bucket with no record
pointing at them; and the retention sweep walks records, so an orphan is not swept. Both
are documented in `docs/org-mode.md`.

### Streamed responses are not transcribed

For a `text/event-stream` response, `responseText` is `null`. Reassembling a completion from
provider-specific SSE deltas risks writing a MISQUOTATION into an audit trail — and a
plausible-looking wrong answer in an audit record is worse than an honest absence. The
images and the metadata are still recorded.

### This is not a compliance programme

Org mode gives an operator storage, an audit trail, retention and erasure. It does not give
them a DPA, a lawful basis, a data-protection impact assessment, a processor agreement with
their model provider, or a records-of-processing document. The operator is the data
controller and owns those duties entirely. `docs/org-mode.md` says so in the first
paragraph, deliberately.
