"use client";

import { useState, useTransition } from "react";
import { setViewAs } from "@/app/actions";

type OrgOption = { id: number; name: string; kind: string };

/**
 * The owner's "view as" control. Collapsed it is one link in the header; while
 * a persona is active it becomes a banner that cannot be missed, because every
 * hidden menu and 404 from here on is the persona's doing rather than a bug.
 */
export default function ViewAsBar({ orgs, active }: {
  orgs: OrgOption[];
  active: { orgName: string; role: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"editor" | "viewer">("editor");
  const [pending, startTransition] = useTransition();

  const enter = (orgId: number) => startTransition(async () => { await setViewAs(orgId, mode); setOpen(false); });
  const exit = () => startTransition(async () => { await setViewAs(null); });

  if (active) {
    return (
      <div style={{ background: "var(--t-warn-bg)", borderBottom: "1px solid #EAD9B0", color: "var(--t-warn-fg)" }}>
        <div className="container row-3" style={{ paddingTop: 7, paddingBottom: 7 }}>
          <span className="t-small" style={{ fontWeight: 700 }}>
            Viewing as {active.orgName} · {active.role === "client_viewer" ? "read-only" : "editor"}
          </span>
          <span className="t-meta" style={{ opacity: 0.85 }}>Anything you change is still recorded as you.</span>
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending} onClick={exit}>
            {pending ? "Leaving..." : "Back to superuser"}
          </button>
        </div>
      </div>
    );
  }

  if (!orgs.length) return null;

  return (
    <>
      {!open ? (
        <button className="btn sm" onClick={() => setOpen(true)}>View as...</button>
      ) : (
        <span className="row-2" style={{ display: "inline-flex" }}>
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
          <button className="btn sm" onClick={() => setOpen(false)}>cancel</button>
        </span>
      )}
    </>
  );
}
