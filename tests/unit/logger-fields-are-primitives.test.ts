/**
 * `LogFields` admits primitives ONLY, and that type IS the privacy guarantee.
 *
 * "No request or response body ever reaches a log line" is enforced here at
 * compile time, not by discipline: with no `unknown`, `object` or index-signature
 * escape hatch in the type, `logger.info('...', { body: req.body })` does not
 * compile. Widening it — to `Record<string, unknown>`, or by adding `| object`
 * for one convenient call site — silently defeats the whole design, because the
 * code that would then leak a plate photograph looks entirely ordinary and no
 * runtime test would notice.
 *
 * So this file is a TYPE test. The `@ts-expect-error` lines are the assertions:
 * each one currently marks a real compile error, and `tsc` fails on an
 * `@ts-expect-error` that has nothing to suppress. Widen `LogFields` and this
 * file stops compiling — which is exactly the alarm we want, since a widened
 * type produces no runtime symptom at all.
 *
 * If a log line needs richer information, derive a PRIMITIVE from it: a byte
 * count, a member id, a status. Counts are not bytes.
 */
import { describe, expect, it } from 'vitest';
import { createCapturingLogger, type LogFields } from '../../src/logger.js';

describe('LogFields', () => {
  it('accepts strings, numbers, booleans and null', () => {
    const fields: LogFields = {
      memberId: 'alex',
      tokenFingerprint: 'a1b2c3d4',
      requestBytes: 30_412,
      streaming: true,
      upstreamStatus: 502,
      quotaLimit: null,
    };
    expect(Object.keys(fields)).toHaveLength(6);
  });

  it('rejects an object — this is what stops a request body being logged', () => {
    // @ts-expect-error — a parsed request body is an object, and `LogFields`
    // has no branch that accepts one. Removing this error means the type was
    // widened and the compile-time guarantee is gone.
    const withBody: LogFields = { body: { messages: [{ role: 'user' }] } };
    expect(Object.keys(withBody)).toEqual(['body']);
  });

  it('rejects a Buffer — decoded image bytes must not be loggable either', () => {
    // @ts-expect-error — a Buffer is the shape the payload actually has once it
    // is off the wire.
    const withBuffer: LogFields = { payload: Buffer.from([0xff, 0xd8, 0xff]) };
    expect(Object.keys(withBuffer)).toEqual(['payload']);
  });

  it('rejects an array, including an array of primitives', () => {
    // @ts-expect-error — content parts arrive as an array, and one of them is
    // the image.
    const withArray: LogFields = { contentParts: ['text', 'image_url'] };
    expect(Object.keys(withArray)).toEqual(['contentParts']);
  });

  it('rejects undefined, so an absent value is an explicit null', () => {
    // @ts-expect-error — `undefined` would let a missing field be spelled two
    // ways, and `JSON.stringify` drops one of them silently.
    const withUndefined: LogFields = { memberId: undefined };
    expect(Object.keys(withUndefined)).toEqual(['memberId']);
  });
});

describe('the logger call sites', () => {
  it('records the primitive fields it is given, unchanged', () => {
    const captured = createCapturingLogger();

    captured.logger.warn('Upstream provider returned an error', {
      memberId: 'alex',
      upstreamStatus: 502,
      responseBytes: 1024,
    });

    expect(captured.lines).toEqual([
      {
        level: 'warn',
        message: 'Upstream provider returned an error',
        fields: { memberId: 'alex', upstreamStatus: 502, responseBytes: 1024 },
      },
    ]);
  });

  it('records an empty field bag when none is given', () => {
    const captured = createCapturingLogger();
    captured.logger.info('openplate-gateway listening');
    expect(captured.lines[0]?.fields).toEqual({});
  });
});
