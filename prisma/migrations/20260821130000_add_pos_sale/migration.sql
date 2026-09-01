-- Phase 4 P4-U2 (POS online sale): PosSale provenance — additive only;
-- no existing objects are modified.
-- A PosSale links an Order + Payment to the POS context that produced them
-- (device, session, store, cashier). It is an ADDITIVE association: the
-- Order/Payment state machines are untouched; all pricing, totals,
-- snapshots, and inventory behavior stay in the Core Commerce services.
-- UNIQUE(orderId) / UNIQUE(paymentId) enforce one PosSale per Order and
-- per Payment. Store-scoped inventory arrives in P4-U3 (D2); sales here
-- decrement the existing tenant-level single pool via the existing Order T1.

-- CreateTable
CREATE TABLE "PosSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_orderId_key" ON "PosSale"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_paymentId_key" ON "PosSale"("paymentId");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_idx" ON "PosSale"("tenantId");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_createdAt_id_idx" ON "PosSale"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PosSale_sessionId_idx" ON "PosSale"("sessionId");

-- CreateIndex
CREATE INDEX "PosSale_deviceId_idx" ON "PosSale"("deviceId");

-- CreateIndex
CREATE INDEX "PosSale_storeId_idx" ON "PosSale"("storeId");

-- CreateIndex
CREATE INDEX "PosSale_userId_idx" ON "PosSale"("userId");

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PosSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PosDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
