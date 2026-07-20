import { auth } from "@/auth";

export type Role = "owner" | "staff" | "client_viewer" | "client_editor";

export async function currentUser() {
  const session = await auth();
  if (!session?.user?.email) return null;
  return {
    email: session.user.email,
    name: session.user.name || session.user.email.split("@")[0],
    role: ((session.user as { role?: string }).role || "client_viewer") as Role,
  };
}

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

/** Throws unless the caller is Sierra Spectra staff (owner counts). */
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
