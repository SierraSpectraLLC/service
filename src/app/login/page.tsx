import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { landingFor } from "@/lib/welcome";
import { CHANNEL_COOKIE, logSignIn, signIn, signInAllowed } from "@/auth";
import { getBrand } from "@/lib/brand";
import { checkTryAllowed, clearAttempts, recordFailure, takeSendSlot } from "@/lib/loginGate";
import { checkPassword } from "@/lib/passwordAuth";
import { startSession } from "@/lib/sessionCookie";
import { CODE_DIGITS } from "@/lib/loginCode";
import { smsConfigured } from "@/lib/sms";
import LoginForm from "@/components/LoginForm";
import { PublicShell } from "@/components/ui";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ sent?: string; locked?: string; error?: string }>;
}) {
  const [{ locked, error }, brand] = await Promise.all([searchParams, getBrand()]);

  /**
   * Send the code. Returns the failure rather than throwing it: a thrown server
   * action error is masked in production, which would leave the person staring
   * at a form that silently did nothing.
   *
   * No redirect on success any more - the form stays on the page and asks for
   * the code, so `redirect: false` keeps Auth.js from bouncing the browser to
   * its "check your email" screen and losing the address they just typed.
   */
  async function send(email: string, channel: "email" | "sms" = "email"): Promise<{ error?: string } | void> {
    "use server";
    // Codes asked for are rate limited before a single one is sent: an address
    // somebody is hammering must not become a way to fill somebody's inbox.
    const slot = await takeSendSlot(email);
    if (!slot.allow) return { error: `${slot.reason} Try again in ${slot.retryAfterMinutes} minute${slot.retryAfterMinutes === 1 ? "" : "s"}.` };
    // The channel travels to the delivery step as a cookie, because Auth.js makes
    // the code inside its own flow and that step is the only place holding both
    // the code and the request. Cleared straight after, so it never decides a
    // later sign-in (see CHANNEL_COOKIE in src/auth.ts).
    const jar = await cookies();
    jar.set(CHANNEL_COOKIE, channel, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 });
    try {
      await signIn("resend", { email, redirect: false });
    } catch (e) {
      if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
      return { error: (e as Error).message || "Could not send the sign-in email." };
    } finally {
      jar.delete(CHANNEL_COOKIE);
    }
  }

  /**
   * The way in when email is not working at all - a blocked domain, a filter, a
   * fourteen-day provider timeout. Same gate as every other path (signInAllowed),
   * same throttle as codes, and the same answer whichever half was wrong: "no
   * account with that address" and "wrong password" are different answers only
   * to somebody who is guessing.
   */
  async function withPassword(email: string, password: string): Promise<{ error?: string; to?: string }> {
    "use server";
    const e = email.trim().toLowerCase();
    const gate = await checkTryAllowed(e);
    if (!gate.allow) return { error: `${gate.reason} Try again in ${gate.retryAfterMinutes} minute${gate.retryAfterMinutes === 1 ? "" : "s"}.` };

    const allowed = await signInAllowed(e);
    const found = allowed ? await checkPassword(e, password) : null;
    // A temporary password past its date. They typed it correctly, so this
    // tells a guesser nothing - and tells the person reading it off a sticky
    // note the only thing that helps them. It still counts as a failure, so a
    // stale password is not an unlimited oracle.
    if (found && "expired" in found) {
      await recordFailure(e);
      return { error: "That temporary password has expired. Ask for a new one, or sign in with a code." };
    }
    if (!found) {
      const { locked } = await recordFailure(e);
      return {
        error: locked
          ? "Too many attempts. Try again in 15 minutes, or use a sign-in code."
          : "That email and password don't match.",
      };
    }
    await clearAttempts(e);
    await startSession(found.userId);
    // The password door leaves no other trace - no code is mailed, so nothing
    // in anybody's inbox says this happened. Recorded here rather than inside
    // startSession so a failure to write the bookkeeping row can never be the
    // thing that stops somebody signing in (lib/loginLog).
    await logSignIn(e, "password", found.userId).catch(() => {});
    // Where, rather than a redirect from in here. A server action's redirect is
    // a client-side navigation, and the session cookie was set on THIS response
    // - so the router could serve the dashboard it already had, which is the
    // login page bouncing straight back. The form does a full load instead.
    const [me] = await db.select({ onboardedAt: users.onboardedAt })
      .from(users).where(eq(users.id, found.userId)).catch(() => []);
    return { to: landingFor(me?.onboardedAt ?? null) };
  }

  return (
    <PublicShell brandName={brand.name} tagline={brand.tagline} title="Sign in" width={420}>
      <div className="card">
        {locked ? (
          <p className="t-body" style={{ color: "var(--t-bad-fg)" }}>
            Too many sign-in attempts for that address. Try again in {locked} minute{locked === "1" ? "" : "s"}.
          </p>
        ) : (
          <>
            <p className="mut t-body">
              We&apos;ll email you a {CODE_DIGITS}-digit code. Read it on your phone, type it here - no email
              needed on this machine. Access is limited to approved accounts.
            </p>
            {error && (
              <p className="t-body" style={{ color: "var(--t-bad-fg)" }}>
                That code didn&apos;t work. It may have expired or already been used - ask for a new one.
              </p>
            )}
            <LoginForm send={send} withPassword={withPassword} smsOffered={smsConfigured()} />
          </>
        )}
      </div>
    </PublicShell>
  );
}
