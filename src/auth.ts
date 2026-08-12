import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, appSettings, clientAllowlist, orgs } from "@/db/schema";

import { parseList, matchesEntry, roleForEmail } from "@/lib/allowMatch";
import { houseIdentityForEmail, houseRoleForEmail, rootOperatorOrgId } from "@/lib/house";

export { parseList, matchesEntry, roleForEmail };

/** Owner-managed sign-in list in the DB (Settings page), unioned with CLIENT_EMAILS. */
export async function emailInClientAllowlist(email: string): Promise<boolean> {
  return (await orgForEmail(email)) !== null;
}

/**
 * Which organization an email signs in as, and with what role, from the
 * allowlist. An entry with no org assigned grants nothing - a scope-less
 * client login would see the whole shop, so it is safer to refuse until
 * Settings assigns one. Exact-email entries win over @domain entries, so one
 * person can be split out of their company's default org - or given a
 * different role than the rest of their domain.
 *
 * One round trip: matching is in JS (the @domain rule can't be expressed as a
 * simple WHERE), but the org comes back on the same join rather than costing a
 * second query. Every hop here is on the sign-in path, where latency is felt.
 */
export async function orgForEmail(email: string): Promise<{ id: number; name: string; kind: string; canEdit: boolean } | null> {
  const e = email.toLowerCase();
  const rows = await db
    .select({
      entry: clientAllowlist.entry, canEdit: clientAllowlist.canEdit,
      id: orgs.id, name: orgs.name, kind: orgs.kind,
    })
    .from(clientAllowlist)
    .innerJoin(orgs, eq(orgs.id, clientAllowlist.orgId));
  const hits = rows.filter((r) => matchesEntry(e, r.entry));
  if (!hits.length) return null;
  const hit = hits.find((r) => !r.entry.trim().startsWith("@")) ?? hits[0];
  return { id: hit.id, name: hit.name, kind: hit.kind, canEdit: hit.canEdit };
}

/**
 * Send the magic link, with the two things the default provider lacks: a hard
 * timeout, so a slow or unreachable Resend fails in seconds with a real
 * message instead of hanging until the platform kills the request, and a timing
 * line in the log, because "sign-in is slow" is unfixable until you can see
 * which hop is slow.
 */
const SEND_TIMEOUT_MS = 8000;

async function sendMagicLink({ identifier, url, provider }: {
  identifier: string; url: string; provider: { from?: string; apiKey?: string };
}) {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey ?? process.env.AUTH_RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: provider.from ?? process.env.EMAIL_FROM,
        to: identifier,
        subject: "Your sign-in link",
        html: `<p>Tap to sign in. The link expires in 24 hours and works once.</p><p><a href="${url}">Sign in</a></p>`,
        text: `Sign in: ${url}\n\nThe link expires in 24 hours and works once.`,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    const ms = Date.now() - started;
    console.error(`[auth] resend send failed after ${ms}ms:`, (e as Error).name, (e as Error).message);
    throw new Error(
      (e as Error).name === "TimeoutError"
        ? "The email service did not respond. Try again in a moment."
        : "Could not send the sign-in email.",
    );
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`[auth] resend rejected after ${ms}ms:`, res.status, await res.text().catch(() => ""));
    throw new Error("Could not send the sign-in email.");
  }
  console.log(`[auth] magic link sent in ${ms}ms`);
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
      sendVerificationRequest: sendMagicLink,
    }),
  ],
  pages: { signIn: "/login", verifyRequest: "/login?sent=1" },
  callbacks: {
    // Gate who is allowed to sign in at all.
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      // House membership is owner-managed in the database now, with the first
      // STAFF_EMAILS entry as an un-revocable root (see lib/houseRole).
      if (await houseRoleForEmail(email)) return true;
      // Everyone else is a client: the access toggle must be on, and the email
      // must match the env list or the owner-managed list in Settings. Both
      // reads are independent, so they go out together - on the sign-in path
      // two sequential round trips is two waits the person can feel.
      const envRole = roleForEmail(email);
      const [[s], allowed] = await Promise.all([
        db.select().from(appSettings).where(eq(appSettings.id, 1)),
        envRole === "client_viewer" ? Promise.resolve(true) : emailInClientAllowlist(email),
      ]);
      if (!s?.clientAccessEnabled) return false;
      return allowed;
    },
    async session({ session, user }) {
      // Keep the stored role in step with the live rules on every session read,
      // in BOTH directions. Only ever promoting would mean a revoked owner kept
      // their powers until someone thought to edit the row by hand.
      const email = user.email?.toLowerCase() || "";
      const house = await houseIdentityForEmail(email);
      const stored = (user as { role?: string }).role || "client_viewer";
      let role = house?.role ?? "client_viewer";
      if (stored !== role) {
        await db.update(users).set({ role }).where(eq(users.id, user.id));
      }
      // Which service company this staff member runs, and which one runs the
      // instance. "Staff" means nothing on its own once there is more than one
      // operator - see lib/tenants.
      (session.user as { operatorOrgId?: number | null }).operatorOrgId = house?.orgId ?? null;
      (session.user as { rootOperatorOrgId?: number | null }).rootOperatorOrgId = house?.rootOrgId
        ?? await rootOperatorOrgId();
      // Clients are scoped to one organization; staff and owner are the house
      // and see everything, so they carry no org. Editor vs viewer comes from
      // the person's own allowlist entry, resolved fresh on every read so a
      // role change in Settings bites immediately.
      if (role !== "owner" && role !== "staff") {
        const org = await orgForEmail(email);
        role = org?.canEdit ? "client_editor" : "client_viewer";
        (session.user as { orgId?: number | null; orgName?: string }).orgId = org?.id ?? null;
        (session.user as { orgName?: string }).orgName = org?.name ?? "";
        (session.user as { orgKind?: string }).orgKind = org?.kind ?? "";
      }
      (session.user as { role?: string }).role = role;
      return session;
    },
  },
});
