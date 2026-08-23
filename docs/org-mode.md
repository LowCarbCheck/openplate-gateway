# Organisation mode

> **This feature is not a substitute for a DPA or a compliance programme.**
>
> Org mode gives you object storage, an audit trail, a retention period and an erasure
> endpoint. It does not give you a lawful basis for processing, a data-processing agreement
> with your AI provider, an impact assessment, a records-of-processing document, or advice
> about any of them. **You are the data controller. The legal duties are yours.** This
> software is a tool you may use to meet some of them; deciding which, and whether it is
> enough, is your job and your lawyer's.

## What it changes

By default (`ORG_MODE` unset) this gateway is a **family gateway**: a request passes through
it and is never stored or logged. That is ADR-0001's guarantee and it is absolute.

With `ORG_MODE=true` the gateway becomes an **organisation gateway**:

- every submitted image is stored in **your** S3-compatible bucket;
- every completed request writes an **audit record** — timestamp, member, request id, model,
  the object keys of its images, and the response text;
- admins can **list, export and erase** those records over the admin API;
- records and their objects are **deleted automatically** once they are older than
  `AUDIT_RETENTION_DAYS`;
- `/v1/gateway/info` reports `auditEnabled: true`, and so does the response a person gets
  when they redeem an invite — so nobody joins an audited gateway without being told.

See [ADR-0003](adr/0003-organization-mode-amends-the-no-body-logging-guarantee.md) for why
this exists and what was rejected on the way.

## Setup

### 1. Create a bucket

Any S3-compatible store works, and a custom endpoint is a first-class setting — this mode
exists for organisations that must keep the images on hardware they control.

**MinIO, on the same host:**

```yaml
# docker-compose.yml (excerpt)
services:
  minio:
    image: quay.io/minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio-admin
      MINIO_ROOT_PASSWORD: change-me-please
    volumes:
      - minio-data:/data
```

```bash
mc alias set local http://127.0.0.1:9000 minio-admin change-me-please
mc mb local/plate-audit
# A dedicated, bucket-scoped user — never the root credential.
mc admin user add local gateway-audit a-generated-secret
mc admin policy attach local readwrite --user gateway-audit
```

### 2. Configure the gateway

```bash
ORG_MODE=true

S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1              # MinIO ignores it; the SDK requires one
S3_BUCKET=plate-audit
S3_ACCESS_KEY_ID=gateway-audit
S3_SECRET_ACCESS_KEY=a-generated-secret
S3_FORCE_PATH_STYLE=true         # MinIO and most self-hosted stores need this

AUDIT_RETENTION_DAYS=30          # REQUIRED — see below
AUDIT_MAX_BODY_BYTES=20971520    # optional, default 20 MB
AUDIT_STORE_FILE=/app/state/audit-log.jsonl   # optional; MUST be on the state volume
```

On AWS the only differences are the endpoint and path style:

```bash
S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
S3_REGION=eu-central-1
S3_FORCE_PATH_STYLE=false
```

**The block is all-or-nothing, in both directions.** `ORG_MODE=true` with a variable missing
fails at boot; any of these set while `ORG_MODE` is off ALSO fails at boot, rather than
being ignored — an ignored bucket is an operator who believes images are being kept.

`AUDIT_RETENTION_DAYS` has no default on purpose. A retention period is your decision, not
ours.

### 3. Re-invite your members

Every member record carries the mode it was created under. After the flip, existing members
are refused with `reconsent_required` and must accept a fresh invite — they never agreed to
be audited, and inheriting them silently would apply a new data policy to an old agreement.

**Requests made before you enabled org mode were never audited.** No record of them exists
and none can be reconstructed. Your audit trail starts at this deployment.

### 4. Check the boot log

```
FAMILY MODE: request bodies are relayed and never stored or logged.
```
or
```
ORGANISATION MODE: submitted images and completions are STORED and auditable by admins.
```

If that line does not say what you expect, stop and fix the configuration before anybody
uses the gateway.

## What is stored, and where

**In the bucket:** one object per submitted image, at

```
audit/<memberId>/<YYYY-MM-DD>/<requestId>-<n>.<ext>
```

The member id comes first so that erasing one person is a prefix scan rather than a
full-bucket walk.

**In `AUDIT_STORE_FILE`:** one JSON object per line.

```json
{"ts":"2026-08-23T09:14:02.113Z","memberId":"kim","requestId":"6f0…","model":"some-vision-model","imageKeys":["audit/kim/2026-08-23/6f0…-0.jpg"],"responseText":"rice, chicken"}
```

`responseText` is `null` for a **streamed** answer. Reassembling a completion from
provider-specific SSE frames risks writing a misquotation into an audit trail, and an
honest gap is worth more than a plausible wrong answer.

**Nothing is ever written to the log.** Log lines carry counts, ids and object keys — never
image bytes and never response text.

## Reading the trail

All three endpoints are on the existing admin API, behind `GATEWAY_ADMIN_TOKEN` and its rate
limit. In family mode they do not exist at all — `/admin/audit` answers the same 404 as any
unknown path.

```bash
# List, newest first, paged. Every parameter is optional.
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://gateway.example/admin/audit?member=kim&from=2026-08-01&to=2026-08-23&limit=50&offset=0"

# Export the same selection as JSONL, as a file download.
curl -OJ -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://gateway.example/admin/audit/export?member=kim"

# Erase one person: their records AND their stored images. Returns counts.
curl -X DELETE -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://gateway.example/admin/audit/member/kim"
# → {"memberId":"kim","deleted":{"records":42,"objects":57}}
```

A bare `to=YYYY-MM-DD` covers the **whole** of that UTC day. An unparseable date is refused
with a 400 rather than silently dropped — a filter that quietly became "everything" would
hand you the wrong answer with no way to tell.

Erasing an audit trail does **not** revoke the member. Use `DELETE /admin/members/:id` for
that; they are two different requests.

## Retention

The sweep runs **once at startup and then daily**, and deletes every record — and every
object it points at — older than `AUDIT_RETENTION_DAYS`. The boot run matters: a container
that restarts nightly would otherwise never reach a daily timer.

It logs counts only. A retention log that named what it deleted would outlive the data it
deleted.

## Limitations you must know about

1. **A crash can lose one record.** The audit write happens after the member's answer is
   delivered, so the AI call never waits on the bucket. If the process dies in between, that
   request's record is lost — the completion was served and nothing records it. This trail is
   not a guaranteed-complete ledger. See ADR-0003.
2. **Orphaned objects are possible.** Images are uploaded before the record is appended, so
   a failure in between leaves objects with no record pointing at them. The retention sweep
   walks records, so it does not remove orphans. Use your object store's own lifecycle rules
   as a backstop if this matters to you.
3. **An unrecognised request shape is forwarded but not audited.** The extractor understands
   the standard OpenAI vision shape (`messages[].content[].image_url.url` carrying a base64
   data URL). An image hidden in a shape it does not know about is relayed normally and does
   not appear in the trail. `http(s)` image URLs are deliberately not fetched.
4. **Single process.** Like every other store here, the audit file is serialised in-process.
   Two gateways pointed at one state directory will lose records to each other.
5. **The bucket is yours to secure.** The gateway writes objects; it does not set bucket
   policy, encryption at rest, versioning, access logging or lifecycle rules. Use a
   dedicated bucket-scoped credential, never a root one.
