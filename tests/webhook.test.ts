import crypto from 'crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { config } from '../src/lib/config';
import { prisma } from '../src/lib/prisma';

const now = () => Math.floor(Date.now() / 1000);

// Signed exactly like a provider would: hex HMAC-SHA256 of `${timestamp}.${body}`
function sign(body: string, timestamp: number): string {
  return crypto
    .createHmac('sha256', config.WEBHOOK_SECRET!)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function send(body: string, headers: { signature?: string; timestamp?: number | string } = {}) {
  const req = request(app).post('/webhooks/example').set('Content-Type', 'application/json');
  if (headers.signature) req.set('X-Webhook-Signature', headers.signature);
  if (headers.timestamp !== undefined) req.set('X-Webhook-Timestamp', String(headers.timestamp));
  return req.send(body);
}

// Signed with the current time: what a well-behaved sender does
function sendSigned(body: string) {
  const timestamp = now();
  return send(body, { signature: sign(body, timestamp), timestamp });
}

const eventId = `test-evt-${crypto.randomUUID()}`;
const pingBody = JSON.stringify({ id: eventId, type: 'test.ping' });

describe.skipIf(!config.WEBHOOK_SECRET)('POST /webhooks/example', () => {
  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { id: eventId } });
  });

  it('accepts a correctly signed event (202), then flags the redelivery as duplicate', async () => {
    const first = await sendSigned(pingBody);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ received: true });

    // processedAt is written after the 202, so wait for it before redelivering
    await expect
      .poll(async () => (await prisma.webhookEvent.findUnique({ where: { id: eventId } }))?.processedAt)
      .toBeTruthy();

    const again = await sendSigned(pingBody);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
  });

  it('accepts a signature that is 4 minutes old (inside the 5-minute window)', async () => {
    const timestamp = now() - 4 * 60;
    const res = await send(pingBody, { signature: sign(pingBody, timestamp), timestamp });
    expect(res.status).not.toBe(401);
  });

  it('rejects a signature older than 5 minutes (replay)', async () => {
    const timestamp = now() - 6 * 60;
    const res = await send(pingBody, { signature: sign(pingBody, timestamp), timestamp });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Signature expired');
  });

  it('rejects a timestamp more than 5 minutes in the future', async () => {
    const timestamp = now() + 6 * 60;
    const res = await send(pingBody, { signature: sign(pingBody, timestamp), timestamp });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Signature expired');
  });

  it('rejects an old request whose timestamp was swapped for a fresh one', async () => {
    // The timestamp is part of what's signed, so refreshing it breaks the signature
    const oldTimestamp = now() - 60 * 60;
    const res = await send(pingBody, { signature: sign(pingBody, oldTimestamp), timestamp: now() });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('rejects a missing or malformed timestamp', async () => {
    const signature = sign(pingBody, now());
    expect((await send(pingBody, { signature })).status).toBe(401);
    expect((await send(pingBody, { signature, timestamp: 'yesterday' })).status).toBe(401);
  });

  it('rejects a body that was changed after signing', async () => {
    const timestamp = now();
    const tampered = JSON.stringify({ id: eventId, type: 'test.pwned' });
    const res = await send(tampered, { signature: sign(pingBody, timestamp), timestamp });
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature', async () => {
    const res = await send(pingBody, { timestamp: now() });
    expect(res.status).toBe(401);
  });

  it('returns 400 for signed but invalid JSON', async () => {
    const res = await sendSigned('{not json');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a signed event without an id', async () => {
    const res = await sendSigned(JSON.stringify({ type: 'test.ping' }));
    expect(res.status).toBe(400);
  });
});
