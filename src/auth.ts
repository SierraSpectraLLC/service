import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, appSettings, clientAllowlist, orgs } from "@/db/schema";

import { parseList, matchesEntry, roleForEmail } from "@/lib/allowMatch";

export { parseList, matchesEntry, roleForEmail };

/** Owner-managed sign-in list in the DB (Settings page), unioned with CLIENT_EMAILS. */
export async function emailInClientAllowlist(email: string): Promise<boolean> {
  return (await orgForEmail(email)) !== null;
}

/**
 * Which organization an email signs in as, from the allowlist. An entry with no
 * org assigned grants nothing - a scope-less client login would see the whole
 * shop, so it is safer to refuse until Settings assigns one. Exact-email
 * entries win over @domain entries, so one person can be split out of their
 * company's default org.
 */
export async function orgForEmail(email: string): Promise<{ id: number; name: string; kind: string } | null> {
  const e = email.toLowerCase();
  const rows = await db.select().from(clientAllowlist);
  const hits = rows.filter((r) => r.orgId !== null && matchesEntry(e, r.entry));
  if (!hits.length) return null;
  const exact = hits.find((r) => !r.entry.trim().startsWith("@"));
  const [org] = await db.select().from(orgs).where(eq(orgs.id, (exact ?? hits[0]).orgId!));
  return org ? { id: org.id, name: org.name, kind: org.kind } : null;
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
      // Clients are scoped to one organization; staff and owner are the house
      // and see everything, so they carry no org.
      if (role === "client_viewer" || role === "client_editor") {
        const org = await orgForEmail(email);
        (session.user as { orgId?: number | null; orgName?: string }).orgId = org?.id ?? null;
        (session.user as { orgName?: string }).orgName = org?.name ?? "";
        // Kind decides what the org may do rather than see: only a client can
        // own a system, so only a client may claim one.
        (session.user as { orgKind?: string }).orgKind = org?.kind ?? "";
      }
      return session;
    },
  },
});
