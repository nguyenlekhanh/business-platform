/**
 * Normalizes an email address for storage and lookup: trims surrounding
 * whitespace and lowercases the domain-local and domain parts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
