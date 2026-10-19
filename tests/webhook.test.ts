import crypto from 'crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { config } from '../src/lib/config';
import { prisma } from '../src/lib/prisma';

// Signed exactly like a provider would: HMAC-SHA256 (hex) of the raw body
function sign(body: string): string {
  return crypto.createHmac('sha256', config.WEBHOOK_SECRET!).update(body).digest('hex');
}

function send(body: string, signature?: string) {
  const req = request(app).post('/webhooks/example').set('Content-Type', 'application/json');
  if (signature) req.set('X-Webhook-Signature', signature);
  return req.send(body);
}

const eventId = `test-evt-${crypto.randomUUID()}`;

describe.skipIf(!config.WEBHOOK_SECRET)('POST /webhooks/example', () => {
  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: eventId } });
  });

  it('accepts a correctly signed event (202), then flags the redelivery as duplicate', async () => {
    const body = JSON.stringify({ id: eventId, type: 'test.ping' });

    const first = await send(body, sign(body));
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ received: true });

    // processedAt is written after the 202, so wait for it before redelivering
    await expect
      .poll(async () => (await prisma.webhookEvent.findUnique({ where: { id: eventId } }))?.processedAt)
      .toBeTruthy();

    const again = await send(body, sign(body));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
  });

  it('rejects a body that was changed after signing', async () => {
    const signed = JSON.stringify({ id: eventId, type: 'test.ping' });
    const tampered = JSON.stringify({ id: eventId, type: 'test.pwned' });
    const res = await send(tampered, sign(signed));
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature', async () => {
    const res = await send(JSON.stringify({ id: eventId, type: 'test.ping' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for signed but invalid JSON', async () => {
    const body = '{not json';
    const res = await send(body, sign(body));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a signed event without an id', async () => {
    const body = JSON.stringify({ type: 'test.ping' });
    const res = await send(body, sign(body));
    expect(res.status).toBe(400);
  });
});
