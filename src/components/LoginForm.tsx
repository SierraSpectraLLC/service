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
export default function LoginForm({ send, withPassword, smsOffered = false }: {
  /** Server action: sends the code by the channel asked for. */
  send: (email: string, channel?: "email" | "sms") => Promise<{ error?: string } | void>;
  /** Whether this instance can text at all - hides a button that would do nothing. */
  smsOffered?: boolean;
  /** Server action: signs in with a password, and says where to go next. */
  withPassword: (email: string, password: string) => Promise<{ error?: string; to?: string }>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [sentBy, setSentBy] = useState<"email" | "sms">("email");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const ask = (channel: "email" | "sms") => {
    if (!email.trim()) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await send(email.trim(), channel);
      if (res?.error) { setError(res.error); return; }
      setSentBy(channel);
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
    // callbackUrl is spelled out rather than left to Auth.js's default. Its
    // default reads a cookie this flow never sets - the code is asked for from a
    // server action with redirect:false - so where somebody landed after typing
    // a code was whatever that fallback happened to be, not the dashboard.
    const url = `/api/auth/callback/resend?token=${clean}`
      + `&email=${encodeURIComponent(email.trim().toLowerCase())}`
      + `&callbackUrl=${encodeURIComponent("/")}`;
    window.location.href = url;
  };

  const resend = () => {
    setError(""); setNote("");
    startTransition(async () => {
      const res = await send(email.trim(), sentBy);
      if (res?.error) setError(res.error);
      else setNote("Sent again - use the newest code.");
    });
  };

  const signInWithPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(""); setNote("");
    startTransition(async () => {
      const res = await withPassword(email.trim(), password);
      if (res?.error) { setError(res.error); setPassword(""); return; }
      // A full load, not a router navigation: the session cookie arrived on that
      // response, and the client router would happily serve the page it already
      // had - which is this one.
      window.location.assign(res?.to || "/");
    });
  };

  if (step === "password") {
    return (
      <form onSubmit={signInWithPassword}>
        <label htmlFor="pw-email">Email</label>
        <input id="pw-email" type="email" required autoComplete="username"
          style={{ marginBottom: 10, fontSize: 16 }} placeholder="you@company.com"
          value={email} disabled={pending} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" required autoFocus autoComplete="current-password"
          style={{ marginBottom: 10, fontSize: 16 }}
          value={password} disabled={pending} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary" type="submit" style={{ width: "100%" }}
          disabled={pending || !email.trim() || !password}>
          {pending ? "Signing in..." : "Sign in"}
        </button>
        <div className="t-small" style={{ marginTop: 10 }}>
          <button type="button" className="btn link" onClick={() => { setStep("email"); setPassword(""); setError(""); }}>
            Email me a code instead
          </button>
        </div>
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </form>
    );
  }

  if (step === "code") {
    return (
      <form onSubmit={enter}>
        {/* "If it's approved" rather than "we sent it": an address that isn't on
            the list gets no email, and saying otherwise would be a lie - while
            saying which addresses exist would be a way to find out. */}
        <p className="mut t-body" style={{ marginTop: 0 }}>
          If <b style={{ color: "var(--ink)" }}>{email.trim()}</b> is approved, a {CODE_DIGITS}-digit code is
          on its way{sentBy === "sms" ? " by text, or by email if there's no number on file" : ""}.
          It expires in {CODE_TTL_MINUTES} minutes.
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
        <div className="row-3 t-small" style={{ marginTop: 10 }}>
          <button type="button" className="btn link" disabled={pending} onClick={resend}>
            {pending ? "Sending..." : "Send another code"}
          </button>
          <button type="button" className="btn link" onClick={() => { setStep("email"); setCode(""); setError(""); setNote(""); }}>
            Use a different address
          </button>
          {/* The reason this exists: when mail is blocked, no code is coming. */}
          <button type="button" className="btn link" onClick={() => { setStep("password"); setCode(""); setError(""); setNote(""); }}>
            No code? Use your password
          </button>
        </div>
        {note && <div className="t-small" style={{ color: "var(--t-good-fg)", marginTop: 8 }}>{note}</div>}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </form>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); ask("email"); }}>
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
      {smsOffered && (
        <button className="btn" type="button" style={{ width: "100%", marginTop: 8 }}
          disabled={pending || !email.trim()} onClick={() => ask("sms")}>
          Text me a code instead
        </button>
      )}
      <div className="t-small" style={{ marginTop: 10 }}>
        <button type="button" className="btn link" onClick={() => { setStep("password"); setError(""); }}>
          No magic link or code? Type your password
        </button>
      </div>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </form>
  );
}
