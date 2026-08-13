import { signIn } from "@/auth";
import { getBrand } from "@/lib/brand";
import { takeSendSlot } from "@/lib/loginGate";
import { CODE_DIGITS } from "@/lib/loginCode";
import LoginForm from "@/components/LoginForm";

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
  async function send(email: string): Promise<{ error?: string } | void> {
    "use server";
    // Codes asked for are rate limited before a single one is sent: an address
    // somebody is hammering must not become a way to fill somebody's inbox.
    const slot = await takeSendSlot(email);
    if (!slot.allow) return { error: `${slot.reason} Try again in ${slot.retryAfterMinutes} minute${slot.retryAfterMinutes === 1 ? "" : "s"}.` };
    try {
      await signIn("resend", { email, redirect: false });
    } catch (e) {
      if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
      return { error: (e as Error).message || "Could not send the sign-in email." };
    }
  }

  return (
    <div className="container form" style={{ paddingTop: 60 }}>
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 16, color: "var(--navy)", marginBottom: 4 }}>Sign in to {brand.name}</div>

        {locked ? (
          <p style={{ fontSize: 13, color: "#A32D2D" }}>
            Too many sign-in attempts for that address. Try again in {locked} minute{locked === "1" ? "" : "s"}.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13 }} className="mut">
              We&apos;ll email you a {CODE_DIGITS}-digit code. Read it on your phone, type it here - no email
              needed on this machine. Access is limited to approved accounts.
            </p>
            {error && (
              <p style={{ fontSize: 13, color: "#A32D2D" }}>
                That code didn&apos;t work. It may have expired or already been used - ask for a new one.
              </p>
            )}
            <LoginForm send={send} />
          </>
        )}
      </div>
    </div>
  );
}
