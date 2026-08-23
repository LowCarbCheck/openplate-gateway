/**
 * Express 4 does not catch a rejected promise from a route handler.
 *
 * It does not log it, does not answer, and does not time out: the request hangs
 * until the client gives up, and the only trace is an unhandled rejection
 * warning on stderr that nobody is watching. Every async handler in this service
 * goes through here, so a store read failing becomes an ordinary 500 through the
 * error middleware — which is also the only path that scrubs before it logs.
 *
 * `void` plus try/catch rather than `.catch(next)` because calling a callback
 * from inside a promise callback is exactly the shape that swallows a second
 * throw: if `next` itself threw, the rejection would vanish into the chain.
 */
import type { Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void (async (): Promise<void> => {
      try {
        await handler(req, res);
      } catch (error) {
        next(error);
      }
    })();
  };
}
