/**
 * The last line of defence for the privacy promise: a scrubber every string that
 * could have touched a request runs through before it is logged or returned.
 *
 * WHY THIS EXISTS EVEN THOUGH NO CALL SITE LOGS A BODY. Our own call sites are
 * disciplined — `logger.ts`'s field type will not even accept a Buffer. The gap
 * is somebody ELSE's string: a dependency that helpfully includes the input it
 * choked on in its `Error.message`, a validation library that quotes the
 * offending value, an upstream provider that echoes the request it rejected, a
 * future contributor who adds one `${error}`. On the happy path none of that
 * fires, which is precisely why the happy path passing proves nothing.
 *
 * A proxy makes this sharper than it is in a normal service: the body we are
 * protecting is a plate photograph we did not produce and do not keep, and the
 * one component most likely to quote it back at us is the upstream provider —
 * i.e. exactly the string we are most tempted to log verbatim when a call fails.
 *
 * So: scrub at the boundary, and let a test prove it by throwing an error that
 * DOES carry the base64 and asserting the bytes appear in neither the log lines
 * nor the response body.
 */

import { z } from 'zod';

const REDACTED = '[redacted]';

/**
 * A data URI of any media type. The payload class deliberately excludes
 * whitespace: a real data URI contains none, and including `\s` here made the
 * match run past the URI and eat the rest of the sentence — which destroys the
 * message a human is meant to read.
 */
const DATA_URI = /data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/g;

/**
 * A bare base64-ish run. 48 chars is well below any real image payload and well
 * above any identifier we log (a key id prefix is 8, a UUID is 36), so this
 * cannot eat a field we actually wanted to read.
 */
const LONG_BASE64_RUN = /[A-Za-z0-9+/=]{48,}/g;

/** Replaces data URIs and long base64 runs with a marker. Idempotent. */
export function scrubPayloads(text: string): string {
  return text.replace(DATA_URI, REDACTED).replace(LONG_BASE64_RUN, REDACTED);
}

/**
 * A scrubbed one-line description of an unknown thrown value, safe to log.
 * Never includes a stack (a stack can quote source lines) and never the `cause`
 * chain (which is where a wrapped library error's echoed input hides).
 *
 * The value reaching here was produced by `throw`, and JS permits throwing
 * anything — a string, a number, a DOM-ish object, a Buffer. `unknown` is the
 * honest annotation, and it is what forces the two checks below; a narrower one
 * would be a guess, and this function's whole job is to be right about values
 * nobody promised anything about.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return scrubPayloads(error.message);
  const asText = z.string().safeParse(error);
  if (asText.success) return scrubPayloads(asText.data);
  return 'unknown error';
}
