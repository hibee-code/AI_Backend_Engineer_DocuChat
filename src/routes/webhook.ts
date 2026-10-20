import { Router } from 'express';
import { z } from 'zod';
import { verifyWebhookSignature } from '../middleware/verifyWebhook';
import { config } from '../lib/config';
import { prisma } from '../lib/prisma';
import { logger, serializeError } from '../lib/logger';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used once 'document.imported' is implemented
import { documentQueue } from '../queues/document.queue';

const router = Router();

// Minimum shape every event needs (id for idempotency, type for routing)
const webhookEventSchema = z.looseObject({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
});
type WebhookEventBody = z.infer<typeof webhookEventSchema>;

// Mounted at /webhooks with express.raw() in app.ts, so the signature is
// checked against the exact bytes the provider signed.
router.post(
  '/example',
  // Signatures expire after 5 minutes (see verifyWebhook.ts)
  verifyWebhookSignature(config.WEBHOOK_SECRET, {
    signatureHeader: 'X-Webhook-Signature',
    timestampHeader: 'X-Webhook-Timestamp',
    toleranceSeconds: 5 * 60,
  }),
  async (req, res) => {
    // Body is still raw bytes here — parse it manually. The signature is
    // valid, but the payload can still be malformed: 400, not a 500.
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody!.toString('utf-8'));
    } catch {
      return res.status(400).json({ error: 'Body must be valid JSON' });
    }
    const validation = webhookEventSchema.safeParse(parsed);
    if (!validation.success) {
      return res.status(400).json({ error: 'Event must have string "id" and "type" fields' });
    }
    const event = validation.data;

    // Idempotency check
    const existing = await prisma.webhookEvent.findUnique({
      where: { id: event.id },
    });

    if (existing?.processedAt) {
      // Already processed. Acknowledge without re-processing.
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Record receipt (or update if half-processed)
    await prisma.webhookEvent.upsert({
      where: { id: event.id },
      update: {},
      create: {
        id: event.id,
        provider: 'example',
        eventType: event.type,
        payload: JSON.stringify(event),
      },
    });

    // ACKNOWLEDGE FAST. Process async.
    res.status(202).json({ received: true });

    // Queue the actual work
    try {
      await processWebhookEvent(event, req.correlationId);
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
    } catch (error) {
      logger.error('Webhook processing failed', {
        correlationId: req.correlationId,
        webhookEventId: event.id,
        eventType: event.type,
        error: serializeError(error),
      });
      // Don't mark processedAt. The provider will retry.
    }
  },
);

async function processWebhookEvent(event: WebhookEventBody, correlationId: string) {
  // Route to the right handler based on event type
  switch (event.type) {
    case 'document.imported':
      // Queue document processing
      break;
    default:
      logger.warn('Unhandled webhook event type', {
        correlationId,
        webhookEventId: event.id,
        eventType: event.type,
      });
  }
}

export default router;
