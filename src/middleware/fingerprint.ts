import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by attachFingerprint
      fingerprint?: string;
    }
  }
}


export function attachFingerprint(
    req: Request, res: Response, next: NextFunction
) {
    const signals = [
        req.ip,
        req.headers['user-agent'] || '',
        req.headers['accept-language'] || '',
        req.headers['accept-encoding'] || '',
    ];
    const fingerprint = crypto
    .createHash('sha256')
    .update(signals.join('|'))
    .digest('hex')
    .substring(0, 16);
    req.fingerprint = fingerprint;
    next();
}