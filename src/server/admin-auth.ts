/**
 * Bearer authentication for the admin API — the operator's credential, not a
 * member's.
 *
 * SAME TIMING DISCIPLINE AS `member-auth.ts`, AND FOR A BIGGER PRIZE. This one
 * token can list the roster, mint members and issue invites, so it is worth
 * more to an attacker than any single member token. `===` returns early at the
 * first differing character, which is a prefix oracle; `timingSafeEqual` on the
 * raw strings refuses unequal lengths, which is a length oracle. Hashing both
 * sides first makes every candidate exactly 32 bytes, so neither is observable.
 *
 * WHY THE FAILURES ARE LOGGED AND THE MEMBER ONES ARE NOT. A member 401 is
 * routine — a stale token in a phone that has not been updated — and logging
 * each one turns the log into noise. An admin 401 is not routine: nobody but the
 * operator has any business calling `/admin`, so every failure is either the
 * operator fumbling a paste or somebody probing. The log line carries the method
 * and path and the caller's address. It never carries the presented value, nor a
 * prefix of it, nor its length.
 *
 * IT IS NEVER MOUNTED WHEN THERE IS NO TOKEN. `admin-routes.ts` answers 404 for
 * the whole `/admin` tree in that case, so this middleware always has something
 * to compare against and never has to decide what "no configured token" means.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../errors.js';
import type { Logger } from '../logger.js';
import { parseBearerHeader } from './member-auth.js';

/** One sentence for absent, malformed and wrong alike — see `member-auth.ts`. */
const REJECTION_MESSAGE = 'Invalid admin token. Send `Authorization: Bearer <admin token>`.';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface CreateAdminAuthOptions {
  adminToken: string;
  logger: Logger;
}

export function createAdminAuth(options: CreateAdminAuthOptions): RequestHandler {
  // Hashed once, at construction. The per-request work is one hash plus one
  // fixed-size comparison.
  const expectedDigest = digest(options.adminToken);
  const { logger } = options;

  return function requireAdminToken(req: Request, _res: Response, next: NextFunction): void {
    const presented = parseBearerHeader(req.header('authorization'));
    if (presented === null) {
      logger.warn('Admin request rejected', {
        method: req.method,
        path: req.path,
        remoteAddress: req.ip ?? null,
        reason: 'no bearer token',
      });
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    if (!timingSafeEqual(digest(presented), expectedDigest)) {
      logger.warn('Admin request rejected', {
        method: req.method,
        path: req.path,
        remoteAddress: req.ip ?? null,
        // "wrong token" and "no token" are told apart in the LOG, where the
        // operator debugging their own paste can see it, and not in the
        // response, where a guesser could.
        reason: 'token mismatch',
      });
      next(unauthorized(REJECTION_MESSAGE));
      return;
    }

    next();
  };
}
