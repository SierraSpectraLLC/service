import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, appSettings, clientAllowlist } from "@/db/schema";

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

/** Owner-managed sign-in list in the DB (Settings page), unioned with CLIENT_EMAILS. */
export async function emailInClientAllowlist(email: string): Promise<boolean> {
  const rows = await db.select().from(clientAllowlist);
  return rows.some((r) => matchesEntry(email.toLowerCase(), r.entry));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      from: process.env.EMAIL_FROM,
    }),
  ],
  pages: { signIn: "/login", verifyRequest: "/login?sent=1" },
  callbacks: {
    // Gate who is allowed to sign in at all.
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const role = roleForEmail(email);
      if (role === "owner" || role === "staff") return true;
      // Everyone else is a client: the access toggle must be on, and the email
      // must match the env list or the owner-managed list in Settings.
      const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
      if (!s?.clientAccessEnabled) return false;
      if (role === "client_viewer") return true;
      return emailInClientAllowlist(email);
    },
    async session({ session, user }) {
      // Keep the DB role fresh on every session read.
      const email = user.email?.toLowerCase() || "";
      const envRole = roleForEmail(email);
      let role = (user as { role?: string }).role || "client_viewer";
      if (envRole && envRole !== "client_viewer" && role !== envRole) {
        await db.update(users).set({ role: envRole }).where(eq(users.id, user.id));
        role = envRole;
      }
      // Client edit elevation is a settings toggle, applied at read time.
      if (role === "client_viewer") {
        const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
        if (s?.clientCanEdit) role = "client_editor";
      }
      (session.user as { role?: string }).role = role;
      return session;
    },
  },
});
