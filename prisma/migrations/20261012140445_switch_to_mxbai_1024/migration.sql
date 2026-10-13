-- Switch embeddings from OpenAI text-embedding-3-small (1536 dims) to the local
-- mixedbread-ai/mxbai-embed-large-v1 model (1024 dims).
-- Vectors from different models aren't comparable, so the old column is dropped
-- rather than converted. Documents must be re-processed to get new embeddings.

DROP INDEX IF EXISTS "Chunk_embedding_idx";

ALTER TABLE "Chunk" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "Chunk" ADD COLUMN "embedding" vector(1024);

-- HNSW index for cosine-similarity search (same settings as before)
-- m = 16: each node connects to 16 neighbors (higher = more accurate, more memory)
-- ef_construction = 64: search quality during build (higher = better index, slower build)
CREATE INDEX "Chunk_embedding_idx" ON "Chunk"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
