/**
 * Seeds the platform permission catalog and per-tenant system roles.
 *
 * Usage: npm run seed:rbac
 *
 * Uses a raw PrismaClient (no tenant-scoping extension) because this script
 * operates on global Permission rows and on Role rows across ALL tenants, so
 * no TenantContext is required. The script is idempotent.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
} from '../src/rbac/permission-catalog';

const prisma = new PrismaClient();

async function seed(): Promise<void> {
  // 1. Platform permission catalog (global, keyed by `key`).
  for (const definition of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { key: definition.key },
      update: {
        name: definition.name,
        description: definition.description,
        category: definition.category,
      },
      create: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        category: definition.category,
      },
    });
  }
  const permissionByKey = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map(
      (p) => [p.key, p.id],
    ),
  );

  // 2. System roles for every tenant, with idempotent default grants.
  const tenants = await prisma.tenant.findMany({
    select: { id: true },
  });

  for (const tenant of tenants) {
    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const role = await prisma.role.upsert({
        where: { tenantId_key: { tenantId: tenant.id, key: definition.key } },
        update: {
          name: definition.name,
          description: definition.description,
        },
        create: {
          tenantId: tenant.id,
          key: definition.key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
        },
      });

      for (const permissionKey of definition.defaultPermissions) {
        const permissionId = permissionByKey.get(permissionKey);
        if (!permissionId) {
          throw new Error(
            `Permission catalog is missing key "${permissionKey}" referenced by system role "${definition.key}"`,
          );
        }
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: role.id, permissionId },
          },
          update: {},
          create: { roleId: role.id, permissionId },
        });
      }
    }
  }

  const permissionCount = permissionByKey.size;
  console.log(
    `Seeded ${permissionCount} permissions and system roles for ${tenants.length} tenant(s).`,
  );
}

seed()
  .catch((error) => {
    console.error('RBAC seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());