-- Phase 4 P4-U5 (POS sync protocol, D8 pull feed): PosFeedEvent —
-- additive only; no existing objects are modified.
--
-- MINIMAL watermark + tombstone change feed for the POS pull protocol
-- (NOT event sourcing): a flat, per-tenant, monotonically versioned log
-- of catalog mutations (PRODUCT / PRODUCT_VARIANT / PRICE changes, plus
-- DELETED tombstones) that POS devices pull to refresh their offline
-- cache. The feed row IS the watermark bump: feedSeq is unique per
-- tenant, allocated by the server inside the mutation's transaction.
-- Tenant isolation is enforced by the tenant-scoping extension (the
-- table is registered in TENANT_SCOPED_MODELS).

-- CreateEnum
CREATE TYPE "PosFeedKind" AS ENUM ('PRODUCT', 'PRODUCT_VARIANT', 'PRICE', 'DELETED');

-- CreateTable
CREATE TABLE "PosFeedEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "feedSeq" INTEGER NOT NULL,
    "kind" "PosFeedKind" NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosFeedEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PosFeedEvent_feedSeq_check" CHECK ("feedSeq" > 0)
);

-- One watermark slot per tenant (the sequence authority).
CREATE UNIQUE INDEX "PosFeedEvent_tenantId_feedSeq_key" ON "PosFeedEvent"("tenantId", "feedSeq");

-- CreateIndex
CREATE INDEX "PosFeedEvent_tenantId_idx" ON "PosFeedEvent"("tenantId");

-- Pull scan: ordered rows above the device cursor within the tenant.
CREATE INDEX "PosFeedEvent_tenantId_feedSeq_idx" ON "PosFeedEvent"("tenantId", "feedSeq");

-- AddForeignKey
ALTER TABLE "PosFeedEvent" ADD CONSTRAINT "PosFeedEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
