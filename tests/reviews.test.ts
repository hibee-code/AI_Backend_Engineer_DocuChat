import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { generateAccessToken } from '../src/lib/token';
import { prisma } from '../src/lib/prisma';
import { listMessages } from '../src/services/conversation.service';
import { reviewQueueService } from '../src/services/review-queue.service';

// Items are URGENT with a createdAt in 2000, so claims here always get this
// file's own items before anything other (parallel) test files create.

let reviewerToken: string;
let memberToken: string;
let reviewerId: string;
let askerId: string;
let conversationId: string;
const userIds: string[] = [];

async function createUser(name: string) {
  const user = await prisma.user.create({
    data: { name, email: `${name}-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  userIds.push(user.id);
  return user;
}

async function createReview(answer = 'Maybe 14 days?') {
  const message = await prisma.message.create({
    data: { userId: askerId, conversationId, role: 'assistant', content: answer },
  });
  return prisma.reviewQueue.create({
    data: {
      messageId: message.id,
      question: 'Warranty?',
      generatedAnswer: answer,
      confidence: 0.1,
      sources: [],
      priority: 'URGENT',
      createdAt: new Date('2000-01-01'),
      slaDeadline: new Date(Date.now() + 60 * 60_000),
    },
  });
}

const asReviewer = (req: request.Test) => req.set('Authorization', `Bearer ${reviewerToken}`);

beforeAll(async () => {
  // Same permission and role as prisma/seed.ts (upsert: works on an unseeded DB too)
  const permission = await prisma.permission.upsert({
    where: { name: 'reviews:manage' },
    update: {},
    create: { name: 'reviews:manage', resource: 'reviews', action: 'manage' },
  });
  const role = await prisma.role.upsert({
    where: { name: 'reviewer' },
    update: {},
    create: { name: 'reviewer', description: 'Reviews low-confidence AI answers' },
  });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    update: {},
    create: { roleId: role.id, permissionId: permission.id },
  });

  const [reviewer, member, asker] = await Promise.all([
    createUser('rv-reviewer'),
    createUser('rv-member'),
    createUser('rv-asker'),
  ]);
  await prisma.userRole.create({ data: { userId: reviewer.id, roleId: role.id } });

  reviewerId = reviewer.id;
  askerId = asker.id;
  reviewerToken = generateAccessToken({ id: reviewer.id, role: 'user', tier: 'free' });
  memberToken = generateAccessToken({ id: member.id, role: 'user', tier: 'free' });
  conversationId = (await prisma.conversation.create({ data: { userId: askerId, title: 'RV' } }))
    .id;
});

afterAll(async () => {
  await prisma.usageLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('access', () => {
  it('needs a token and the reviews:manage permission', async () => {
    expect((await request(app).get('/api/v1/reviews')).status).toBe(401);
    const member = await request(app)
      .get('/api/v1/reviews')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(member.status).toBe(403);
    expect((await asReviewer(request(app).get('/api/v1/reviews'))).status).toBe(200);
  });
});

describe('claim and decide', () => {
  it('claims the next item, approves it with an edit, and the user sees the edit', async () => {
    const created = await createReview();

    const claim = await asReviewer(request(app).post('/api/v1/reviews/claim'));
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({
      id: created.id,
      status: 'IN_REVIEW',
      reviewedBy: reviewerId,
    });

    const decision = await asReviewer(
      request(app).post(`/api/v1/reviews/${created.id}/decision`).send({
        action: 'approve',
        editedAnswer: 'The warranty is 2 years.',
        reviewerNotes: 'Policy section 4',
      }),
    );
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({
      status: 'APPROVED',
      editedAnswer: 'The warranty is 2 years.',
    });

    const shown = (await listMessages(askerId, conversationId)).find(
      (m) => m.id === created.messageId,
    )!;
    expect(shown.content).toBe('The warranty is 2 years.');

    // A second decision on the same item
    const again = await asReviewer(
      request(app).post(`/api/v1/reviews/${created.id}/decision`).send({ action: 'reject' }),
    );
    expect(again.status).toBe(409);

    // And it shows up when listing approved items
    const list = await asReviewer(request(app).get('/api/v1/reviews?status=approved&limit=100'));
    expect(list.status).toBe(200);
    expect(list.body.every((r: { status: string }) => r.status === 'APPROVED')).toBe(true);
  });

  it('returns 204 when there is nothing to claim', async () => {
    vi.spyOn(reviewQueueService, 'claimNext').mockResolvedValueOnce(null);
    const res = await asReviewer(request(app).post('/api/v1/reviews/claim'));
    expect(res.status).toBe(204);
  });
});

describe('validation', () => {
  it('rejects bad input with 400', async () => {
    const created = await createReview();
    await asReviewer(request(app).post('/api/v1/reviews/claim'));

    const post = (id: string, body: object) =>
      asReviewer(request(app).post(`/api/v1/reviews/${id}/decision`).send(body));

    expect((await post(created.id, { action: 'maybe' })).status).toBe(400);
    expect((await post(created.id, { action: 'reject', editedAnswer: 'x' })).status).toBe(400);
    expect((await post('not-a-cuid!', { action: 'approve' })).status).toBe(400);
    expect((await asReviewer(request(app).get('/api/v1/reviews?status=DONE'))).status).toBe(400);

    // Clean decision after the failed attempts still works
    expect((await post(created.id, { action: 'reject' })).body.status).toBe('REJECTED');
  });
});
