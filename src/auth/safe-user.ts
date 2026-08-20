import { Prisma } from '@prisma/client';

/**
 * Prisma select that exposes only non-sensitive user fields. Used for every
 * user-facing response so passwordHash is never selected or serialized.
 */
export const SAFE_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{
  select: typeof SAFE_USER_SELECT;
}>;
