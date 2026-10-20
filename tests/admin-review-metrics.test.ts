import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { generateAccessToken } from '../src/lib/token';

// authorize('admin') checks the role in the token, so no database user is needed
const token = (role: string) => generateAccessToken({ id: 'test-user', role, tier: 'free' });

const get = (query: string, role = 'admin') =>
  request(app)
    .get(`/api/v1/admin/reviews/metrics${query}`)
    .set('Authorization', `Bearer ${token(role)}`);

describe('GET /api/v1/admin/reviews/metrics', () => {
  it('returns metrics for the requested period (default 24h)', async () => {
    const res = await get('?period=7d');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      period: '7d',
      queue: expect.objectContaining({ total: expect.any(Number), pending: expect.any(Number) }),
      turnaround: { avgMinutes: expect.any(Number) },
      rates: expect.objectContaining({ slaCompliance: expect.any(Number) }),
    });

    expect((await get('')).body.period).toBe('24h');
  });

  it('rejects an invalid or out-of-range period with 400', async () => {
    expect((await get('?period=abc')).status).toBe(400);
    expect((await get('?period=999d')).status).toBe(400);
  });

  it('is admin-only', async () => {
    expect((await get('?period=7d', 'user')).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/reviews/metrics')).status).toBe(401);
  });
});
