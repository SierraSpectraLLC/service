import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens, appSettings, clientAllowlist, orgs } from "@/db/schema";

import { parseList, matchesEntry, roleForEmail } from "@/lib/allowMatch";
import { getBrand } from "@/lib/brand";
import { emailShell, esc, codePanel, mutedLine } from "@/lib/emailTheme";
import { houseIdentityForEmail, houseRoleForEmail, rootOperatorOrgId } from "@/lib/house";
import { CODE_TTL_MINUTES, newCode } from "@/lib/loginCode";
import { type Method } from "@/lib/loginLog";
import { recordLogin, touchLastSeen } from "@/lib/loginLogData";
import { notifyFirstSignIn } from "@/lib/notify";
import { sendSms, smsConfigured } from "@/lib/sms";

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
export async function orgForEmail(email: string): Promise<{ id: number; name: string; kind: string; canEdit: boolean; parentOrgId: number | null } | null> {
  const e = email.toLowerCase();
  const rows = await db
    .select({
      entry: clientAllowlist.entry, canEdit: clientAllowlist.canEdit,
      id: orgs.id, name: orgs.name, kind: orgs.kind, parentOrgId: orgs.parentOrgId,
    })
    .from(clientAllowlist)
    .innerJoin(orgs, eq(orgs.id, clientAllowlist.orgId));
  const hits = rows.filter((r) => matchesEntry(e, r.entry));
  if (!hits.length) return null;
  const hit = hits.find((r) => !r.entry.trim().startsWith("@")) ?? hits[0];
  return { id: hit.id, name: hit.name, kind: hit.kind, canEdit: hit.canEdit, parentOrgId: hit.parentOrgId };
}

/**
 * Send the magic link, with the two things the default provider lacks: a hard
 * timeout, so a slow or unreachable Resend fails in seconds with a real
 * message instead of hanging until the platform kills the request, and a timing
 * line in the log, because "sign-in is slow" is unfixable until you can see
 * which hop is slow.
 */
const SEND_TIMEOUT_MS = 8000;

/**
 * How this code is being asked for. Set by the sign-in action just before it
 * calls signIn, read here - the two run inside one request, so the cookie is a
 * per-request hand-off and never outlives it.
 *
 * It exists because Auth.js generates the code inside its own flow: this is the
 * only place that has both the code and the request, which is where the choice
 * of "email it" or "text it" has to be made.
 */
export const CHANNEL_COOKIE = "login_channel";

async function deliverCode({ identifier, url, token, provider }: {
  identifier: string; url: string; token: string; provider: { from?: string; apiKey?: string };
}) {
  // Texting first when it was asked for and there is a number on file. A carrier
  // failure falls through to email rather than leaving somebody with nothing -
  // the code is already made and already stored, so the only question left is
  // how it reaches them.
  const wantsSms = (await cookies()).get(CHANNEL_COOKIE)?.value === "sms";
  if (wantsSms && smsConfigured()) {
    const [u] = await db.select({ phone: users.phone }).from(users)
      .where(eq(users.email, identifier.toLowerCase())).catch(() => []);
    if (u?.phone) {
      const sent = await sendSms(u.phone, `${token} is your sign-in code. It expires in ${CODE_TTL_MINUTES} minutes.`);
      if (sent) return;
    }
  }
  // The brand read is cached per request and shares the sign-in path's pool;
  // getBrand never throws, so a broken settings row still sends a mail that
  // just says "Service Portal".
  const brand = (await getBrand()).name;
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
        // The code leads: the machine somebody is signing in ON is usually not
        // the machine this email is open on. The link is still here, and still
        // the faster path when you are reading this on the device you want in.
        subject: `${token} is your sign-in code`,
        html: emailShell({
          brand,
          preheader: `It expires in ${CODE_TTL_MINUTES} minutes and works once.`,
          body: `Type this code to sign in:
            ${codePanel(token)}
            ${mutedLine(`It expires in ${CODE_TTL_MINUTES} minutes and works once.`)}
            ${mutedLine(`Reading this on the device you want to sign in on? <a href="${esc(url)}" style="color:#1D6396;">Sign in here instead</a>.`)}`,
          footer: `Sent by ${esc(brand)}. If you didn't ask to sign in, you can ignore this email.`,
        }),
        text: `Your sign-in code is ${token}\n\nIt expires in ${CODE_TTL_MINUTES} minutes and works once.\n\nOr sign in on this device: ${url}`,
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

/**
 * May this address sign in at all?
 *
 * Exported because it is no longer only Auth.js that asks: the password fallback
 * signs somebody in without going through Auth.js's routes, and it has to answer
 * the same question, or a revoked client with a password set last month would
 * still be walking in.
 */
export async function signInAllowed(rawEmail: string): Promise<boolean> {
  const email = rawEmail.toLowerCase();
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
}

/**
 * Who somebody is at the moment they get in, frozen onto the login record.
 *
 * The same two lookups the session callback does, pulled out because there are
 * two doors into this app and both have to describe the arrival the same way -
 * a password sign-in that recorded a blank role would be a hole in exactly the
 * report this exists to feed.
 */
export async function signInIdentity(rawEmail: string): Promise<{
  role: string; orgId: number | null; orgName: string; operatorOrgId: number | null;
}> {
  const email = rawEmail.trim().toLowerCase();
  const house = await houseIdentityForEmail(email);
  // House staff belong to the company they work for, not to a client org.
  if (house) return { role: house.role, orgId: null, orgName: "", operatorOrgId: house.orgId ?? house.rootOrgId };
  const org = await orgForEmail(email);
  return {
    role: org?.canEdit ? "client_editor" : "client_viewer",
    orgId: org?.id ?? null,
    orgName: org?.name ?? "",
    // A client belongs on the report of whichever operator services them.
    operatorOrgId: org?.parentOrgId ?? null,
  };
}

/** The request's own details, for the login record. Never throws. */
async function requestOrigin(): Promise<{ ip: string; userAgent: string }> {
  try {
    const h = await headers();
    return {
      ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim(),
      userAgent: h.get("user-agent") ?? "",
    };
  } catch {
    return { ip: "", userAgent: "" };
  }
}

/**
 * Write the login record, and ping the house the first time an address ever
 * gets in. Shared by both doors; wrapped by each caller so a bookkeeping
 * failure can never be the reason somebody cannot sign in.
 */
export async function logSignIn(email: string, method: Method, userId?: string | null): Promise<void> {
  const [who, origin] = await Promise.all([signInIdentity(email), requestOrigin()]);
  const { first } = await recordLogin({ email, method, userId, ...who, ...origin });
  if (!first) return;
  // Only the first one. A notification per sign-in would be ignored inside a
  // week, and the page and the weekly report are where the rest of it lives.
  await notifyFirstSignIn({
    email, role: who.role, orgName: who.orgName,
    operatorOrgId: who.operatorOrgId, method,
  }).catch(() => {});
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
      sendVerificationRequest: deliverCode,
      // A code somebody can read off a phone and type at an instrument, rather
      // than a 32-byte token they can only click. It is the same credential
      // either way - Auth.js hashes it, stores it once, and burns it on use -
      // so the link in the email keeps working exactly as before.
      generateVerificationToken: () => newCode((min, max) => crypto.randomInt(min, max)),
      // Minutes, not the default day. Six digits is a million combinations, and
      // the shorter life is half of what makes that enough (lib/loginCode).
      maxAge: CODE_TTL_MINUTES * 60,
    }),
  ],
  pages: { signIn: "/login", verifyRequest: "/login?sent=1" },
  events: {
    // Fires once per actual sign-in, after the gate below has allowed it. The
    // password door does not come through Auth.js at all and logs itself - see
    // app/login's withPassword.
    async signIn({ user }) {
      try { await logSignIn(user.email ?? "", "code", user.id); }
      catch (e) { console.error("[auth] sign-in not recorded:", (e as Error).message); }
    },
  },
  callbacks: {
    // Gate who is allowed to sign in at all.
    async signIn({ user }) {
      return signInAllowed(user.email ?? "");
    },
    async session({ session, user }) {
      // Keep the stored role in step with the live rules on every session read,
      // in BOTH directions. Only ever promoting would mean a revoked owner kept
      // their powers until someone thought to edit the row by hand.
      const email = user.email?.toLowerCase() || "";
      // Usage, as opposed to sign-ins. Free here: this callback runs on every
      // authenticated request and already has the row, so the throttle in
      // touchLastSeen turns a day of work into at most eight writes.
      void touchLastSeen(user.id, (user as { lastSeenAt?: Date | null }).lastSeenAt);
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
