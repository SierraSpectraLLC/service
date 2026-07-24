// Pure allowlist/role helpers, kept free of next-auth and db imports so they
// are unit-testable. src/auth.ts re-exports them - import from either place.

export function parseList(v: string | undefined): string[] {
  return (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** An allowlist entry is an exact email, or "@domain.com" to match the whole domain. */
export function matchesEntry(email: string, entry: string): boolean {
  return entry.startsWith("@") ? email.endsWith(entry) : email === entry;
}

/**
 * Role for a given email based on env allowlists. First staff email = owner.
 * STAFF_EMAILS is exact emails only (staff access is too sensitive for domain
 * matching); CLIENT_EMAILS entries may be emails or @domains.
 */
export function roleForEmail(email: string): "owner" | "staff" | "client_viewer" | null {
  const e = email.toLowerCase();
  const staff = parseList(process.env.STAFF_EMAILS);
  const clients = parseList(process.env.CLIENT_EMAILS);
  if (staff.length && staff[0] === e) return "owner";
  if (staff.includes(e)) return "staff";
  if (clients.some((c) => matchesEntry(e, c))) return "client_viewer";
  return null;
}
