-- (Removed Prisma's DROP INDEX "Chunk_embedding_idx": see the note in schema.prisma)

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptTemplate_taskType_isActive_idx" ON "PromptTemplate"("taskType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_taskType_version_key" ON "PromptTemplate"("taskType", "version");
