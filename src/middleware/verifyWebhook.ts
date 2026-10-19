import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Exact request bytes, set by the express.raw() verify hook on /webhooks
      rawBody?: Buffer;
    }
  }
}

// Checks an HMAC-SHA256 signature (hex) of the raw body. Must run after
// express.raw() has captured req.rawBody.
export function verifyWebhookSignature(secret: string | undefined, headerName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Fail closed: an empty or missing key would let anyone forge signatures
    if (!secret) {
      return res.status(503).json({ error: 'Webhooks are not configured' });
    }

    const signature = req.headers[headerName.toLowerCase()];
    if (typeof signature !== 'string' || !signature) {
      return res.status(401).json({
        error: 'Missing signature header',
      });
    }

    // The body must be the RAW bytes, not parsed JSON
    const rawBody = req.rawBody;
    if (!rawBody) {
      return res.status(500).json({
        error: 'Raw body not captured. Configure express.raw().',
      });
    }

    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    const provided = Buffer.from(signature, 'hex');
    const expected = Buffer.from(expectedSignature, 'hex');

    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  };
}
