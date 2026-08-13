"use client";

import { useState, useTransition } from "react";
import { setMyPassword, clearMyPassword, setMyPhone } from "@/app/actions";
import { MIN_PASSWORD } from "@/lib/password";

/**
 * How this person gets in, for the days the usual way doesn't work.
 *
 * Both of these exist for the same failure: email stops arriving - a provider
 * blocks a domain, a filter eats the message - and the portal that tracks the
 * instruments becomes unreachable. A phone gets the code by text instead; a
 * password skips the code entirely.
 *
 * Setting either from in here, signed in, is what makes them safe to offer:
 * the address was already proved, so neither is a way to get an account, only a
 * second way back into one you already have.
 */
export default function SignInSettings({ hasPassword, phone, smsConfigured }: {
  hasPassword: boolean; phone: string; smsConfigured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [tel, setTel] = useState(phone);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setMsg("");
    if (pw !== again) { setError("Those two don't match."); return; }
    startTransition(async () => {
      const res = await setMyPassword(pw);
      if (res?.error) { setError(res.error); return; }
      setPw(""); setAgain(""); setOpen(false);
      setMsg(hasPassword ? "Password changed." : "Password set - it's there if email ever isn't.");
    });
  };

  const savePhone = (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setMsg("");
    startTransition(async () => {
      const res = await setMyPhone(tel);
      if (res?.error) { setError(res.error); return; }
      setMsg(tel.trim() ? "Number saved - you can have codes texted." : "Number removed.");
    });
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-title" style={{ marginBottom: 6 }}>Signing in</div>

      {/* Only once texting actually works. Asking for a number that nothing can
          send to is a field that does nothing and a promise we haven't kept -
          set the three Twilio variables and this appears on its own. */}
      {smsConfigured && (
        <form onSubmit={savePhone} style={{ marginBottom: 14 }}>
          <label htmlFor="tel" style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 3 }}>
            Mobile number <span className="mut" style={{ fontWeight: 400 }}>for codes by text</span>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input id="tel" type="tel" autoComplete="tel" value={tel} disabled={pending}
              onChange={(e) => setTel(e.target.value)} placeholder="+1 555 123 4567"
              style={{ flex: "1 1 200px", fontSize: 16 }} />
            <button className="btn sm" type="submit" disabled={pending || tel === phone}>
              {pending ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      )}

      {open ? (
        <form onSubmit={savePassword}>
          <label htmlFor="new-pw" style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 3 }}>
            {hasPassword ? "New password" : "Password"} <span className="mut" style={{ fontWeight: 400 }}>at least {MIN_PASSWORD} characters</span>
          </label>
          <input id="new-pw" type="password" autoComplete="new-password" autoFocus value={pw}
            disabled={pending} onChange={(e) => setPw(e.target.value)}
            style={{ width: "100%", fontSize: 16, marginBottom: 8 }} />
          <label htmlFor="again-pw" style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 3 }}>Again</label>
          <input id="again-pw" type="password" autoComplete="new-password" value={again}
            disabled={pending} onChange={(e) => setAgain(e.target.value)}
            style={{ width: "100%", fontSize: 16, marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm accent" type="submit" disabled={pending || !pw || !again}>
              {pending ? "Saving..." : hasPassword ? "Change it" : "Set it"}
            </button>
            <button className="btn sm" type="button" disabled={pending}
              onClick={() => { setOpen(false); setPw(""); setAgain(""); setError(""); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5 }}>
            {hasPassword ? "A password is set." : "No password set - you sign in by code."}
          </span>
          <button className="btn sm" onClick={() => setOpen(true)}>
            {hasPassword ? "Change password" : "Set a password"}
          </button>
          {hasPassword && (
            <button className="btn link" style={{ fontSize: 12, color: "#A32D2D" }} disabled={pending}
              onClick={() => startTransition(async () => {
                await clearMyPassword();
                setMsg("Password removed - codes still work as they always did.");
              })}>Remove</button>
          )}
        </div>
      )}

      {msg && <div style={{ fontSize: 12, color: "#2E6B2E", marginTop: 8 }}>{msg}</div>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
