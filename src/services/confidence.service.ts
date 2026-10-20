import { config } from '../config';

// Only the fields the score needs, so SearchResult[] from semanticSearch can
// be passed in directly
export interface ChunkResult {
  chunkId: string;
  content: string;
  score: number; // cosine similarity from pgvector (0 to 1)
}

export interface ConfidenceResult {
  score: number; // 0 to 1
  level: 'high' | 'medium' | 'low' | 'none';
  shouldEscalate: boolean;
  reason?: string;
}

const HIGH_CONFIDENCE = 0.85;
const MIN_RELEVANCE = 0.3; // Below this, chunks are treated as unrelated

// How well the retrieved chunks support an answer, from their similarity
// scores. Below the threshold the answer should go to a human (HITL).
export function computeConfidence(
  chunks: ChunkResult[],
  threshold: number = config.hitl.confidenceThreshold,
): ConfidenceResult {
  // No chunks retrieved at all — the document probably
  // does not contain information relevant to this question
  if (chunks.length === 0) {
    return {
      score: 0,
      level: 'none',
      shouldEscalate: true,
      reason: 'No relevant chunks found in document',
    };
  }

  // Weighted average by rank: with 5 chunks, rank 1 gets weight 5, rank 2
  // gets 4, etc. Sorted here so the weights follow the scores even if the
  // caller's chunks aren't in rank order.
  const ranked = [...chunks].sort((a, b) => b.score - a.score);
  const weights = ranked.map((_, i) => ranked.length - i);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedScore =
    ranked.reduce((sum, chunk, i) => sum + chunk.score * weights[i]!, 0) / totalWeight;

  // Classify the confidence level. 'high' never starts below the threshold,
  // so a 'high' answer is never also escalated.
  const highCutoff = Math.max(HIGH_CONFIDENCE, threshold);
  let level: ConfidenceResult['level'];
  let reason: string | undefined;
  if (weightedScore >= highCutoff) {
    level = 'high';
  } else if (weightedScore >= threshold) {
    level = 'medium';
  } else if (weightedScore >= MIN_RELEVANCE) {
    level = 'low';
    reason =
      `Retrieval confidence ${(weightedScore * 100).toFixed(0)}% ` +
      `below threshold ${(threshold * 100).toFixed(0)}%`;
  } else {
    level = 'none';
    reason = 'Retrieved chunks are not relevant to the question';
  }

  return {
    score: Math.round(weightedScore * 100) / 100,
    level,
    shouldEscalate: weightedScore < threshold,
    reason,
  };
}
