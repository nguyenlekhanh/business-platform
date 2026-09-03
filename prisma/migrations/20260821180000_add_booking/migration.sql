-- Phase 5 P5-U4 (booking): Booking — tenant-scoped service booking
-- lifecycle foundation (Architecture A: Service-Catalog Booking).
-- Additive only; no existing objects are modified.
-- Booking = Service + time interval (no staff, no resource).
-- EXCLUDE constraint on (serviceId, tstzrange) mirrors the frozen
-- Reservation pattern (equipmentId -> serviceId). Half-open [startAt,endAt)
-- UTC intervals. Status follows reservation-style lifecycle with soft-cancel.
-- btree_gist extension already installed by 20260821020000.

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "customerId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'BOOKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_tenantId_idx" ON "Booking"("tenantId");

-- CreateIndex
CREATE INDEX "Booking_tenantId_createdAt_id_idx" ON "Booking"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Booking_tenantId_serviceId_startAt_id_idx" ON "Booking"("tenantId", "serviceId", "startAt", "id");

-- CreateIndex
CREATE INDEX "Booking_serviceId_idx" ON "Booking"("serviceId");

-- CreateIndex
CREATE INDEX "Booking_customerId_idx" ON "Booking"("customerId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT: service with bookings cannot be deleted)
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (RESTRICT: customer with bookings cannot be deleted; nullable for walk-ins)
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: half-open intervals [startAt, endAt) require a positive duration
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_time_range_check" CHECK ("endAt" > "startAt");

-- Overlap protection (authoritative race-safe guarantee): two bookings for
-- the same service may not overlap in time while either holds the slot.
-- Prisma stores DateTime as UTC wall time in TIMESTAMP(3); `AT TIME ZONE
-- 'UTC'` interprets those values as UTC deterministically regardless of the
-- session time zone. Ranges are half-open '[)' so back-to-back bookings are
-- legal. The predicate includes CONFIRMED and ACTIVE so the future
-- confirmation/check-in workflow is covered without an index rebuild.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "serviceId" WITH =,
    tstzrange(
      "startAt" AT TIME ZONE 'UTC',
      "endAt" AT TIME ZONE 'UTC',
      '[)'
    ) WITH &&
  )
  WHERE ("status" IN ('BOOKED', 'CONFIRMED', 'ACTIVE'));