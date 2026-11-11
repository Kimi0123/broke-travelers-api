import type { NextFunction, Request, Response } from 'express';
import { generateId } from '../../infrastructure/db/ids.js';

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    const validIncoming =
      typeof incoming === 'string' && REQUEST_ID_REGEX.test(incoming);
    const requestId = validIncoming ? incoming : `req_${generateId()}`;

    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  };
}
