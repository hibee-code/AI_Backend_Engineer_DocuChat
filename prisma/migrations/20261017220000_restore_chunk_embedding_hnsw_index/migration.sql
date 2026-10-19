-- Restores the HNSW index that 20261014133142_add_prompt_templates dropped
-- (Prisma added the DROP INDEX because it can't see this index in schema.prisma).
--
-- Prisma can't express HNSW indexes in schema.prisma, so `prisma migrate dev`
-- will try to DROP this index in every new migration it generates. Create
-- migrations with --create-only and delete that DROP INDEX line before applying.
--
-- m = 16: each node connects to 16 neighbors (higher = more accurate, more memory)
-- ef_construction = 64: search quality during build (higher = better index, slower build)
CREATE INDEX IF NOT EXISTS "Chunk_embedding_idx" ON "Chunk"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
