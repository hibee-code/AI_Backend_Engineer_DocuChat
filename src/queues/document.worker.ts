// src/queues/document.worker.ts
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redisConnection } from './connection';
import { prisma } from '../lib/prisma';
import { logger, serializeError } from '../lib/logger';
import { appEvents } from '../lib/events';
import { extractText, detectFormat, type SupportedFormat } from '../lib/documentExtractor';
import { chunkDocument } from '../lib/chunker';
import {
  generateEmbeddingsBatchCached,
  storeChunkEmbeddingsBatch,
} from '../services/embedding.service';
import { deadLetterQueue } from './dead-letter.queue';

const DEFAULT_ATTEMPTS = 3;

const worker = new Worker(
  'document-processing',
  async (job: Job) => {
    const { documentId, userId, correlationId } = job.data;
    const startTime = Date.now();

    logger.info('Document processing started', {
      correlationId,
      documentId,
      userId,
      attempt: job.attemptsMade + 1,
    });

    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'processing' },
    });

    try {
      // Step 1: Fetch document
      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: documentId },
      });
      await job.updateProgress(5);

      // Step 2: Extract text
      const format = resolveFormat(doc.filename);
      const { text, pageCount } = await extractText(doc.content, format);
      await job.updateProgress(15);

      logger.info('Text extracted', {
        correlationId,
        documentId,
        format,
        textLength: text.length,
        pageCount,
      });

      // Step 3: Chunk the text
      const chunks = chunkDocument(text, {
        maxTokens: 500,
        overlapTokens: 50,
        minChunkTokens: 50,
      });

      // Empty or image-only files (e.g. scanned PDFs) have no text. Retrying
      // can't change the content, so skip BullMQ's remaining attempts.
      if (chunks.length === 0) {
        throw new UnrecoverableError('No readable text found in document');
      }
      await job.updateProgress(30);

      logger.info('Document chunked', {
        correlationId,
        documentId,
        chunkCount: chunks.length,
        avgTokens: Math.round(
          chunks.reduce((sum, c) => sum + c.tokenEstimate, 0) / chunks.length,
        ),
      });

      // Step 4: Store chunks in database (replacing any from an earlier attempt)
      const storedChunks = await prisma.$transaction(async (tx) => {
        await tx.chunk.deleteMany({ where: { documentId } });
        return tx.chunk.createManyAndReturn({
          data: chunks.map((chunk) => ({
            documentId,
            index: chunk.index,
            content: chunk.text,
            tokenCount: chunk.tokenEstimate,
          })),
          select: { id: true, index: true },
        });
      });
      await job.updateProgress(50);

      // Step 5: Generate embeddings (the expensive step).
      // embeddings[i] belongs to chunks[i], and chunks[i].index === i.
      const embeddings = await generateEmbeddingsBatchCached(chunks.map((c) => c.text));
      await job.updateProgress(85);

      // Step 6: Store embeddings, matched to each row by its chunk index
      await storeChunkEmbeddingsBatch(
        storedChunks.map((c) => ({ id: c.id, embedding: embeddings[c.index]! })),
      );
      await job.updateProgress(95);

      // Step 7: Mark complete
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
        },
      });
      await job.updateProgress(100);

      const duration = Date.now() - startTime;

      // Emit completion event with metrics
      appEvents.emit('doc:processed', {
        documentId,
        userId,
        correlationId,
        chunkCount: chunks.length,
        durationMs: duration,
        format,
        pageCount,
      });

      logger.info('Document processing complete', {
        correlationId,
        documentId,
        chunkCount: chunks.length,
        durationMs: duration,
      });

      return {
        success: true,
        chunks: chunks.length,
        durationMs: duration,
      };
    } catch (error) {
      // attemptsMade counts finished attempts, so this one is attemptsMade + 1
      if (isFinalAttempt(job, error, job.attemptsMade + 1)) {
        await prisma.document.update({
          where: { id: documentId },
          data: {
            status: 'failed',
            error: (error as Error).message,
          },
        });
      }

      logger.error('Document processing failed', {
        correlationId,
        documentId,
        error: (error as Error).message,
        attempt: job.attemptsMade + 1,
      });

      throw error; // Re-throw so BullMQ retries (unless unrecoverable)
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

// Uploads are JSON text today, so filename is a slugged title with no
// extension. Only trust detectFormat when there is an extension to detect.
function resolveFormat(filename: string | null): SupportedFormat {
  return filename?.includes('.') ? detectFormat(filename) : 'text';
}

// No more retries will run: either the error says retrying is pointless,
// or this was the last attempt allowed.
function isFinalAttempt(job: Job, error: unknown, attemptNumber: number): boolean {
  return (
    error instanceof UnrecoverableError ||
    attemptNumber >= (job.opts.attempts ?? DEFAULT_ATTEMPTS)
  );
}

worker.on('failed', async (job, error) => {
  // By the time 'failed' fires, attemptsMade already includes this attempt
  if (!job || !isFinalAttempt(job, error, job.attemptsMade)) return;

  logger.error('Document processing permanently failed, moving to DLQ', {
    correlationId: job.data.correlationId,
    jobId: job.id,
    documentId: job.data.documentId,
    attempts: job.attemptsMade,
    error: serializeError(error),
  });

  await deadLetterQueue.add('failed-document', {
    originalJobId: job.id,
    originalQueue: 'document-processing',
    data: job.data,
    error: error.message,
    failedAt: new Date().toISOString(),
    attempts: job.attemptsMade,
  });
});

worker.on('error', (error) => {
  logger.error('Document worker error', { error: serializeError(error) });
});

export { worker };
