# Security

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** button on this
repository's Security tab, rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept helps.
Please do not include anyone's real API key or any real plate photograph in a report.

## What this service protects

The gateway holds one asset that matters: **the payer's upstream provider key**. Everything
else is a counter. The threat model is, in order:

1. **Exposure of the upstream key.** It exists in exactly one place — the environment of
   the running process. It is never logged, never returned in an error, and never sent
   anywhere except the configured upstream in an `Authorization` header.
2. **Spend abuse through a leaked member token.** Per-member daily quotas bound the damage,
   and a per-minute rate limit bounds the burst. A leaked token is revoked by deleting one
   line from the members file; no other member is affected.
3. **Leakage of request content.** Requests carry photographs of people's meals. No request
   or response body is written to any log at any level, and every upstream error string is
   scrubbed of data URIs and long base64 runs before it reaches a log line or an HTTP
   response.

## Design choices that follow from that

- **Member tokens are stored as SHA-256 digests**, never in plaintext. A token is displayed
  once, at minting time.
- **Token comparison is constant-time over a fixed-length digest.** Comparing raw strings
  leaks a prefix oracle through timing; comparing raw buffers leaks the token length.
- **Absent, malformed and unknown tokens produce the identical response.** Telling them
  apart tells an attacker which guesses were close.
- **The logger's field type admits primitives only.** Passing a body, a buffer or a request
  into a log call is a compile error, not a code-review question.
- **Quotas deny by default.** A member with no configured limit is denied, not admitted.

## Deployment guidance

Run it on a LAN or a VPN. The shipped compose example binds to `127.0.0.1`. A gateway
reachable from the internet is a spend endpoint guarded by one bearer token — if you expose
it deliberately, put a reverse proxy in front of it and keep the rate limit tight.

## Supported versions

This project is pre-1.0. Fixes land on `main` and in the latest tag.
