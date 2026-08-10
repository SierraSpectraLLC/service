"use client";

import { useState, useTransition } from "react";

/**
 * The sign-in form. A plain server-action form gave no feedback at all while
 * the link was being sent - the button stayed live, nothing moved, and a wait
 * of any length read as a broken page. Now the click lands immediately: the
 * button says what it's doing, the field locks, and a failure comes back as
 * words instead of silence.
 */
export default function LoginForm({ send }: {
  /** Server action: sends the link, returns a message on failure. */
  send: (email: string) => Promise<{ error?: string } | void>;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await send(email.trim());
      if (res?.error) setError(res.error);
    });
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="email"
        // 16px keeps iOS from zooming the whole page on focus.
        style={{ marginBottom: 10, fontSize: 16 }}
        placeholder="you@company.com" value={email} disabled={pending}
        onChange={(e) => setEmail(e.target.value)} />
      <button className="btn primary" type="submit" style={{ width: "100%" }}
        disabled={pending || !email.trim()}>
        {pending ? "Sending your link..." : "Send sign-in link"}
      </button>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </form>
  );
}
