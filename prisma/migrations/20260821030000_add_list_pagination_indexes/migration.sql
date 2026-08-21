-- Phase 2J: composite indexes supporting keyset (cursor) pagination.
--
-- Every paginated list query runs:
--   WHERE "tenantId" = $1 [AND equality filters] [AND keyset tuple predicate]
--   ORDER BY "createdAt" <dir>, "id" <dir>
--   LIMIT limit + 1
-- (Reservation additionally supports ORDER BY "startAt", "id".)
--
-- The existing single-column @@index([tenantId]) indexes cannot serve the
-- ordered scan: each page would fetch every tenant row and sort it. These
-- composites let Postgres seek directly past the cursor tuple with no sort.
-- Existing indexes are intentionally kept.

-- CreateIndex
CREATE INDEX "Asset_tenantId_createdAt_id_idx" ON "Asset"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Equipment_tenantId_createdAt_id_idx" ON "Equipment"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Customer_tenantId_createdAt_id_idx" ON "Customer"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_createdAt_id_idx" ON "Reservation"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_startAt_id_idx" ON "Reservation"("tenantId", "startAt", "id");

-- CreateIndex
CREATE INDEX "Store_tenantId_createdAt_id_idx" ON "Store"("tenantId", "createdAt", "id");
