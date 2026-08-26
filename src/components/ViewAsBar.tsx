"use client";

import { useState, useTransition } from "react";
import { setViewAs, setViewAsPerson } from "@/app/actions";
import { toast } from "@/components/ui/Toast";

type OrgOption = { id: number; name: string; kind: string };
export type PersonOption = { email: string; name: string; role: string; orgName: string };

const ROLE_WORD: Record<string, string> = {
  owner: "owner", staff: "staff",
  client_editor: "editor", client_viewer: "read-only",
};

/**
 * The owner's "view as" control. Collapsed it is one link in the header; while
 * a persona is active it becomes a banner that cannot be missed, because every
 * hidden menu and 404 from here on is the persona's doing rather than a bug.
 *
 * Two things can be stood in, and the banner says which - the difference is
 * whether writing is allowed, and getting that wrong in either direction is
 * expensive. A ROLE is a shape and stays writable, recorded as the operator. A
 * PERSON is an identity, which is the only way to reach their saved layout,
 * their assigned work and their own read state - and it is read-only, so
 * reproducing somebody's screen can never act in their name.
 */
export default function ViewAsBar({ orgs, people, active }: {
  orgs: OrgOption[];
  people?: PersonOption[];
  active: { kind: string; orgName: string; role: string; name: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"editor" | "viewer">("editor");
  const [pending, startTransition] = useTransition();

  const enter = (orgId: number) => startTransition(async () => { await setViewAs(orgId, mode); setOpen(false); });
  const beSomebody = (email: string) => startTransition(async () => {
    const res = await setViewAsPerson(email);
    if (res?.error) toast({ message: res.error, tone: "bad" });
    else setOpen(false);
  });
  const exit = () => startTransition(async () => { await setViewAs(null); });

  if (active) {
    const person = active.kind === "person";
    return (
      <div style={{ background: "var(--t-warn-bg)", borderBottom: "1px solid #EAD9B0", color: "var(--t-warn-fg)" }}>
        <div className="container row-3" style={{ paddingTop: 7, paddingBottom: 7 }}>
          <span className="t-small" style={{ fontWeight: 700 }}>
            {person
              ? `Viewing as ${active.name} · ${ROLE_WORD[active.role] ?? active.role}${active.orgName ? ` · ${active.orgName}` : ""}`
              : `Viewing as ${active.orgName} · ${ROLE_WORD[active.role] ?? active.role}`}
          </span>
          <span className="t-meta" style={{ opacity: 0.85 }}>
            {person
              // Said plainly, because the first thing somebody tries in this
              // mode is a button, and a refusal with no warning reads as
              // another bug on top of the one being chased.
              ? "Their screen, read-only. Nothing can be changed from here."
              : "Anything you change is still recorded as you."}
          </span>
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending} onClick={exit}>
            {pending ? "Leaving..." : "Back to superuser"}
          </button>
        </div>
      </div>
    );
  }

  if (!orgs.length && !people?.length) return null;

  return (
    <>
      {!open ? (
        <button className="btn sm" onClick={() => setOpen(true)}>View as...</button>
      ) : (
        <span className="row-2" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center" }}>
          {/* One named person, grouped by the company they work for - which is
              how somebody actually looks for Bill. */}
          {people && people.length > 0 && (
            <select defaultValue="" disabled={pending} className="t-small" style={{ width: "auto" }}
              aria-label="Person to view as"
              onChange={(e) => { if (e.target.value) beSomebody(e.target.value); }}>
              <option value="">a person…</option>
              {[...new Set(people.map((p) => p.orgName))].sort().map((org) => (
                <optgroup key={org} label={org}>
                  {people.filter((p) => p.orgName === org).map((p) => (
                    <option key={p.email} value={p.email}>
                      {p.name} · {ROLE_WORD[p.role] ?? p.role}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {orgs.length > 0 && (
            <>
              <select value={mode} onChange={(e) => setMode(e.target.value as "editor" | "viewer")}
                aria-label="Permission level to view as" className="t-small" style={{ width: "auto" }}>
                <option value="editor">as editor</option>
                <option value="viewer">as read-only</option>
              </select>
              {orgs.map((o) => (
                <button key={o.id} className="btn sm" disabled={pending} onClick={() => enter(o.id)}>
                  {o.name}
                </button>
              ))}
            </>
          )}
          <button className="btn sm" onClick={() => setOpen(false)}>cancel</button>
        </span>
      )}
    </>
  );
}
