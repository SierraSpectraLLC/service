import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { parsePersona, VIEW_AS_COOKIE, type Persona } from "@/lib/viewAs";

export type Role = "owner" | "staff" | "client_viewer" | "client_editor";

export { VIEW_AS_COOKIE, type Persona };

/**
 * Staff/owner have `orgId: null` and see everything. A client or provider
 * belongs to one organization and sees only what is shared with it - see
 * lib/tenancy.ts.
 */
export type SessionUser = {
  email: string; name: string; role: Role;
  orgId: number | null; orgName: string;
  /** "client" | "provider" | "" for the house. */
  orgKind: string;
};

/** The signed-in identity, before any "view as" persona is applied. */
const sessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  if (!session?.user?.email) return null;
  const su = session.user as { role?: string; orgId?: number | null; orgName?: string; orgKind?: string };
  return {
    email: session.user.email,
    name: session.user.name || session.user.email.split("@")[0],
    role: (su.role || "client_viewer") as Role,
    orgId: su.orgId ?? null,
    orgName: su.orgName ?? "",
    orgKind: su.orgKind ?? "",
  };
});

/**
 * "View as" lets the platform owner walk the portal with someone else's
 * permissions - the fastest way to see what a client or a service provider
 * actually gets. The cookie only names a persona; it never carries identity,
 * and it is honored ONLY when the real session is the owner's, so forging it
 * gains nobody anything. Writes made while a persona is active are still
 * audited under the real email. Format lives in lib/viewAs.
 *
 * Returns the real identity alongside the persona in effect - the switcher
 * itself reads this, so it keeps working from inside a persona.
 */
export const viewContext = cache(async (): Promise<{
  real: SessionUser | null; persona: (Persona & { orgName: string; orgKind: string }) | null;
}> => {
  const real = await sessionUser();
  if (!real || real.role !== "owner") return { real, persona: null };
  const wanted = parsePersona((await cookies()).get(VIEW_AS_COOKIE)?.value);
  if (!wanted) return { real, persona: null };
  const [org] = await db.select({ name: orgs.name, kind: orgs.kind }).from(orgs).where(eq(orgs.id, wanted.orgId));
  // A stale cookie (org since deleted) simply falls back to the real identity.
  if (!org) return { real, persona: null };
  return { real, persona: { ...wanted, orgName: org.name, orgKind: org.kind } };
});

/**
 * The effective user for everything downstream - pages, actions, tenancy. This
 * is the only place a persona is applied, so every gate in the app follows it
 * without knowing it exists.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const { real, persona } = await viewContext();
  if (!real) return null;
  if (!persona) return real;
  return {
    email: real.email, name: real.name,
    role: persona.role,
    orgId: persona.orgId, orgName: persona.orgName, orgKind: persona.orgKind,
  };
});

/** Throws unless the caller is signed in. Returns the user. */
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new Error("Not signed in");
  return u;
}

/** Throws unless the caller may write (staff, owner, or elevated client). */
export async function requireEditor() {
  const u = await requireUser();
  if (u.role === "client_viewer") throw new Error("Read-only access");
  return u;
}

/** Throws unless the caller runs the platform - staff or owner. */
export async function requireStaff() {
  const u = await requireUser();
  if (u.role !== "owner" && u.role !== "staff") throw new Error("Staff only");
  return u;
}

/** Throws unless the caller is the owner. */
export async function requireOwner() {
  const u = await requireUser();
  if (u.role !== "owner") throw new Error("Owner only");
  return u;
}

/**
 * Throws unless the REAL signed-in user is the owner, ignoring any persona.
 * Only the view-as switch itself may use this - it is what lets the owner
 * climb back out of a persona that has no access to anything.
 */
export async function requireRealOwner() {
  const { real } = await viewContext();
  if (!real || real.role !== "owner") throw new Error("Owner only");
  return real;
}
