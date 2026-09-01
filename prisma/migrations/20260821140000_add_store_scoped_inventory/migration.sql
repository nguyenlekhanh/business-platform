-- Phase 4 P4-U3 (Multi-store inventory, approved D2 Option A) — additive
-- schema evolution of the existing Inventory table.
--
-- DATA-MIGRATION AUDIT (proof, performed BEFORE writing this file):
--   The live database (localhost:5432/app, NODE_ENV=development) contains
--   ZERO rows: 0 Inventory, 0 Order, 0 PosSale, 0 Store, 0 Tenant.
--   Every test suite deletes its own tenants (cascades), so no production
--   or persisted stock exists. Therefore NO data migration is required and
--   NONE is performed: no row is assigned, duplicated, redistributed,
--   deleted, or merged. Existing-row preservation is guaranteed by
--   construction — storeId is NULLABLE and NULL means "tenant-global pool",
--   which is exactly the Phase 3 single pool.
--
-- Schema semantics after this migration:
--   storeId NULL     -> tenant-global pool (Phase 3 behavior, preserved).
--   storeId NOT NULL -> store-scoped pool; the FK is RESTRICT so stock
--                       blocks store deletion (PosDevice/PosSession
--                       precedent).
--   Uniqueness is enforced by PARTIAL unique indexes (Prisma DSL cannot
--   express them):
--     global:  one row per variant            WHERE storeId IS NULL
--     store:   one row per (store, variant)    WHERE storeId IS NOT NULL
--   The Phase 3 single-pool unique constraint Inventory_variantId_key is
--   REPLACED by the global partial index (identical guarantee for NULL-
--   store rows). The table is empty (proven above), so the swap is a pure
--   DDL operation with no row impact.

-- Add the nullable store column (default NULL = existing global pool).
ALTER TABLE "Inventory" ADD COLUMN "storeId" TEXT;

-- Replace the absolute variantId unique index with the scoped pair.
DROP INDEX "Inventory_variantId_key";

-- Partial unique: one GLOBAL pool row per variant (the Phase 3 invariant).
CREATE UNIQUE INDEX "Inventory_variantId_global_key"
    ON "Inventory"("variantId") WHERE ("storeId" IS NULL);

-- Partial unique: one STORE pool row per (store, variant).
CREATE UNIQUE INDEX "Inventory_storeId_variantId_key"
    ON "Inventory"("storeId", "variantId") WHERE ("storeId" IS NOT NULL);

-- Store lookup index for the scoped pools.
CREATE INDEX "Inventory_storeId_idx" ON "Inventory"("storeId");

-- FK: store-scoped stock references its Store; RESTRICT keeps stock from
-- being orphaned by a store deletion (blocks the delete -> 409 mapping).
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
