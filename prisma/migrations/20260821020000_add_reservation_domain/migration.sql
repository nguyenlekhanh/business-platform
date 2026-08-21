-- Reservation domain (Phase 2G).
--
-- TOOLING CAVEAT: this migration contains hand-written PostgreSQL DDL that the
-- Prisma schema DSL cannot express (btree_gist EXCLUDE constraint and a CHECK
-- constraint). This project follows deploy-only migration discipline
-- (`prisma migrate deploy`); NEVER run `prisma migrate dev`/`migrate diff`
-- against this schema, as generated SQL would try to drop these constraints.

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "notes" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reservation_tenantId_idx" ON "Reservation"("tenantId");

-- CreateIndex
CREATE INDEX "Reservation_equipmentId_startAt_idx" ON "Reservation"("equipmentId", "startAt");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT: business history must survive counterparty removal)
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT: an Asset/Equipment with reservations cannot be deleted)
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: half-open intervals [startAt, endAt) require a positive duration.
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_time_range_check" CHECK ("endAt" > "startAt");

-- Overlap protection (authoritative race-safe guarantee): two reservations for
-- the same equipment may not overlap in time while either holds the item.
-- Prisma stores DateTime as UTC wall time in TIMESTAMP(3); `AT TIME ZONE
-- 'UTC'` interprets those values as UTC deterministically regardless of the
-- session time zone. Ranges are half-open '[)' so back-to-back rentals are
-- legal. The predicate includes ACTIVE so the future pickup/return workflow
-- is covered without an index rebuild.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_no_overlap"
  EXCLUDE USING gist (
    "equipmentId" WITH =,
    tstzrange(
      "startAt" AT TIME ZONE 'UTC',
      "endAt" AT TIME ZONE 'UTC',
      '[)'
    ) WITH &&
  )
  WHERE ("status" IN ('RESERVED', 'ACTIVE'));
