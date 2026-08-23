"use client";

import { useState, useTransition } from "react";
import { completeWelcome } from "@/app/actions";
import { MIN_PASSWORD } from "@/lib/password";
import { Field } from "@/components/ui";

/**
 * The first minute of somebody's first sign-in, and the only time they see it.
 *
 * Three things, in the order they matter. What to call you - it is on every task
 * you are given and every mention of you, and the guess made from an email
 * address is only ever a guess. What to email you about - the default is
 * everything, which is the right default and the wrong one to leave unexamined.
 * And a password, offered rather than required, because codes work and the
 * reason to have one is the day they don't.
 *
 * Nothing here is a gate on anything: skipping the password and leaving every
 * notification on is a complete answer, and the form says so.
 */
export default function WelcomeForm({ email, suggested, kinds, brandName }: {
  email: string;
  /** A name read out of their address, for them to correct rather than compose. */
  suggested: string;
  kinds: { kind: string; label: string }[];
  brandName: string;
}) {
  const [name, setName] = useState(suggested);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  // Only the opt-outs travel: no row means email on, so this is the set of
  // boxes somebody unticked. See lib/inbox.
  const [off, setOff] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const toggle = (kind: string) => setOff((cur) => {
    const next = new Set(cur);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password && password !== again) { setError("Those two passwords don't match."); return; }
    startTransition(async () => {
      const res = await completeWelcome({ name, password: password || undefined, emailOff: [...off] });
      if (res?.error) { setError(res.error); return; }
      // A full load, not a client transition: their name is in the session and
      // on every page's header, and this is the one moment it changes.
      window.location.assign("/");
    });
  };

  return (
    <form onSubmit={submit}>
      <div className="t-title" style={{ fontWeight: 700, color: "var(--navy)", marginBottom: 4 }}>
        Welcome to {brandName}
      </div>
      <p className="mut t-body" style={{ marginTop: 0 }}>
        One minute, once. Signed in as <b style={{ color: "var(--ink)" }}>{email}</b>.
      </p>

      <Field label="Your name" htmlFor="w-name" required
        hint="Shown on your tasks, notes and hours.">
        <input id="w-name" required autoFocus maxLength={60} value={name} disabled={pending}
          onChange={(e) => setName(e.target.value)} placeholder="Joe Harris"
          style={{ fontSize: 16 }} />
      </Field>

      <Field label="Email me about"
        hint="">
        <div>
          {kinds.map((k) => (
            <label key={k.kind} style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0",
              textTransform: "none", letterSpacing: 0, color: "var(--ink)", fontWeight: 400,
            }}>
              <input type="checkbox" className="check" checked={!off.has(k.kind)} disabled={pending}
                onChange={() => toggle(k.kind)} />
              {k.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Password" optional
        hint={`You sign in with an emailed code. A password is the way in on the day email isn't arriving - at least ${MIN_PASSWORD} characters, or leave both blank.`}>
        <>
          <input type="password" autoComplete="new-password" value={password} disabled={pending}
            onChange={(e) => setPassword(e.target.value)} placeholder="Password"
            style={{ fontSize: 16, marginBottom: 6 }} />
          {password && (
            <input type="password" autoComplete="new-password" value={again} disabled={pending}
              onChange={(e) => setAgain(e.target.value)} placeholder="Again"
              style={{ fontSize: 16 }} />
          )}
        </>
      </Field>

      <button className="btn primary" type="submit" style={{ width: "100%", marginTop: 8 }}
        disabled={pending || !name.trim()}>
        {pending ? "Saving..." : "Start working"}
      </button>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </form>
  );
}
