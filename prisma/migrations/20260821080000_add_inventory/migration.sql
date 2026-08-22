-- Phase 3 U4 (commerce): Inventory - single stock pool per variant.
-- Additive only; no existing objects are modified.
-- - Inventory: one row per variant (variantId @unique), lazy-created on first
--   adjustment (missing row == 0). Guarded conditional writes prevent negative
--   stock / oversell; DB CHECK is defense in depth. Variant FK CASCADE.

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Inventory_quantityOnHand_check" CHECK ("quantityOnHand" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_variantId_key" ON "Inventory"("variantId");

-- CreateIndex
CREATE INDEX "Inventory_tenantId_idx" ON "Inventory"("tenantId");

-- CreateIndex
CREATE INDEX "Inventory_tenantId_createdAt_id_idx" ON "Inventory"("tenantId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;