-- Phase 4 P4-U4 (POS offline operation model): PosOperation + lines —
-- additive only; no existing objects are modified. No Phase 3 table is
-- touched; no Order/Payment/Inventory/Cart behavior changes.
--
-- Purpose (approved D1-D8 + discovery §10): the durable, tenant-safe,
-- device-owned ledger of OFFLINE SALE INTENTS. This is the sync INBOX that
-- P4-U5 will process; U4 itself never executes anything.
--
-- Idempotency: UNIQUE(deviceId, clientUuid) — the DB is the final
-- idempotency authority; the client UUID is an idempotency key, NEVER a PK.
-- Ordering: UNIQUE(deviceId, seq) — the device assigns seq offline; the
-- DB prevents duplicate sequence allocation (P2002 -> deterministic 409);
-- sequences are scoped per device only.
-- Provenance: device/store/cashier are DERIVED from the referenced
-- PosSession (immutable after creation; retained even after the session
-- closes — U5 decides historical acceptability). tenantId is server-derived
-- via the tenant-scoping extension.
-- Status describes the SYNC operation only (never Order/Payment state):
-- PENDING at record; ACCEPTED/DUPLICATE/REJECTED are U5 outcomes;
-- resultCode is the typed deterministic reason (PRICE_CHANGED,
-- OUT_OF_STOCK, authorization rejections) — no free-form error blobs.
-- Money: the intent snapshot lines store the DEVICE-OBSERVED unit price in
-- the established integer-minor-unit BIGINT form (exact, never floats, no
-- rounding). observedUnitAmountMinor exists ONLY for D3 PRICE_CHANGED
-- detection at sync; the server remains the price authority.

-- CreateEnum
CREATE TYPE "PosOperationType" AS ENUM ('SALE_INTENT');

-- CreateEnum
CREATE TYPE "PosOperationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DUPLICATE', 'REJECTED');

-- CreateTable
CREATE TABLE "PosOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "PosOperationType" NOT NULL DEFAULT 'SALE_INTENT',
    "status" "PosOperationStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode" TEXT,
    "resultOrderId" TEXT,
    "resultPaymentId" TEXT,
    "customerId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PosOperation_seq_check" CHECK ("seq" > 0)
);

-- CreateTable
CREATE TABLE "PosOperationItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "observedUnitAmountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosOperationItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PosOperationItem_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "PosOperationItem_observed_price_check" CHECK ("observedUnitAmountMinor" >= 0)
);

-- THE idempotency arbitration (approved fundamental rule).
CREATE UNIQUE INDEX "PosOperation_deviceId_clientUuid_key" ON "PosOperation"("deviceId", "clientUuid");

-- Per-device sequence ordering (prevents duplicate seq allocation).
CREATE UNIQUE INDEX "PosOperation_deviceId_seq_key" ON "PosOperation"("deviceId", "seq");

-- CreateIndex
CREATE INDEX "PosOperation_tenantId_idx" ON "PosOperation"("tenantId");

-- CreateIndex
CREATE INDEX "PosOperation_tenantId_createdAt_id_idx" ON "PosOperation"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PosOperation_sessionId_idx" ON "PosOperation"("sessionId");

-- CreateIndex
CREATE INDEX "PosOperation_deviceId_status_idx" ON "PosOperation"("deviceId", "status");

-- CreateIndex
CREATE INDEX "PosOperation_userId_idx" ON "PosOperation"("userId");

-- CreateIndex
CREATE INDEX "PosOperationItem_tenantId_idx" ON "PosOperationItem"("tenantId");

-- CreateIndex
CREATE INDEX "PosOperationItem_operationId_idx" ON "PosOperationItem"("operationId");

-- CreateIndex
CREATE INDEX "PosOperationItem_variantId_idx" ON "PosOperationItem"("variantId");

-- AddForeignKey
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PosDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PosSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Result links are SetNull: history ledger rows must survive the (already
-- delete-protected) Order/Payment disappearing; the ledger is append-only.
ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_resultOrderId_fkey" FOREIGN KEY ("resultOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PosOperation" ADD CONSTRAINT "PosOperation_resultPaymentId_fkey" FOREIGN KEY ("resultPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperationItem" ADD CONSTRAINT "PosOperationItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperationItem" ADD CONSTRAINT "PosOperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "PosOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
