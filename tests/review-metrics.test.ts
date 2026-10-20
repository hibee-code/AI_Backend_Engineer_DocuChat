import { describe, expect, it } from 'vitest';
import { computeSinceDate } from '../src/services/review-metrics.service';

const now = new Date('2026-10-20T12:00:00Z');

describe('computeSinceDate', () => {
  it('parses hours and days', () => {
    expect(computeSinceDate('24h', now).toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(computeSinceDate('7d', now).toISOString()).toBe('2026-10-13T12:00:00.000Z');
  });

  it('rejects invalid or out-of-range periods with a 400', () => {
    for (const period of ['abc', '24', '-1d', '0h', '1w', '366d']) {
      expect(() => computeSinceDate(period, now)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });
});
