/**
 * The org-mode audit vocabulary: what a record is, and the two PORTS the audit
 * pipeline talks to the world through.
 *
 * Ports rather than concrete clients for one reason that matters more here than
 * anywhere else in this service: the unit suite must be able to prove what is
 * and is not written, and it cannot do that against a client that opens a
 * socket. `ObjectStore` is implemented once for real (`s3-object-store.ts`) and
 * once for tests, and NOTHING above this file imports `@aws-sdk/client-s3`.
 *
 * SEE ADR-0003. Everything described here is an explicit, opt-in amendment to
 * ADR-0001's "no request body is ever stored" guarantee. In family mode none of
 * it is constructed, none of it is mounted, and none of it can run.
 */

/**
 * One audited request. This is the WHOLE record — there is no second table and
 * no hidden field.
 *
 * `responseText` is `null` for a streamed completion; see `org-proxy.ts` for
 * why the streaming path deliberately does not reassemble one.
 */
export interface AuditRecord {
  /** ISO-8601 UTC, taken when the request was received. */
  readonly ts: string;
  readonly memberId: string;
  /** Unique per request, and the thing that ties the record to its objects. */
  readonly requestId: string;
  /** The model the member asked for. `unknown` when the body named none. */
  readonly model: string;
  /** Object keys in the bucket, in the order the images appeared in the request. */
  readonly imageKeys: readonly string[];
  readonly responseText: string | null;
}

/** What `record` needs before the keys exist. The log builds the keys itself. */
export interface AuditImage {
  /** From the data URL, e.g. `image/jpeg`. Decides the object's extension and content type. */
  readonly mediaType: string;
  readonly bytes: Buffer;
}

export interface AuditWriteInput {
  readonly ts: string;
  readonly memberId: string;
  readonly requestId: string;
  readonly model: string;
  readonly images: readonly AuditImage[];
  readonly responseText: string | null;
}

/**
 * The object-storage port. Deliberately three methods and no more: the audit
 * pipeline puts, deletes and never reads back. A `get` here would be a way for
 * this process to pull a stored photograph into memory again, and nothing in
 * this service has a reason to.
 */
export interface ObjectStore {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Deletes one key. Absent keys are not an error — deletion is idempotent by design. */
  delete(key: string): Promise<void>;
}

/** Filters for the admin list and export endpoints. Every field is optional. */
export interface AuditQuery {
  readonly memberId?: string;
  /** Inclusive ISO date (`YYYY-MM-DD`) or full timestamp. */
  readonly from?: string;
  /** Inclusive: a bare `YYYY-MM-DD` covers the whole of that UTC day. */
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditPage {
  readonly records: readonly AuditRecord[];
  /** How many records matched the filter, before paging. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Counts, never contents. Everything this pipeline logs or returns about a deletion is a number. */
export interface AuditDeletion {
  readonly records: number;
  readonly objects: number;
}

export interface AuditLog {
  /**
   * Uploads the images and appends the record.
   *
   * CALLED AFTER THE MEMBER HAS THEIR ANSWER, never before — see `org-proxy.ts`.
   * It may throw; the caller logs and continues. It must never be awaited on the
   * request path.
   */
  record(input: AuditWriteInput): Promise<void>;
  list(query: AuditQuery): Promise<AuditPage>;
  /** Every matching record, unpaged — for the JSONL export. */
  find(query: AuditQuery): Promise<readonly AuditRecord[]>;
  /** Erases one member's records AND their stored images. */
  eraseMember(memberId: string): Promise<AuditDeletion>;
  /** Deletes everything older than the configured retention. */
  sweep(now: Date): Promise<AuditDeletion>;
}
