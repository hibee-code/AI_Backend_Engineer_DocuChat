import crypto from 'crypto';
import path from 'path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../lib/config';
import { cacheGetMany, cacheSetMany, CACHE_TTL } from '../lib/cache';
import { logger } from '../lib/logger';
import { cacheOperations } from '../lib/metrics';
import { prisma } from '../lib/prisma';

/**
 * Embedding service: turns text into vectors with a local model (no API key,
 * no per-token cost, no network after the first download) and stores them in
 * Chunk.embedding (pgvector).
 *
 * Documents and questions must be embedded by the same model. mxbai expects
 * questions to carry QUERY_PREFIX, so callers say which kind of text it is.
 */

const MODEL_ID = config.EMBEDDING_MODEL_ID;
// 8-bit quantized weights: ~4x smaller download and faster on CPU than fp32,
// with near-identical retrieval quality. Part of the cache key, since
// different weights produce different vectors.
const MODEL_DTYPE = 'q8';
const EMBEDDING_DIMENSIONS = 1024; // Must match the vector(1024) column

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const BATCH_SIZE = 16; // Keeps memory usage reasonable on CPU
const STORE_BATCH_SIZE = 500; // Rows updated per SQL statement

// Keep downloaded model files in the project (gitignored), not inside
// node_modules where every reinstall would delete them
env.cacheDir = path.resolve('.cache/models');

export type EmbeddingInputType = 'document' | 'query';

// ── Generate (cached) ───────────────────────────────────────────
// The same text always produces the same vector, so cached vectors are reused
// across retries, re-uploads, duplicate chunks and repeated questions.

export async function generateEmbeddingsBatchCached(
  texts: string[],
  inputType: EmbeddingInputType = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const prefix = inputType === 'query' ? QUERY_PREFIX : '';
  const inputs = texts.map((text) => prefix + text);

  // 1. Check the cache for every input in one round trip
  const keys = inputs.map(embeddingCacheKey);
  const results = await cacheGetMany<number[]>(keys);
  const missIndexes = results.flatMap((r, i) => (r ? [] : [i]));

  cacheOperations.inc({ operation: 'get', result: 'hit' }, texts.length - missIndexes.length);
  cacheOperations.inc({ operation: 'get', result: 'miss' }, missIndexes.length);

  // 2. Embed only the uncached inputs, then fill in and cache them
  if (missIndexes.length > 0) {
    const fresh = await embedTexts(missIndexes.map((i) => inputs[i]!));
    missIndexes.forEach((inputIndex, j) => {
      results[inputIndex] = fresh[j]!;
    });
    await cacheSetMany(
      missIndexes.map((inputIndex, j) => ({ key: keys[inputIndex]!, value: fresh[j] })),
      CACHE_TTL.EMBEDDING,
    );
    cacheOperations.inc({ operation: 'set', result: 'ok' }, missIndexes.length);
  }

  return results as number[][];
}

// ── Store ───────────────────────────────────────────────────────
// Prisma can't write the pgvector type, so this uses raw SQL: one UPDATE per
// batch, joined against (id, vector) pairs passed in as two parallel arrays.

export async function storeChunkEmbeddingsBatch(
  chunks: { id: string; embedding: number[] }[],
): Promise<void> {
  for (let i = 0; i < chunks.length; i += STORE_BATCH_SIZE) {
    const batch = chunks.slice(i, i + STORE_BATCH_SIZE);
    const ids = batch.map((chunk) => chunk.id);
    const vectors = batch.map((chunk) => toVectorLiteral(chunk.embedding));

    await prisma.$executeRaw`
      UPDATE "Chunk" AS c
      SET "embedding" = v.embedding::vector
      FROM unnest(${ids}::text[], ${vectors}::text[]) AS v(id, embedding)
      WHERE c."id" = v.id
    `;
  }
}

// pgvector's text format: "[0.1,0.2,...]". Cast it in SQL with ::vector.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// ── Internals ───────────────────────────────────────────────────

// The model loads once per process (the first call downloads it). The promise
// is cached, not the result, so concurrent first calls share one load; a
// failed load is cleared so the next call can retry.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    logger.info('Loading embedding model', { model: MODEL_ID, dtype: MODEL_DTYPE });
    extractorPromise = (
      pipeline('feature-extraction', MODEL_ID, {
        dtype: MODEL_DTYPE,
      }) as Promise<FeatureExtractionPipeline>
    ).catch((error: unknown) => {
      extractorPromise = null;
      throw error;
    });
  }
  return extractorPromise;
}

// The only function that runs the model
async function embedTexts(inputs: string[]): Promise<number[][]> {
  const model = await getExtractor();
  const startTime = Date.now();
  const embeddings: number[][] = [];

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    // mxbai uses CLS pooling; normalized vectors make cosine distance exact
    const output = await model(batch, { pooling: 'cls', normalize: true });
    embeddings.push(...(output.tolist() as number[][]));
  }

  // A wrong size would fail later inside Postgres with a vague error
  const wrongSize = embeddings.find((e) => e.length !== EMBEDDING_DIMENSIONS);
  if (wrongSize) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS}-dimension embeddings from ${MODEL_ID}, got ${wrongSize.length}`,
    );
  }

  logger.debug('Embeddings generated', {
    model: MODEL_ID,
    count: inputs.length,
    durationMs: Date.now() - startTime,
  });
  return embeddings;
}

// Model and dtype are part of the key, so switching either never returns stale vectors
function embeddingCacheKey(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return `emb:${MODEL_ID.split('/').pop()}-${MODEL_DTYPE}:${hash}`;
}
