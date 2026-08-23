/**
 * The three org-mode admin endpoints: read the audit trail, export it, erase one
 * member from it.
 *
 * ── THEY DO NOT EXIST IN FAMILY MODE ────────────────────────────────────────
 * Not "return 403", not "return an empty list" — the router is never mounted, so
 * `/admin/audit` reaches the same 404 as any unknown path. Same discipline as
 * `/admin` itself when no admin token is configured: a 403 would confirm that an
 * audit trail exists on this host, and on a family gateway there is nothing to
 * confirm.
 *
 * ── THEY LIVE INSIDE THE EXISTING ADMIN ROUTER ──────────────────────────────
 * Mounted by `createAdminRoutes`, so they inherit its bearer-token auth and the
 * IP rate limit `create-app.ts` puts in front of `/admin`. There is no second
 * credential and no second limiter to get wrong — an audit trail is the most
 * sensitive surface in this service and it must not be the one with bespoke
 * auth.
 *
 * ── THE ERASURE ENDPOINT IS THE POINT OF THE WHOLE FEATURE ──────────────────
 * An organisation that stores images of the people it serves owes those people a
 * way to have them removed. `DELETE /admin/audit/member/:id` removes the records
 * AND the stored objects, and returns the counts so the operator has something
 * to write down. It does NOT touch the member's account: erasing somebody's
 * audit trail and silently revoking their access are two different requests.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AuditLog, AuditQuery } from '../audit/types.js';
import { MAX_AUDIT_PAGE_SIZE } from '../audit/audit-log.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { asyncHandler } from './async-handler.js';

/**
 * An ISO date (`YYYY-MM-DD`) or a full ISO timestamp. Validated rather than
 * passed through, because an unparseable filter that silently becomes "no
 * filter" hands an admin the whole log when they asked for one day of it — and
 * they would have no way to tell.
 */
const isoDateOrTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'must be an ISO date (YYYY-MM-DD) or timestamp',
  });

const AuditQuerySchema = z.object({
  member: z.string().min(1).optional(),
  from: isoDateOrTimestamp.optional(),
  to: isoDateOrTimestamp.optional(),
  limit: z.coerce.number().int().positive().max(MAX_AUDIT_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/** Turns a zod failure into the service's own 400, naming parameters and never values. */
function parseQuery(raw: unknown): AuditQuery {
  const parsed = AuditQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw badRequest(`Invalid audit query: ${details}`);
  }
  const { member, from, to, limit, offset } = parsed.data;
  return {
    ...(member === undefined ? {} : { memberId: member }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

export interface AuditRoutesDeps {
  readonly audit: AuditLog;
  readonly logger: Logger;
}

export function createAuditRoutes(deps: AuditRoutesDeps): Router {
  const { audit, logger } = deps;
  const router = Router();

  router.get(
    '/audit',
    asyncHandler(async (req, res) => {
      const page = await audit.list(parseQuery(req.query));
      res.status(200).json(page);
    }),
  );

  router.get(
    '/audit/export',
    asyncHandler(async (req, res) => {
      const records = await audit.find(parseQuery(req.query));
      // JSONL, the same shape the store holds on disk: one record per line, so
      // the export can be streamed into any tool that reads lines and so a
      // truncated download is still parseable up to the last complete line.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-export.jsonl"');
      res.send(records.map((record) => `${JSON.stringify(record)}\n`).join(''));
    }),
  );

  router.delete(
    '/audit/member/:id',
    asyncHandler(async (req, res) => {
      const memberId = req.params.id ?? '';
      const deleted = await audit.eraseMember(memberId);
      // Counts, never contents — a deletion log that named what it deleted would
      // outlive the data it deleted.
      logger.info('Audit records erased for a member', {
        memberId,
        records: deleted.records,
        objects: deleted.objects,
      });
      res.status(200).json({ memberId, deleted });
    }),
  );

  return router;
}
