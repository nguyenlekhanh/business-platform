---

## U6 ORDER + ORDERITEM — COMPLETE (2026-08-29)

STATUS: U6 Order + OrderItem = COMPLETE (implemented, verified, documented).
Scope delivered EXACTLY per approved assessment §15 U6 line: schema + one additive
migration (Order + OrderItem), tenant scoping, RBAC order:* keys, direct-items
OR cart checkout, snapshots, T1/T3 transactions, state machine, concurrency/
rollback tests, gate. NO Payment/POS/Booking/rental work. HARD STOP: U7 NOT
started; awaiting explicit user approval.

MIGRATION (exactly one, additive, applied via prisma migrate deploy):
- 20260821100000_add_order
  CREATE TYPE "OrderStatus" AS ENUM ('PENDING','PAID','CANCELLED');
  CREATE TABLE "Order" (id TEXT PK cuid, "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "customerId" TEXT NULL, status "OrderStatus" NOT NULL
  DEFAULT 'PENDING', "currency" CHAR(3) NOT NULL, "subtotalMinor" BIGINT NOT NULL,
  "cancelledAt" TIMESTAMP(3), "createdAt"/"updatedAt" TIMESTAMP(3),
  CHECK ("subtotalMinor" >= 0));
  CREATE TABLE "OrderItem" (id TEXT PK cuid, "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL, "variantId" TEXT NOT NULL, "productName" TEXT NOT NULL,
  "variantName" TEXT, "sku" TEXT NOT NULL, "quantity" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL, "unitAmountMinor" BIGINT NOT NULL,
  "lineTotalMinor" BIGINT NOT NULL, "createdAt"/"updatedAt" TIMESTAMP(3),
  CHECK ("quantity" > 0), CHECK ("unitAmountMinor" >= 0),
  CHECK ("lineTotalMinor" >= 0), CHECK ("lineTotalMinor" = "quantity" * "unitAmountMinor"));
  UNIQUE indexes and FKs: Order.tenantId->Tenant CASCADE, Order.userId->User CASCADE,
  Order.customerId->Customer RESTRICT, OrderItem.orderId->Order CASCADE,
  OrderItem.variantId->ProductVariant RESTRICT, OrderItem.tenantId->Tenant CASCADE.
  Indexes for keyset pagination: (tenantId), (tenantId,createdAt,id), (tenantId,status),
  (customerId) on Order; (tenantId), (orderId), (variantId) on OrderItem.
  No existing objects modified. `migrate status` 13/13 up to date; `validate` valid.

FILES CHANGED (13):
- prisma/schema.prisma (Order/OrderItem models + relations on Tenant/User/Customer/ProductVariant)
- prisma/migrations/20260821100000_add_order/migration.sql (new, handwritten SQL with CHECK constraints)
- src/common/database/prisma/tenant-scoping.extension.ts ('Order','OrderItem' in TENANT_SCOPED_MODELS)
- src/rbac/permission-catalog.ts (ORDER_READ/CREATE/DELETE/MANAGE, category 'orders', admin+=manage, employee+=read+create)
- src/customer/customer.service.ts (additive P2003 branch for Order.customerId RESTRICT -> 409 'Customer has orders...')
- src/order/dto/order.dto.ts (CreateOrderDto: items optional for cart checkout, customerId optional; OrderListQueryDto with status filter)
- src/order/order.service.ts (createOrder: T1 transaction - validate variants ACTIVE + prices uniform currency + guarded stock decrement + create Order + top-level OrderItems + mark cart CONVERTED; getOrder; listOrders keyset pagination; cancelOrder: T3 - guarded PENDING->CANCELLED + restock increments per variant)
- src/order/order.controller.ts (POST /orders (order:create), GET /orders (order:read), GET /orders/:id (order:read), POST /orders/:id/cancel (order:delete) with @HttpCode(200); guard chain JWT->TenantResolutionGuard->PermissionsGuard)
- src/order/order.module.ts (new), src/app.module.ts (OrderModule import)
- Tests (new): src/order/dto/order.dto.spec.ts (6), src/order/order.service.spec.ts (12), src/order/order.integration.spec.ts (56)

VERIFICATION RESULTS (exact, full gate re-run):
- Unit suite (jest.unit.json): 42 suites passed, 592 tests passed
  (was 577 post-U5; +15 order dto/service specs).
- Integration suite (jest.integration.json): 19 suites passed, 524 tests passed
  (was 468 post-U5; +56 order integration exactly; every pre-existing suite unchanged and green).
- npm run format: prettier --write on src/order/** then --check passes.
- npm run lint: 2 problems total (2 errors) — BOTH pre-existing
  src/asset/asset.service.spec.ts:203/:221 (no-unsafe-assignment).
  Zero new lint issues introduced by U6.
- npm run build (nest build): success.
- npx prisma validate: valid.
- npx prisma migrate status: Database schema is up to date! (13 migrations).
- npx prisma generate: v6.19.3.

CONVENTIONS PRESERVED: fail-closed tenant scoping (extension + requireTenantId), server-derived tenant only, no raw SQL on tenant-owned data, no nested writes (OrderItems created top-level), no generic RolePermission writes, rental FROZEN, Product/Variant/Customer cascade/RESTRICT preserved. BigInt money serialized as strings. PATCH on new domains (no UPDATE on Order). Status never client-writable. Atomic guarded inventory decrement via InventoryService pattern reused inside T1/T3 transactions. Concurrency: parallel last-unit orders -> exactly one 201 (mirrors U4/Reservation). Transaction rollback: forced price/stock failure leaves stock untouched. Cart ownership: checkout marks OPEN->CONVERTED, subsequent checkout fails 400. Customer delete blocked by Order RESTRICT FK (additive P2003 branch, approved D1). Order status machine: PENDING->PAID|cancel->CANCELLED, PAID terminal, cancel PAID = 409. Snapshots: productName/variantName/sku/unitAmountMinor/currency frozen at creation; later Price/Variant edits don't affect history.

KNOWN LIMITATIONS:
- Order list has no userId filter (tenant-scoped reads per assessment; ownership isolation is Cart-only).
- Payment capture/fail endpoints not yet implemented (U7).
- No refund/fulfillment flows (deferred to later phases).
- Currency mix rejected at checkout (409); multi-currency carts allowed but not convertible.
- customerId optional on Order; if provided, same-tenant validated (404 if foreign).

NEXT STEP: U7 Payment — PROPOSED ONLY, awaiting explicit user approval before any code.
Will implement Payment model + T2/T5 transactions, full-amount invariant, idempotent
terminal states, Payment-Order state machine coupling. Will NOT implement POS/Booking.

HARD STOP — U6 complete; do not start U7.