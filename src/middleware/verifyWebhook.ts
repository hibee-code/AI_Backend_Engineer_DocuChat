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

export interface WebhookSignatureOptions {
  signatureHeader: string; // Hex HMAC-SHA256 of `${timestamp}.${rawBody}`
  timestampHeader: string; // Unix time in seconds when the sender signed it
  toleranceSeconds?: number; // Max age (and max clock skew into the future)
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

// Checks a timestamped HMAC-SHA256 signature over the raw body, the scheme
// Stripe and Slack use. The timestamp is part of what's signed, so it can't
// be swapped for a fresh one: a captured request stops verifying after
// toleranceSeconds, which limits replays to that window (and duplicate event
// IDs inside the window are caught by the route's idempotency check).
// Must run after express.raw() has captured req.rawBody.
//
// Sender side:
//   timestamp = Math.floor(Date.now() / 1000)
//   signature = hex(HMAC_SHA256(secret, `${timestamp}.${body}`))
export function verifyWebhookSignature(
  secret: string | undefined,
  {
    signatureHeader,
    timestampHeader,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  }: WebhookSignatureOptions,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Fail closed: an empty or missing key would let anyone forge signatures
    if (!secret) {
      return res.status(503).json({ error: 'Webhooks are not configured' });
    }

    const signature = req.headers[signatureHeader.toLowerCase()];
    if (typeof signature !== 'string' || !signature) {
      return res.status(401).json({ error: 'Missing signature header' });
    }

    const timestamp = req.headers[timestampHeader.toLowerCase()];
    if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) {
      return res.status(401).json({ error: 'Missing or invalid timestamp header' });
    }

    // Too old = possible replay; too far ahead = sender clock is wrong (or a
    // timestamp chosen to stay valid for longer)
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (Math.abs(ageSeconds) > toleranceSeconds) {
      return res.status(401).json({ error: 'Signature expired' });
    }

    // The body must be the RAW bytes, not parsed JSON
    const rawBody = req.rawBody;
    if (!rawBody) {
      return res.status(500).json({
        error: 'Raw body not captured. Configure express.raw().',
      });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    const provided = Buffer.from(signature, 'hex');
    const expected = Buffer.from(expectedSignature, 'hex');

    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  };
}
