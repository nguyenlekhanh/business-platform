-- Phase 5 P5-U1 (booking): Service — tenant-scoped bookable-service
-- catalog definition ONLY (approved B2). Additive only; no existing
-- objects are modified. No pricing (B23 deferred to a later unit), no
-- duration (B5 deferred), no staff/resource/slot/availability fields
-- (B1 non-preclusion: nothing constrains what a future Booking books).
-- Unique (tenantId, name) keeps names unique WITHIN a tenant without
-- leaking cross-tenant existence. Status follows the established
-- ProductStatus catalog convention (soft-retirement via ARCHIVED).

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ServiceStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_tenantId_name_key" ON "Service"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Service_tenantId_idx" ON "Service"("tenantId");

-- CreateIndex
CREATE INDEX "Service_tenantId_createdAt_id_idx" ON "Service"("tenantId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
