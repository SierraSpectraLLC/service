"use client";

import { useState, useTransition } from "react";
import { CODE_DIGITS, CODE_TTL_MINUTES, isCodeShaped, normalizeCode } from "@/lib/loginCode";

/**
 * Sign in in two steps: the address, then the code that arrives at it.
 *
 * The second step is the whole point. At an instrument, the machine you are
 * signing in on is not the machine your email is open on - so the code gets read
 * on a phone and typed on the bench, and nobody has to install a mail client
 * next to the chromatography software.
 *
 * The form stays on this page rather than sending somebody off to a "check your
 * email" screen: leaving the page loses the address they just typed, and coming
 * back to type a code is a worse trip than staying put.
 */
export default function LoginForm({ send }: {
  /** Server action: sends the code, returns a message on failure. */
  send: (email: string) => Promise<{ error?: string } | void>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await send(email.trim());
      if (res?.error) { setError(res.error); return; }
      setStep("code");
    });
  };

  // Typing the code is the same act as following the link, so it goes to the
  // same place: Auth.js's callback, which owns every rule about the credential.
  const enter = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizeCode(code);
    if (!isCodeShaped(clean)) { setError(`That should be ${CODE_DIGITS} digits.`); return; }
    setError("");
    const url = `/api/auth/callback/resend?token=${clean}&email=${encodeURIComponent(email.trim().toLowerCase())}`;
    window.location.href = url;
  };

  const resend = () => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await send(email.trim());
      if (res?.error) setError(res.error);
      else setNote("Sent again - use the newest code.");
    });
  };

  if (step === "code") {
    return (
      <form onSubmit={enter}>
        {/* "If it's approved" rather than "we sent it": an address that isn't on
            the list gets no email, and saying otherwise would be a lie - while
            saying which addresses exist would be a way to find out. */}
        <p style={{ fontSize: 13, marginTop: 0 }} className="mut">
          If <b style={{ color: "var(--ink)" }}>{email.trim()}</b> is approved, a {CODE_DIGITS}-digit code is
          on its way. It expires in {CODE_TTL_MINUTES} minutes.
        </p>
        <label htmlFor="code">Code</label>
        <input id="code" name="code" required autoFocus
          // A numeric keypad on a phone, and the browser's own one-time-code
          // autofill on a Mac or iPhone, which turns this into one tap.
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 -]*"
          maxLength={CODE_DIGITS + 2}
          style={{ marginBottom: 10, fontSize: 26, letterSpacing: 6, textAlign: "center", fontFamily: "var(--mono, monospace)" }}
          placeholder="000000" value={code}
          onChange={(e) => setCode(e.target.value)} />
        <button className="btn primary" type="submit" style={{ width: "100%" }}
          disabled={!isCodeShaped(normalizeCode(code))}>
          Sign in
        </button>
        <div style={{ display: "flex", gap: 10, marginTop: 10, fontSize: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn link" disabled={pending} onClick={resend}>
            {pending ? "Sending..." : "Send another code"}
          </button>
          <button type="button" className="btn link" onClick={() => { setStep("email"); setCode(""); setError(""); setNote(""); }}>
            Use a different address
          </button>
        </div>
        {note && <div style={{ fontSize: 12, color: "#2E6B2E", marginTop: 8 }}>{note}</div>}
        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
      </form>
    );
  }

  return (
    <form onSubmit={ask}>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="email"
        // 16px keeps iOS from zooming the whole page on focus.
        style={{ marginBottom: 10, fontSize: 16 }}
        placeholder="you@company.com" value={email} disabled={pending}
        onChange={(e) => setEmail(e.target.value)} />
      <button className="btn primary" type="submit" style={{ width: "100%" }}
        disabled={pending || !email.trim()}>
        {pending ? "Sending your code..." : "Email me a code"}
      </button>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </form>
  );
}
