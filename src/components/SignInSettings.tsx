"use client";

import { useState, useTransition } from "react";
import { setMyPassword, clearMyPassword, setMyName, setMyPhone } from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
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
export default function SignInSettings({ name, email, hasPassword, phone, smsConfigured }: {
  /** What everybody else sees on your assignments and mentions. Yours to set. */
  name: string; email: string;
  hasPassword: boolean; phone: string; smsConfigured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState(name);
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
      toast({ message: hasPassword ? "Changed the password" : "Set the password" });
    });
  };

  const saveName = (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setMsg("");
    startTransition(async () => {
      const res = await setMyName(who);
      if (res?.error) { setError(res.error); return; }
      setMsg("Name saved - it's what the rest of the shop sees.");
      toast({ message: "Saved your name" });
    });
  };

  const savePhone = (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setMsg("");
    startTransition(async () => {
      const res = await setMyPhone(tel);
      if (res?.error) { setError(res.error); return; }
      setMsg(tel.trim() ? "Number saved - you can have codes texted." : "Number removed.");
      toast({ message: tel.trim() ? "Saved the number" : "Removed the number" });
    });
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-title" style={{ marginBottom: 6 }}>Profile & sign-in</div>

      {/* Yours to set, not the owner's. This is the name on your assignments,
          your mentions and your hours; before this it was whatever somebody
          typed when they added you, which was usually nothing. */}
      <form onSubmit={saveName} style={{ marginBottom: 14 }}>
        <label htmlFor="my-name" className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>
          Your name <span className="mut" style={{ fontWeight: 400 }}>{email}</span>
        </label>
        <div className="row-2">
          <input id="my-name" value={who} disabled={pending} maxLength={60}
            onChange={(e) => setWho(e.target.value)} placeholder="Joe Harris"
            style={{ flex: "1 1 200px", fontSize: 16 }} />
          <button className="btn sm" type="submit" disabled={pending || !who.trim() || who === name}>
            {pending ? "Saving..." : "Save"}
          </button>
        </div>
      </form>

      {/* Only once texting actually works. Asking for a number that nothing can
          send to is a field that does nothing and a promise we haven't kept -
          set the three Twilio variables and this appears on its own. */}
      {smsConfigured && (
        <form onSubmit={savePhone} style={{ marginBottom: 14 }}>
          <label htmlFor="tel" className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>
            Mobile number <span className="mut" style={{ fontWeight: 400 }}>for codes by text</span>
          </label>
          <div className="row-2">
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
          <label htmlFor="new-pw" className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>
            {hasPassword ? "New password" : "Password"} <span className="mut" style={{ fontWeight: 400 }}>at least {MIN_PASSWORD} characters</span>
          </label>
          <input id="new-pw" type="password" autoComplete="new-password" autoFocus value={pw}
            disabled={pending} onChange={(e) => setPw(e.target.value)}
            style={{ width: "100%", fontSize: 16, marginBottom: 8 }} />
          <label htmlFor="again-pw" className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>Again</label>
          <input id="again-pw" type="password" autoComplete="new-password" value={again}
            disabled={pending} onChange={(e) => setAgain(e.target.value)}
            style={{ width: "100%", fontSize: 16, marginBottom: 10 }} />
          <div className="row-2" style={{ flexWrap: "nowrap" }}>
            <button className="btn sm accent" type="submit" disabled={pending || !pw || !again}>
              {pending ? "Saving..." : hasPassword ? "Change it" : "Set it"}
            </button>
            <button className="btn sm" type="button" disabled={pending}
              onClick={() => { setOpen(false); setPw(""); setAgain(""); setError(""); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row-2">
          <span className="t-small">
            {hasPassword ? "A password is set." : "No password set - you sign in by code."}
          </span>
          <button className="btn sm" onClick={() => setOpen(true)}>
            {hasPassword ? "Change password" : "Set a password"}
          </button>
          {hasPassword && (
            <button className="btn link t-small" style={{ color: "var(--t-bad-fg)" }} disabled={pending}
              onClick={async () => {
                if (!(await confirmDialog({
                  title: "Remove your password?",
                  body: "Codes by email keep working as they always did.",
                  action: "Remove password", tone: "bad",
                }))) return;
                startTransition(async () => {
                  await clearMyPassword();
                  toast({ message: "Removed the password" });
                  setMsg("Password removed - codes still work as they always did.");
                });
              }}>Remove</button>
          )}
        </div>
      )}

      {msg && <div className="t-small" style={{ color: "var(--t-good-fg)", marginTop: 8 }}>{msg}</div>}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
