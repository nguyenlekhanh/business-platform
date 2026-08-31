import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantContextService } from '../../tenant-context/tenant-context.service';

/**
 * Models that are tenant-owned and MUST be scoped to the active tenant
 * context. User, Tenant and Permission are global and intentionally excluded.
 * RolePermission has no tenantId column and cannot be auto-scoped; it must be
 * reached only through a tenant-resolved Role (which IS scoped).
 */
const TENANT_SCOPED_MODELS = new Set<Prisma.ModelName>([
  'Membership',
  'Role',
  'Store',
  'Asset',
  'Equipment',
  'Customer',
  'Reservation',
  // Phase 3 (commerce): catalog/cart/order/payment domains are tenant-owned.
  'Category',
  'Product',
  'ProductVariant',
  'Price',
  'Inventory',
  'Cart',
  'CartItem',
  'Order',
  'OrderItem',
  'Payment',
  'PosDevice',
  'PosSession',
]);

interface MutableOperationArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Array<Record<string, unknown>>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

function scopeArgs(operation: string, args: unknown, tenantId: string): void {
  const scoped = args as MutableOperationArgs;
  switch (operation) {
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'findFirst':
    case 'findFirstOrThrow':
    case 'findMany':
    case 'count':
    case 'aggregate':
    case 'groupBy':
      scoped.where = { ...scoped.where, tenantId };
      break;
    case 'create':
      scoped.data = { ...scoped.data, tenantId };
      break;
    case 'createMany':
      if (Array.isArray(scoped.data)) {
        scoped.data = scoped.data.map((row) => ({ ...row, tenantId }));
      } else {
        scoped.data = { ...scoped.data, tenantId };
      }
      break;
    case 'update':
    case 'updateMany':
      scoped.where = { ...scoped.where, tenantId };
      scoped.data = { ...scoped.data, tenantId };
      break;
    case 'delete':
    case 'deleteMany':
      scoped.where = { ...scoped.where, tenantId };
      break;
    case 'upsert':
      scoped.where = { ...scoped.where, tenantId };
      scoped.create = { ...scoped.create, tenantId };
      scoped.update = { ...scoped.update, tenantId };
      break;
    default:
      break;
  }
}

/**
 * Mutates `client` so that every TOP-LEVEL operation on a tenant-scoped model
 * (membership/role/store) is forced to the tenant id from the active
 * TenantContext, or fails closed (throws) when no context exists. Interactive
 * transaction clients inherit the extension because $transaction is bound to
 * the extended client.
 *
 * ── SECURITY CONTRACTS ─────────────────────────────────────────────────────
 *
 * 1. Tenant-scoped models (Membership, Role, Store, Asset, Equipment, Customer,
 *    Reservation)
 *    These are tenant-owned. Every top-level read/write on them is scoped to
 *    the active TenantContext tenant id; a call without a TenantContext fails
 *    closed (InternalServerErrorException). Never silently falls back to an
 *    unscoped query.
 *
 * 2. RolePermission (internal RBAC relation)
 *    RolePermission has NO tenantId column and is intentionally NOT a
 *    tenant-scoped model. It is NOT automatically tenant-isolated by Prisma
 *    or by this extension: top-level RolePermission operations are unscoped
 *    pass-through. Application code MUST NOT expose generic CRUD for
 *    RolePermission and MUST reach it only through a tenant-resolved Role
 *    (e.g. role.findUnique({ where: { id }, include: { permissions } })). A
 *    future RBAC service must first resolve the Role through the tenant-scoped
 *    Role model. Regression-tested below.
 *
 * 3. Nested relation writes
 *    Nested relation writes to tenant-owned models are NOT a controlled
 *    scoping boundary and are explicitly forbidden:
 *    - When the nested operation runs outside the AsyncLocalStorage context,
 *      the extension fails closed — but the rejection surfaces as an UNHANDLED
 *      promise rejection (Prisma's nested-write pipeline does not propagate it
 *      to the parent promise), which can crash the process.
 *    - When it does run, it may succeed with the caller-supplied tenantId
 *      (unscoped). Both behaviors have been observed; it is non-deterministic.
 *    ARCHITECTURAL RULE: tenant-owned models MUST be created/updated/deleted
 *    through top-level tenant-scoped Prisma operations, never via nested
 *    relation writes on another model.
 *
 * 4. include/select relation traversal
 *    include/select traversal is NOT filtered. A query on a global model that
 *    includes tenant-scoped relations (e.g.
 *    user.findUnique({ include: { memberships: true } })) returns data from
 *    EVERY tenant. Contract: never traverse INTO tenant-scoped models from a
 *    global-model query; traverse FROM the tenant-scoped model (e.g. a Role
 *    resolved via the tenant-scoped path, then
 *    role.findUnique({ where: { id }, include: { permissions } })).
 *
 * 5. Raw SQL
 *    $queryRaw / $executeRaw / $transactionRaw bypass the extension entirely.
 *    HARD RULE: raw SQL MUST NOT be used for tenant-owned data unless the SQL
 *    explicitly applies the current TenantContext tenant id (obtained via
 *    tenantContext.requireTenantId() and bound as a parameter).
 *
 * 6. TenantContext.run() + PrismaPromise (AsyncLocalStorage)
 *    A PrismaPromise executes lazily at await time. If it is created inside
 *    tenantContext.run(tenantId, cb) but awaited OUTSIDE the callback, the
 *    AsyncLocalStorage context is lost and the operation fails closed.
 *    CONTRACT: tenant-scoped Prisma operations MUST be awaited inside the
 *    run() callback:
 *        await tenantContext.run(tenantId, async () => prisma.store.findMany());
 *    Regression tests cover both the safe pattern and the anti-pattern.
 *
 * KNOWN LIMITATIONS (not claimed to be automatically protected):
 * - Nested relation operations on a parent (e.g.
 *   `user.create({ data: { memberships: { create: ... } } })`) are NOT a
 *   controlled scoping boundary: they may fail closed via an unhandled
 *   promise rejection or succeed with the caller-supplied tenantId
 *   (non-deterministic). Always use the top-level scoped methods instead.
 * - Relation traversal via include/select is NOT filtered. Traverse from the
 *   tenant-scoped side, never include tenant-scoped models from a global-model
 *   query.
 * - Raw queries ($queryRaw / $executeRaw / $transactionRaw) bypass extensions.
 */
export function applyTenantScoping(
  client: PrismaClient,
  tenantContext: TenantContextService,
): void {
  const scopedClient = client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }
          const tenantId = tenantContext.requireTenantId();
          scopeArgs(operation, args, tenantId);
          return query(args);
        },
      },
    },
  });

  // The extended client is the real implementation. Copy its own enumerable
  // properties onto the base-typed instance so the full model typing is
  // preserved, but bind method references to the extended client so their
  // `this` (engine, transaction manager, extension pipeline) is the extended
  // client — otherwise interactive transaction clients would be created from
  // the unextended base internals and bypass the query extension.
  const source = scopedClient as unknown as Record<string, unknown>;
  const target = client as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key === 'constructor') {
      continue;
    }
    const value = source[key];
    target[key] =
      typeof value === 'function' ? value.bind(scopedClient) : value;
  }

  // $transaction is not always exposed as an own enumerable property, so the
  // loop above can miss it. Bind it explicitly so interactive transactions
  // are created from the extended client and their tx client inherits the
  // query extension.
  const transaction = source.$transaction;
  if (typeof transaction === 'function') {
    target.$transaction = transaction.bind(scopedClient);
  }
}
