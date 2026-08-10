import { signIn } from "@/auth";
import { getBrand } from "@/lib/brand";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const [{ sent }, brand] = await Promise.all([searchParams, getBrand()]);
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
            <form
              action={async (formData: FormData) => {
                "use server";
                await signIn("resend", { email: formData.get("email"), redirectTo: "/" });
              }}
            >
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required placeholder="you@company.com" style={{ marginBottom: 10 }} />
              <button className="btn primary" type="submit" style={{ width: "100%" }}>Send sign-in link</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
