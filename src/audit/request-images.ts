/**
 * The functional core of the audit pipeline: an OpenAI-compatible request body
 * in, the model name and the decoded images out. No I/O, no clock, no config —
 * which is what makes the extraction rules assertable one table at a time.
 *
 * WHAT IT LOOKS FOR. openplate sends the ordinary vision shape: `messages[]`,
 * each with `content` that is either a plain string or an array of parts, and an
 * image part carrying a `data:` URL. Only base64 data URLs are extracted; an
 * `http(s)` image URL is left alone, because the bytes are not ours to fetch and
 * fetching them would make this gateway a request forger.
 *
 * IT IS DELIBERATELY FORGIVING. A part it does not recognise is skipped, not
 * rejected: this is a proxy, the upstream is the authority on request shape, and
 * a strict schema here would refuse whatever field a provider adds next month.
 * The consequence is honest and worth stating — a body that hides an image in a
 * shape this function does not know about is FORWARDED and NOT AUDITED. The
 * audit trail records what this gateway could see, not everything that existed.
 */
import { z } from 'zod';
import type { AuditImage } from './types.js';

/** What a request named when it named no model. Recorded rather than dropped, so the row still resolves. */
export const UNKNOWN_MODEL = 'unknown';

/**
 * `data:<media-type>;base64,<payload>`. Anchored, and the payload class excludes
 * whitespace — the same lesson `scrub.ts` records: a permissive class runs past
 * the URL and eats whatever follows it.
 */
const DATA_URL = /^data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Media type → file extension, for the object key. The map is small on purpose:
 * an extension is a convenience for whoever opens the bucket, not a contract,
 * and guessing one from an unknown media type helps nobody.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function extensionFor(mediaType: string): string {
  return EXTENSIONS[mediaType.toLowerCase()] ?? 'bin';
}

/**
 * Loose everywhere it can be. `catch(undefined)` on the parts means one
 * unrecognised element does not discard the whole message — the surrounding
 * array still yields the parts that did parse.
 */
const ContentPartSchema = z
  .looseObject({
    image_url: z.looseObject({ url: z.string() }).optional(),
  })
  .catch({});

const MessageSchema = z
  .looseObject({
    content: z.union([z.string(), z.array(ContentPartSchema)]).optional(),
  })
  .catch({});

const RequestSchema = z.looseObject({
  model: z.string().min(1).optional(),
  messages: z.array(MessageSchema).optional(),
});

export interface AuditableRequest {
  readonly model: string;
  readonly images: readonly AuditImage[];
}

/** Decodes one data URL, or `null` when the string is not one. */
export function readDataUrl(url: string): AuditImage | null {
  const match = DATA_URL.exec(url);
  if (match === null) return null;
  const [, mediaType, payload] = match;
  if (mediaType === undefined || payload === undefined) return null;
  return { mediaType: mediaType.toLowerCase(), bytes: Buffer.from(payload, 'base64') };
}

/** The model and every base64 image the body carries, in order. */
export function readAuditableRequest(body: unknown): AuditableRequest {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return { model: UNKNOWN_MODEL, images: [] };

  const images: AuditImage[] = [];
  for (const message of parsed.data.messages ?? []) {
    const { content } = message;
    // A string content carries no image by construction; skipping it here is
    // what keeps the loop below from having to re-establish that.
    if (content === undefined || typeof content === 'string') continue;
    for (const part of content) {
      const url = part.image_url?.url;
      if (url === undefined) continue;
      const image = readDataUrl(url);
      if (image !== null) images.push(image);
    }
  }

  return { model: parsed.data.model ?? UNKNOWN_MODEL, images };
}

/**
 * `audit/<memberId>/<utc-date>/<requestId>-<n>.<ext>`.
 *
 * Member first, then date: the member prefix is what makes an erasure request a
 * prefix scan rather than a full-bucket walk, and it is the one operation an org
 * operator is legally obliged to be able to perform quickly.
 */
export function auditObjectKey(parts: {
  memberId: string;
  requestId: string;
  index: number;
  mediaType: string;
  at: Date;
}): string {
  const day = utcDate(parts.at);
  return `audit/${parts.memberId}/${day}/${parts.requestId}-${parts.index}.${extensionFor(parts.mediaType)}`;
}

/** `YYYY-MM-DD`, in UTC. The same day key the quota store uses, for the same reason: no timezone. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
