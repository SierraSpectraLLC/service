import { signIn } from "@/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <div className="container" style={{ maxWidth: 420, paddingTop: 60 }}>
      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 16, color: "var(--navy)", marginBottom: 4 }}>Sign in</div>
        {sent ? (
          <p style={{ fontSize: 13 }} className="mut">
            Check your email for a sign-in link. It expires in 24 hours.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13 }} className="mut">
              Enter your email and we&apos;ll send you a magic link. Access is limited to Sierra Spectra staff and approved client accounts.
            </p>
            <form
              action={async (formData: FormData) => {
                "use server";
                await signIn("resend", { email: formData.get("email"), redirectTo: "/" });
              }}
            >
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required placeholder="you@sierraspectra.com" style={{ marginBottom: 10 }} />
              <button className="btn primary" type="submit" style={{ width: "100%" }}>Send sign-in link</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
