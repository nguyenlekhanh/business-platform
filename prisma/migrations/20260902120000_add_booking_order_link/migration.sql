-- Phase 5 P5-U5 (booking): Booking — optional Order link
-- Additive only; no existing objects are modified.
-- Booking = Service + time interval (Architecture A: Service-Catalog Booking).
-- Order link is optional provenance (like PosSale), 1:1 relationship.
-- btree_gist extension already installed by 20260821020000.

-- AddColumn
ALTER TABLE "Booking" ADD COLUMN "orderId" TEXT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_orderId_key" ON "Booking"("orderId") WHERE "orderId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Booking_tenantId_orderId_idx" ON "Booking"("tenantId", "orderId");

-- AddForeignKey (RESTRICT: Order with booking link cannot be deleted)
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;