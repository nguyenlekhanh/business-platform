---

## U7 PAYMENT — CP1 SCHEMA + MIGRATION COMPLETE (2026-08-29)

STATUS: U7 CP1 = COMPLETE (implemented, verified, documented).
Scope delivered EXACTLY per approved U7 assessment CP1: PaymentStatus enum,
Payment model, relations, indexes, CHECK constraint, one additive migration.

MIGRATION (exactly one, additive, applied via prisma migrate deploy):
- 20260821110000_add_payment
  CREATE TYPE "PaymentStatus" AS ENUM ('PROCESSING','CAPTURED','FAILED');
  CREATE TABLE "Payment" (id TEXT PK cuid, "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL, status "PaymentStatus" NOT NULL DEFAULT 'PROCESSING',
  "method" TEXT NOT NULL, "amountMinor" BIGINT NOT NULL, "currency" CHAR(3) NOT NULL,
  "createdAt"/"updatedAt" TIMESTAMP(3), CHECK ("amountMinor" >= 0));
  Indexes: (tenantId), (tenantId,createdAt,id), (orderId);
  FK: tenantId->Tenant CASCADE, orderId->Order CASCADE.
  No existing objects modified. `migrate status` 14/14 up to date; `validate` valid.

FILES CHANGED (2):
- prisma/schema.prisma (PaymentStatus enum, Payment model + relations on Tenant/Order)
- prisma/migrations/20260821110000_add_payment/migration.sql (new, handwritten SQL)

VERIFICATION RESULTS (exact):
- npx prisma validate: valid.
- npx prisma migrate deploy: applied (14 migrations).
- npx prisma generate: v6.19.3.
- npx prisma migrate status: Database schema is up to date! (14 migrations).

DEVIATIONS FROM ASSESSMENT:
- CHECK constraint (amountMinor >= 0) only in handwritten migration SQL, not Prisma schema
  (Prisma does not support CHECK in schema DSL). Consistent with Inventory/OrderItem pattern.

NEXT CHECKPOINT: CP2 — Tenant Scoping + RBAC
Add 'Payment' to TENANT_SCOPED_MODELS; add PAYMENT_READ/CREATE/MANAGE permissions,
PAYMENTS category, definitions, admin/employee role defaults.

HARD STOP — U7 CP1 complete; do not start CP2 without explicit approval.