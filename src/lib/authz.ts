import { cache } from "react";
import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth, signInIdentity } from "@/auth";
import { db } from "@/db";
import { orgs, users } from "@/db/schema";
import { parsePersona, SHADOW_REFUSAL, VIEW_AS_COOKIE, type Persona } from "@/lib/viewAs";
import { isHouseOf, isPlatformStaff, tenantViewer } from "@/lib/tenants";

export type Role = "owner" | "staff" | "client_viewer" | "client_editor";

export { VIEW_AS_COOKIE, SHADOW_REFUSAL, type Persona };

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
  /**
   * For staff: the operator whose workspace they run - the tenant they are the
   * house of, and the tenant new records they create belong to. Null for
   * organization members, and for staff whose company is missing (which
   * lib/tenants resolves to seeing nothing, never everything).
   */
  operatorOrgId: number | null;
  /** The operator that runs the instance. Its staff support every tenant. */
  rootOperatorOrgId: number | null;
};

/** The signed-in identity, before any "view as" persona is applied. */
const sessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  if (!session?.user?.email) return null;
  const su = session.user as {
    role?: string; orgId?: number | null; orgName?: string; orgKind?: string;
    operatorOrgId?: number | null; rootOperatorOrgId?: number | null;
  };
  return {
    email: session.user.email,
    name: session.user.name || session.user.email.split("@")[0],
    role: (su.role || "client_viewer") as Role,
    orgId: su.orgId ?? null,
    orgName: su.orgName ?? "",
    orgKind: su.orgKind ?? "",
    operatorOrgId: su.operatorOrgId ?? null,
    rootOperatorOrgId: su.rootOperatorOrgId ?? null,
  };
});

/**
 * What an active persona resolves to.
 *
 * Flattened rather than a union carried through the app, because every reader
 * wants the same four facts - who this looks like, what they may do, and which
 * organization they belong to - and only the switcher cares which of the two
 * kinds produced them.
 */
export type ActivePersona = {
  kind: "role" | "person";
  role: Role;
  orgId: number | null;
  orgName: string;
  orgKind: string;
  /** Person personas only: whose account this is. Blank for a role. */
  email: string;
  name: string;
  operatorOrgId: number | null;
};

/**
 * "View as" lets the platform owner walk the portal with someone else's eyes.
 * The cookie names a persona and is honored ONLY when the real session is the
 * owner's, so forging it gains nobody anything. Format lives in lib/viewAs.
 *
 * TWO KINDS, and the difference decides whether writing is allowed.
 *
 * A ROLE persona is a shape - "what does a client editor see". Identity stays
 * the operator's, so anything changed under it is recorded as them, which is
 * what the banner has always promised.
 *
 * A PERSON persona takes the identity outright, because half of what somebody
 * sees is keyed on WHO THEY ARE and not on what they may do: their saved panel
 * layout, the jobs assigned to them, their own read state, the per-person
 * flags on their account. Nothing short of their identity reproduces their
 * screen. In exchange it cannot write - see requireUser.
 *
 * Returns the real identity alongside, because the switcher reads this and has
 * to keep working from inside a persona that can reach nothing else.
 */
export const viewContext = cache(async (): Promise<{
  real: SessionUser | null; persona: ActivePersona | null;
}> => {
  const real = await sessionUser();
  if (!real || real.role !== "owner") return { real, persona: null };
  const wanted = parsePersona((await cookies()).get(VIEW_AS_COOKIE)?.value);
  if (!wanted) return { real, persona: null };

  if (wanted.kind === "person") {
    // Never yourself: a persona of your own account is a banner over nothing,
    // and it would take your own writing away for no reason at all.
    if (wanted.email === real.email.trim().toLowerCase()) return { real, persona: null };
    const [row] = await db.select({ name: users.name, email: users.email })
      .from(users).where(eq(users.email, wanted.email));
    // Resolved through the same two lookups a real sign-in uses, so the shoes
    // fit: a stale cookie for a deleted account falls back to the real self.
    const who = await signInIdentity(wanted.email);
    if (!row && !who.role) return { real, persona: null };
    const [org] = who.orgId === null ? [] : await db.select({ kind: orgs.kind })
      .from(orgs).where(eq(orgs.id, who.orgId));
    return {
      real,
      persona: {
        kind: "person",
        role: (who.role || "client_viewer") as Role,
        orgId: who.orgId,
        orgName: who.orgName,
        orgKind: org?.kind ?? "",
        email: wanted.email,
        name: row?.name || wanted.email.split("@")[0],
        operatorOrgId: who.operatorOrgId,
      },
    };
  }

  const [org] = await db.select({ name: orgs.name, kind: orgs.kind }).from(orgs).where(eq(orgs.id, wanted.orgId));
  // A stale cookie (org since deleted) simply falls back to the real identity.
  if (!org) return { real, persona: null };
  return {
    real,
    persona: {
      kind: "role", role: wanted.role, orgId: wanted.orgId,
      orgName: org.name, orgKind: org.kind,
      email: "", name: "", operatorOrgId: null,
    },
  };
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
  if (persona.kind === "person") {
    /* Their identity outright. This is what makes "my jobs", their saved
       layout, their read state and their per-person flags read the way they
       read for them - none of which a role persona could reach. */
    return {
      email: persona.email, name: persona.name,
      role: persona.role,
      orgId: persona.orgId, orgName: persona.orgName, orgKind: persona.orgKind,
      operatorOrgId: persona.operatorOrgId,
      rootOperatorOrgId: real.rootOperatorOrgId,
    };
  }
  return {
    email: real.email, name: real.name,
    role: persona.role,
    orgId: persona.orgId, orgName: persona.orgName, orgKind: persona.orgKind,
    // A role persona is always an organization member, never staff: standing
    // in a client's shoes means standing outside the workspace, so the
    // operator is dropped rather than carried in.
    operatorOrgId: null,
    rootOperatorOrgId: real.rootOperatorOrgId,
  };
});

/** Standing in one named person's shoes, as opposed to a role's. */
export async function isShadowing(): Promise<boolean> {
  const { persona } = await viewContext();
  return persona?.kind === "person";
}

/**
 * Nothing may be written while wearing somebody's identity.
 *
 * Enforced HERE, on the one funnel every server action passes through, rather
 * than on the handful of write helpers - because forty-odd actions guard
 * themselves and would each have needed remembering. A server action carries
 * the `next-action` header and a page render does not, which is what tells the
 * two apart: pages must keep rendering, or the mode would show a stack trace
 * instead of the screen it exists to reproduce.
 *
 * Why refuse rather than write as the operator: diagnosing somebody's screen
 * should not be able to approve a quote in their name, and an owner who
 * genuinely needs to act has their own account one click away.
 */
async function refuseShadowWrites(): Promise<void> {
  let isAction = false;
  try { isAction = (await headers()).get("next-action") !== null; } catch { isAction = false; }
  if (!isAction) return;
  if (await isShadowing()) throw new Error(SHADOW_REFUSAL);
}

// The viewer as lib/tenants wants it, re-exported so server code has one import.
export { tenantViewer };

/**
 * Is this user the house of a record - the service company whose record it is,
 * rather than a partner who was let in? Replaces the old isHouse(role) wherever
 * a record's tenant is in hand. See lib/tenants.isHouseOf.
 */
export const houseOf = (u: SessionUser, tenantOrgId: number | null) =>
  isHouseOf(tenantViewer(u), tenantOrgId);

/**
 * The tenant a new record this user creates belongs to. Null only on an instance
 * that has not named its operator, where there is one workspace and nothing to
 * separate; every stamped write should carry this.
 */
export const myTenantOrgId = (u: SessionUser): number | null =>
  u.operatorOrgId ?? u.rootOperatorOrgId;

/** Throws unless the caller is signed in. Returns the user. */
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new Error("Not signed in");
  await refuseShadowWrites();
  return u;
}

/** Throws unless the caller may write (staff, owner, or elevated client). */
export async function requireEditor() {
  const u = await requireUser();
  if (u.role === "client_viewer") throw new Error("Read-only access");
  return u;
}

/**
 * Throws unless the caller is staff of a service company.
 *
 * The second check is the multi-operator one: on an instance that names an
 * operator, a staff account with no company of its own has no workspace to act
 * in, and letting it write would create records stamped with nobody. It says so
 * instead of quietly filing work where no one can find it.
 */
export async function requireStaff() {
  const u = await requireUser();
  if (u.role !== "owner" && u.role !== "staff") throw new Error("Staff only");
  if (u.rootOperatorOrgId !== null && u.operatorOrgId === null) {
    throw new Error("Your staff account isn't attached to a service company yet");
  }
  return u;
}

/** Throws unless the caller is the owner. */
export async function requireOwner() {
  const u = await requireUser();
  if (u.role !== "owner") throw new Error("Owner only");
  return u;
}

/**
 * Throws unless the caller owns the INSTANCE - the operator that runs the
 * platform. Distinct from requireOwner, which is now "an owner of some service
 * company": a second operator's owner runs their own workspace and must not be
 * able to rename the platform, flip its modules, or point the sheet somewhere.
 */
export async function requirePlatformOwner() {
  const u = await requireOwner();
  if (!isPlatformStaff(tenantViewer(u))) throw new Error("This is a platform setting");
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
