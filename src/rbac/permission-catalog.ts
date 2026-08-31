/**
 * Platform-wide permission catalog and system role definitions.
 *
 * Permission keys use the `resource:action` format. The catalog is
 * platform-defined: tenants can assign permissions from this catalog to custom
 * roles but can never create new permissions. System roles are seeded per
 * tenant (see scripts/seed-rbac.ts) and are immutable at the application layer.
 */
export const PERMISSIONS = {
  STORE_READ: 'store:read',
  STORE_CREATE: 'store:create',
  STORE_UPDATE: 'store:update',
  STORE_DELETE: 'store:delete',
  STORE_MANAGE: 'store:manage',
  MEMBER_READ: 'member:read',
  MEMBER_MANAGE: 'member:manage',
  ASSET_READ: 'asset:read',
  ASSET_CREATE: 'asset:create',
  ASSET_UPDATE: 'asset:update',
  ASSET_DELETE: 'asset:delete',
  ASSET_MANAGE: 'asset:manage',
  EQUIPMENT_READ: 'equipment:read',
  EQUIPMENT_CREATE: 'equipment:create',
  EQUIPMENT_UPDATE: 'equipment:update',
  EQUIPMENT_DELETE: 'equipment:delete',
  EQUIPMENT_MANAGE: 'equipment:manage',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DELETE: 'customer:delete',
  CUSTOMER_MANAGE: 'customer:manage',
  RESERVATION_READ: 'reservation:read',
  RESERVATION_CREATE: 'reservation:create',
  RESERVATION_UPDATE: 'reservation:update',
  RESERVATION_DELETE: 'reservation:delete',
  RESERVATION_MANAGE: 'reservation:manage',
  CATEGORY_READ: 'category:read',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',
  CATEGORY_MANAGE: 'category:manage',
  PRODUCT_READ: 'product:read',
  PRODUCT_CREATE: 'product:create',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DELETE: 'product:delete',
  PRODUCT_MANAGE: 'product:manage',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_MANAGE: 'inventory:manage',
  CART_MANAGE: 'cart:manage',
  ORDER_READ: 'order:read',
  ORDER_CREATE: 'order:create',
  ORDER_DELETE: 'order:delete',
  ORDER_MANAGE: 'order:manage',
  PAYMENT_READ: 'payment:read',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_MANAGE: 'payment:manage',
  POS_READ: 'pos:read',
  POS_CREATE: 'pos:create',
  POS_MANAGE: 'pos:manage',
  ROLE_READ: 'role:read',
  ROLE_MANAGE: 'role:manage',
  SETTINGS_READ: 'settings:read',
  SETTINGS_MANAGE: 'settings:manage',
  REPORT_READ: 'report:read',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATEGORIES = {
  STORE: 'store',
  ASSETS: 'assets',
  EQUIPMENT: 'equipment',
  CUSTOMER: 'customer',
  RESERVATIONS: 'reservations',
  CATEGORIES: 'categories',
  PRODUCTS: 'products',
  INVENTORY: 'inventory',
  CART: 'cart',
  ORDERS: 'orders',
  PAYMENTS: 'payments',
  POS: 'pos',
  MEMBERS: 'members',
  RBAC: 'rbac',
  SETTINGS: 'settings',
  REPORTING: 'reporting',
} as const;

export interface PermissionDefinition {
  key: string;
  name: string;
  category: string;
  description?: string;
}

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  {
    key: PERMISSIONS.STORE_READ,
    name: 'Read stores',
    category: PERMISSION_CATEGORIES.STORE,
    description: 'View store records in the tenant',
  },
  {
    key: PERMISSIONS.STORE_CREATE,
    name: 'Create stores',
    category: PERMISSION_CATEGORIES.STORE,
    description: 'Create stores in the tenant',
  },
  {
    key: PERMISSIONS.STORE_UPDATE,
    name: 'Update stores',
    category: PERMISSION_CATEGORIES.STORE,
    description: 'Update stores in the tenant',
  },
  {
    key: PERMISSIONS.STORE_DELETE,
    name: 'Delete stores',
    category: PERMISSION_CATEGORIES.STORE,
    description: 'Delete stores in the tenant',
  },
  {
    key: PERMISSIONS.STORE_MANAGE,
    name: 'Manage stores',
    category: PERMISSION_CATEGORIES.STORE,
    description: 'Full store management in the tenant',
  },
  {
    key: PERMISSIONS.ASSET_READ,
    name: 'Read assets',
    category: PERMISSION_CATEGORIES.ASSETS,
    description: 'View asset records in the tenant',
  },
  {
    key: PERMISSIONS.ASSET_CREATE,
    name: 'Create assets',
    category: PERMISSION_CATEGORIES.ASSETS,
    description: 'Create assets in the tenant',
  },
  {
    key: PERMISSIONS.ASSET_UPDATE,
    name: 'Update assets',
    category: PERMISSION_CATEGORIES.ASSETS,
    description: 'Update assets in the tenant',
  },
  {
    key: PERMISSIONS.ASSET_DELETE,
    name: 'Delete assets',
    category: PERMISSION_CATEGORIES.ASSETS,
    description: 'Delete assets in the tenant',
  },
  {
    key: PERMISSIONS.ASSET_MANAGE,
    name: 'Manage assets',
    category: PERMISSION_CATEGORIES.ASSETS,
    description: 'Full asset management in the tenant',
  },
  {
    key: PERMISSIONS.EQUIPMENT_READ,
    name: 'Read equipment',
    category: PERMISSION_CATEGORIES.EQUIPMENT,
    description: 'View equipment records in the tenant',
  },
  {
    key: PERMISSIONS.EQUIPMENT_CREATE,
    name: 'Create equipment',
    category: PERMISSION_CATEGORIES.EQUIPMENT,
    description: 'Create equipment records in the tenant',
  },
  {
    key: PERMISSIONS.EQUIPMENT_UPDATE,
    name: 'Update equipment',
    category: PERMISSION_CATEGORIES.EQUIPMENT,
    description: 'Update equipment records in the tenant',
  },
  {
    key: PERMISSIONS.EQUIPMENT_DELETE,
    name: 'Delete equipment',
    category: PERMISSION_CATEGORIES.EQUIPMENT,
    description: 'Delete equipment records in the tenant',
  },
  {
    key: PERMISSIONS.EQUIPMENT_MANAGE,
    name: 'Manage equipment',
    category: PERMISSION_CATEGORIES.EQUIPMENT,
    description: 'Full equipment management in the tenant',
  },
  {
    key: PERMISSIONS.CUSTOMER_READ,
    name: 'Read customers',
    category: PERMISSION_CATEGORIES.CUSTOMER,
    description: 'View customer records in the tenant',
  },
  {
    key: PERMISSIONS.CUSTOMER_CREATE,
    name: 'Create customers',
    category: PERMISSION_CATEGORIES.CUSTOMER,
    description: 'Create customer records in the tenant',
  },
  {
    key: PERMISSIONS.CUSTOMER_UPDATE,
    name: 'Update customers',
    category: PERMISSION_CATEGORIES.CUSTOMER,
    description: 'Update customer records in the tenant',
  },
  {
    key: PERMISSIONS.CUSTOMER_DELETE,
    name: 'Delete customers',
    category: PERMISSION_CATEGORIES.CUSTOMER,
    description: 'Delete customer records in the tenant',
  },
  {
    key: PERMISSIONS.CUSTOMER_MANAGE,
    name: 'Manage customers',
    category: PERMISSION_CATEGORIES.CUSTOMER,
    description: 'Full customer management in the tenant',
  },
  {
    key: PERMISSIONS.RESERVATION_READ,
    name: 'Read reservations',
    category: PERMISSION_CATEGORIES.RESERVATIONS,
    description: 'View reservations in the tenant',
  },
  {
    key: PERMISSIONS.RESERVATION_CREATE,
    name: 'Create reservations',
    category: PERMISSION_CATEGORIES.RESERVATIONS,
    description: 'Create reservations in the tenant',
  },
  {
    key: PERMISSIONS.RESERVATION_UPDATE,
    name: 'Update reservations',
    category: PERMISSION_CATEGORIES.RESERVATIONS,
    description: 'Update reservations in the tenant',
  },
  {
    key: PERMISSIONS.RESERVATION_DELETE,
    name: 'Cancel reservations',
    category: PERMISSION_CATEGORIES.RESERVATIONS,
    description: 'Cancel (soft-delete) reservations in the tenant',
  },
  {
    key: PERMISSIONS.RESERVATION_MANAGE,
    name: 'Manage reservations',
    category: PERMISSION_CATEGORIES.RESERVATIONS,
    description: 'Full reservation management in the tenant',
  },
  {
    key: PERMISSIONS.CATEGORY_READ,
    name: 'Read categories',
    category: PERMISSION_CATEGORIES.CATEGORIES,
    description: 'View product categories in the tenant',
  },
  {
    key: PERMISSIONS.CATEGORY_CREATE,
    name: 'Create categories',
    category: PERMISSION_CATEGORIES.CATEGORIES,
    description: 'Create product categories in the tenant',
  },
  {
    key: PERMISSIONS.CATEGORY_UPDATE,
    name: 'Update categories',
    category: PERMISSION_CATEGORIES.CATEGORIES,
    description: 'Update product categories in the tenant',
  },
  {
    key: PERMISSIONS.CATEGORY_DELETE,
    name: 'Delete categories',
    category: PERMISSION_CATEGORIES.CATEGORIES,
    description: 'Delete product categories in the tenant',
  },
  {
    key: PERMISSIONS.CATEGORY_MANAGE,
    name: 'Manage categories',
    category: PERMISSION_CATEGORIES.CATEGORIES,
    description: 'Full product category management in the tenant',
  },
  {
    key: PERMISSIONS.PRODUCT_READ,
    name: 'Read products',
    category: PERMISSION_CATEGORIES.PRODUCTS,
    description: 'View products in the tenant',
  },
  {
    key: PERMISSIONS.PRODUCT_CREATE,
    name: 'Create products',
    category: PERMISSION_CATEGORIES.PRODUCTS,
    description: 'Create products in the tenant',
  },
  {
    key: PERMISSIONS.PRODUCT_UPDATE,
    name: 'Update products',
    category: PERMISSION_CATEGORIES.PRODUCTS,
    description: 'Update products in the tenant',
  },
  {
    key: PERMISSIONS.PRODUCT_DELETE,
    name: 'Delete products',
    category: PERMISSION_CATEGORIES.PRODUCTS,
    description: 'Delete products in the tenant',
  },
  {
    key: PERMISSIONS.PRODUCT_MANAGE,
    name: 'Manage products',
    category: PERMISSION_CATEGORIES.PRODUCTS,
    description: 'Full product management in the tenant',
  },
  {
    key: PERMISSIONS.INVENTORY_READ,
    name: 'Read inventory',
    category: PERMISSION_CATEGORIES.INVENTORY,
    description: 'View inventory levels in the tenant',
  },
  {
    key: PERMISSIONS.INVENTORY_MANAGE,
    name: 'Manage inventory',
    category: PERMISSION_CATEGORIES.INVENTORY,
    description: 'Adjust inventory levels in the tenant',
  },
  {
    key: PERMISSIONS.CART_MANAGE,
    name: 'Manage cart',
    category: PERMISSION_CATEGORIES.CART,
    description: 'Manage own cart in the tenant',
  },
  {
    key: PERMISSIONS.ORDER_READ,
    name: 'Read orders',
    category: PERMISSION_CATEGORIES.ORDERS,
    description: 'View orders in the tenant',
  },
  {
    key: PERMISSIONS.ORDER_CREATE,
    name: 'Create orders',
    category: PERMISSION_CATEGORIES.ORDERS,
    description: 'Create orders in the tenant',
  },
  {
    key: PERMISSIONS.ORDER_DELETE,
    name: 'Cancel orders',
    category: PERMISSION_CATEGORIES.ORDERS,
    description: 'Cancel pending orders in the tenant',
  },
  {
    key: PERMISSIONS.ORDER_MANAGE,
    name: 'Manage orders',
    category: PERMISSION_CATEGORIES.ORDERS,
    description: 'Full order management in the tenant',
  },
  {
    key: PERMISSIONS.PAYMENT_READ,
    name: 'Read payments',
    category: PERMISSION_CATEGORIES.PAYMENTS,
    description: 'View payments in the tenant',
  },
  {
    key: PERMISSIONS.PAYMENT_CREATE,
    name: 'Create payments',
    category: PERMISSION_CATEGORIES.PAYMENTS,
    description: 'Create payments in the tenant',
  },
  {
    key: PERMISSIONS.PAYMENT_MANAGE,
    name: 'Manage payments',
    category: PERMISSION_CATEGORIES.PAYMENTS,
    description: 'Full payment management in the tenant (capture/fail)',
  },
  {
    key: PERMISSIONS.POS_READ,
    name: 'Read POS devices and sessions',
    category: PERMISSION_CATEGORIES.POS,
    description: 'View POS devices and sessions in the tenant',
  },
  {
    key: PERMISSIONS.POS_CREATE,
    name: 'Register POS devices and open sessions',
    category: PERMISSION_CATEGORIES.POS,
    description:
      'Register POS devices and open POS sessions in the tenant (A1: admin-level authority; employees are read-only)',
  },
  {
    key: PERMISSIONS.POS_MANAGE,
    name: 'Manage POS devices and sessions',
    category: PERMISSION_CATEGORIES.POS,
    description:
      'Suspend/resume/retire POS devices, rotate device credentials, and close POS sessions in the tenant',
  },
  {
    key: PERMISSIONS.MEMBER_READ,
    name: 'Read members',
    category: PERMISSION_CATEGORIES.MEMBERS,
    description: 'View tenant members',
  },
  {
    key: PERMISSIONS.MEMBER_MANAGE,
    name: 'Manage members',
    category: PERMISSION_CATEGORIES.MEMBERS,
    description: 'Manage memberships and their roles',
  },
  {
    key: PERMISSIONS.ROLE_READ,
    name: 'Read roles',
    category: PERMISSION_CATEGORIES.RBAC,
    description: 'View roles and their permissions',
  },
  {
    key: PERMISSIONS.ROLE_MANAGE,
    name: 'Manage roles',
    category: PERMISSION_CATEGORIES.RBAC,
    description: 'Create, update, delete roles and assign permissions',
  },
  {
    key: PERMISSIONS.SETTINGS_READ,
    name: 'Read settings',
    category: PERMISSION_CATEGORIES.SETTINGS,
    description: 'View tenant settings',
  },
  {
    key: PERMISSIONS.SETTINGS_MANAGE,
    name: 'Manage settings',
    category: PERMISSION_CATEGORIES.SETTINGS,
    description: 'Update tenant settings',
  },
  {
    key: PERMISSIONS.REPORT_READ,
    name: 'Read reports',
    category: PERMISSION_CATEGORIES.REPORTING,
    description: 'View tenant reports',
  },
];

export const SYSTEM_ROLE_KEYS = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
} as const;

export interface SystemRoleDefinition {
  key: string;
  name: string;
  description?: string;
  defaultPermissions: readonly string[];
}

/**
 * System roles are seeded per tenant and are immutable at the application
 * layer. The owner role has a semantic "all permissions" rule in
 * PermissionService and therefore carries no explicit grants.
 */
export const SYSTEM_ROLE_DEFINITIONS: readonly SystemRoleDefinition[] = [
  {
    key: SYSTEM_ROLE_KEYS.OWNER,
    name: 'Owner',
    description: 'Full control over the tenant (all permissions)',
    defaultPermissions: [],
  },
  {
    key: SYSTEM_ROLE_KEYS.ADMIN,
    name: 'Admin',
    description: 'Tenant administration',
    defaultPermissions: [
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.MEMBER_MANAGE,
      PERMISSIONS.SETTINGS_MANAGE,
      PERMISSIONS.STORE_MANAGE,
      PERMISSIONS.ASSET_MANAGE,
      PERMISSIONS.EQUIPMENT_MANAGE,
      PERMISSIONS.CUSTOMER_MANAGE,
      PERMISSIONS.RESERVATION_MANAGE,
      PERMISSIONS.CATEGORY_MANAGE,
      PERMISSIONS.PRODUCT_MANAGE,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.ORDER_MANAGE,
      PERMISSIONS.PAYMENT_MANAGE,
      PERMISSIONS.POS_READ,
      PERMISSIONS.POS_CREATE,
      PERMISSIONS.POS_MANAGE,
      PERMISSIONS.REPORT_READ,
    ],
  },
  {
    key: SYSTEM_ROLE_KEYS.EMPLOYEE,
    name: 'Employee',
    description: 'Baseline operational access',
    defaultPermissions: [
      PERMISSIONS.STORE_READ,
      PERMISSIONS.ASSET_READ,
      PERMISSIONS.EQUIPMENT_READ,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.RESERVATION_READ,
      PERMISSIONS.CATEGORY_READ,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.CART_MANAGE,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.POS_READ,
    ],
  },
];
