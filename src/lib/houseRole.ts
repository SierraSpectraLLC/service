// Who is the house, and who may change that. Pure: no db, no next-auth, so the
// rules that decide superuser access can be pinned down by tests instead of
// being inferred from a callback.
//
// Two sources, deliberately:
//
//   STAFF_EMAILS[0] is the ROOT owner. Always an owner, never revocable from
//   the UI. It is lockout insurance - the whole point of managing roles in the
//   database is that a mistake is possible, and an instance whose last owner
//   was just deleted has no way back in. The root owner is that way back.
//
//   house_members is everything else, owner-managed from Settings. A row wins
//   over the env list for anybody but the root, which is what makes "revoke at
//   will" true: role 'none' says "STAFF_EMAILS lists them, we don't agree".
//
// Env entries beyond the first still resolve to staff when no row overrides
// them, so turning this on breaks nothing and needs no migration.

export type HouseRole = "owner" | "staff";
export type MemberRow = { email: string; role: string };

const norm = (s: string) => s.trim().toLowerCase();

/** The un-revocable owner from the environment, or null if none is configured. */
export function rootOwner(envStaff: string[]): string | null {
  return envStaff.length ? norm(envStaff[0]) : null;
}

/**
 * The house role for an email, or null when they're not house at all (the
 * caller then falls through to the client allowlist).
 */
export function houseRoleFor(email: string, envStaff: string[], members: MemberRow[]): HouseRole | null {
  const e = norm(email);
  if (!e) return null;
  if (rootOwner(envStaff) === e) return "owner";
  const row = members.find((m) => norm(m.email) === e);
  if (row) return row.role === "owner" ? "owner" : row.role === "staff" ? "staff" : null;
  // Legacy: still listed in the environment, nothing said otherwise.
  return envStaff.map(norm).includes(e) ? "staff" : null;
}

/** Every house email, for digests and staff notifications. */
export function houseEmailsFrom(envStaff: string[], members: MemberRow[]): string[] {
  const out = new Set<string>();
  for (const e of envStaff.map(norm).filter(Boolean)) out.add(e);
  for (const m of members) {
    const e = norm(m.email);
    if (!e) continue;
    if (m.role === "none") out.delete(e); else out.add(e);
  }
  return [...out];
}

/** Effective owners, so the last one can't be removed. */
export function ownerEmails(envStaff: string[], members: MemberRow[]): string[] {
  const out = new Set<string>();
  const root = rootOwner(envStaff);
  if (root) out.add(root);
  for (const m of members) {
    const e = norm(m.email);
    if (!e || e === root) continue;
    if (m.role === "owner") out.add(e); else out.delete(e);
  }
  return [...out];
}

/** Exact address, and not a domain wildcard - house access is too broad for one. */
export function validHouseEmail(email: string): boolean {
  const e = norm(email);
  if (e.startsWith("@") || e.includes(",") || /\s/.test(e)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(e);
}

/**
 * May `actor` change `subject`'s house role to `next`? Four refusals, each one a
 * way an owner could otherwise lock themselves or the instance out:
 *
 *  - the root owner is the environment's, not Settings' - editing it here would
 *    be a lie, since the env re-grants it on the next sign-in
 *  - nobody edits their own access; there is no undo screen for that mistake,
 *    so it takes a second owner
 *  - the last owner cannot be demoted or revoked
 *  - "none" is only meaningful as an override of an env entry
 */
export function memberGuard(opts: {
  actorEmail: string;
  subjectEmail: string;
  next: "owner" | "staff" | "revoke";
  envStaff: string[];
  members: MemberRow[];
}): { ok: true } | { ok: false; error: string } {
  const actor = norm(opts.actorEmail);
  const subject = norm(opts.subjectEmail);
  if (!validHouseEmail(subject)) {
    return { ok: false, error: "That needs to be one exact email address - no @domain wildcards for house access" };
  }
  const root = rootOwner(opts.envStaff);
  if (root && subject === root) {
    return { ok: false, error: `${subject} is the root owner from STAFF_EMAILS and can't be changed here - edit the environment variable to move it` };
  }
  if (subject === actor) {
    return { ok: false, error: "You can't change your own access - ask another owner to do it" };
  }
  if (opts.next !== "owner") {
    const owners = ownerEmails(opts.envStaff, opts.members);
    if (owners.length === 1 && owners[0] === subject) {
      return { ok: false, error: "That's the last owner - promote somebody else first" };
    }
  }
  return { ok: true };
}
