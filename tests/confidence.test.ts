import { describe, expect, it } from 'vitest';
import { computeConfidence } from '../src/services/confidence.service';

const chunks = (...scores: number[]) =>
  scores.map((score, i) => ({ chunkId: `c${i}`, content: `chunk ${i}`, score }));

describe('computeConfidence', () => {
  it('escalates when nothing was retrieved', () => {
    expect(computeConfidence([], 0.6)).toEqual({
      score: 0,
      level: 'none',
      shouldEscalate: true,
      reason: 'No relevant chunks found in document',
    });
  });

  it('weights higher-ranked chunks more: (0.9*2 + 0.6*1) / 3 = 0.8', () => {
    const result = computeConfidence(chunks(0.9, 0.6), 0.6);
    expect(result).toMatchObject({ score: 0.8, level: 'medium', shouldEscalate: false });
  });

  it('ranks by score even if chunks arrive out of order', () => {
    expect(computeConfidence(chunks(0.6, 0.9), 0.6).score).toBe(0.8);
  });

  it('classifies high, low and none', () => {
    expect(computeConfidence(chunks(0.9, 0.88), 0.6).level).toBe('high');

    const low = computeConfidence(chunks(0.5, 0.4), 0.6);
    expect(low).toMatchObject({ level: 'low', shouldEscalate: true });
    expect(low.reason).toBe('Retrieval confidence 47% below threshold 60%');

    expect(computeConfidence(chunks(0.2, 0.1), 0.6)).toMatchObject({
      level: 'none',
      shouldEscalate: true,
    });
  });

  it('never labels an escalated answer as high when the threshold is above 0.85', () => {
    const result = computeConfidence(chunks(0.87), 0.9);
    expect(result).toMatchObject({ level: 'low', shouldEscalate: true });
  });
});
