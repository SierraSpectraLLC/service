import { signIn } from "@/auth";
import { getBrand } from "@/lib/brand";
import LoginForm from "@/components/LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const [{ sent }, brand] = await Promise.all([searchParams, getBrand()]);

  /**
   * Send the link. Returns the failure rather than throwing it: a thrown server
   * action error is masked in production, which would leave the person staring
   * at a form that silently did nothing. The redirect on success still throws -
   * that one is Next's own control flow, so it has to pass through.
   */
  async function send(email: string): Promise<{ error?: string } | void> {
    "use server";
    try {
      await signIn("resend", { email, redirectTo: "/" });
    } catch (e) {
      if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
      return { error: (e as Error).message || "Could not send the sign-in email." };
    }
  }

  return (
    <div className="container form" style={{ paddingTop: 60 }}>
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 16, color: "var(--navy)", marginBottom: 4 }}>Sign in to {brand.name}</div>
        {sent ? (
          <p style={{ fontSize: 13 }} className="mut">
            Check your email for a sign-in link. It expires in 24 hours.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13 }} className="mut">
              Enter your email and we&apos;ll send you a magic link. Access is limited to approved accounts.
            </p>
            <LoginForm send={send} />
          </>
        )}
      </div>
    </div>
  );
}
