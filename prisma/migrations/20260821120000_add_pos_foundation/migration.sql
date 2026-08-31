-- Phase 4 P4-U1 (POS foundation): PosDevice + PosSession — additive only;
-- no existing objects are modified.
-- PosDevice: registered POS terminal, permanently bound to one same-tenant
--   Store (A5). Server-issued credential stored ONLY as sha256 hex (D6/A2).
--   Lifecycle (A6): ACTIVE <-> SUSPENDED; ACTIVE|SUSPENDED -> RETIRED
--   (terminal). No hard delete; no transition out of RETIRED.
-- PosSession: cashier shift on a device (D9): OPEN -> CLOSED (A3, bare
--   lifecycle). One OPEN session per device enforced by a partial unique
--   index (stricter than the tolerated U5 cart race — a terminal is
--   single-cashier-at-a-time by nature).
-- Store delete is blocked while devices/sessions reference it (RESTRICT),
--   mapping to 409 in the application layer (Category/Product precedent).

-- CreateEnum
CREATE TYPE "PosDeviceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "PosSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "PosDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PosDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PosSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PosSession_time_range_check" CHECK ("closedAt" IS NULL OR "closedAt" >= "openedAt")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosDevice_tenantId_name_key" ON "PosDevice"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosDevice_credentialHash_key" ON "PosDevice"("credentialHash");

-- CreateIndex
CREATE INDEX "PosDevice_tenantId_idx" ON "PosDevice"("tenantId");

-- CreateIndex
CREATE INDEX "PosDevice_tenantId_createdAt_id_idx" ON "PosDevice"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PosDevice_storeId_idx" ON "PosDevice"("storeId");

-- CreateIndex
CREATE INDEX "PosSession_tenantId_idx" ON "PosSession"("tenantId");

-- CreateIndex
CREATE INDEX "PosSession_tenantId_createdAt_id_idx" ON "PosSession"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PosSession_deviceId_status_idx" ON "PosSession"("deviceId", "status");

-- CreateIndex
CREATE INDEX "PosSession_userId_idx" ON "PosSession"("userId");

-- One OPEN session per device (arbitrates the open race at the DB level).
CREATE UNIQUE INDEX "PosSession_one_open_per_device"
    ON "PosSession"("deviceId") WHERE ("status" = 'OPEN');

-- AddForeignKey
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSession" ADD CONSTRAINT "PosSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSession" ADD CONSTRAINT "PosSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PosDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSession" ADD CONSTRAINT "PosSession_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSession" ADD CONSTRAINT "PosSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
