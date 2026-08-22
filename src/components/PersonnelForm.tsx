"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  updateSettings, addOrg,
  removeClientAccess, setClientAccessOrg,
} from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { DataTable, FacetStrip, Panel, Pill, SaveBar, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      style={{ width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? "var(--coral)" : "var(--line)", position: "relative", flexShrink: 0, padding: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 120ms" }} />
    </button>
  );
}

type OrgRow = {
  id: number; name: string; kind: string; themeColor: string;
  systems: number; logins: number; editors: number; recipients: string;
};
type PersonRow = { name: string; email: string; org: string };
type OrphanRow = { id: number; entry: string };

/**
 * Who is on this instance. Organizations are a directory here - each one's own
 * settings live on its own page, because an organization has enough to configure
 * (its look, its people, its recipients) that a shared list can't hold it, and
 * because that page is also the one an organization's own editors use.
 */
export default function PersonnelForm(props: {
  clientAccessEnabled: boolean;
  orgs: OrgRow[]; orphans: OrphanRow[];
  /** Platform staff, who can open a workspace for a service company. */
  isPlatform: boolean;
  /** Everyone with a login this viewer may see - read only, assembled not curated. */
  directory: PersonRow[];
  operatorOrgId: number | null; sheetOrgId: number | null;
  showRecipients: boolean; showSheetSync: boolean;
  /** From the URL, so a filtered list is a link. */
  filter?: { q: string; kind: string };
}) {
  const [view, setView] = useState(props.clientAccessEnabled);
  const [saved, setSaved] = useState(props.clientAccessEnabled);
  const [barMsg, setBarMsg] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const dirty = view !== saved;

  const q = (props.filter?.q ?? "").trim();
  const kindSel = props.filter?.kind ?? "";
  const needle = q.toLowerCase();
  const shownOrgs = props.orgs.filter((o) =>
    (!kindSel || o.kind === kindSel) && (!needle || o.name.toLowerCase().includes(needle)));
  const orgHref = (k: string) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (k) p.set("kind", k);
    return `/settings/organizations${p.size ? `?${p}` : ""}`;
  };

  const [orgDraft, setOrgDraft] = useState({ name: "", kind: "client" });
  const [orgError, setOrgError] = useState("");
  const submitOrg = () => {
    if (!orgDraft.name.trim()) return;
    setOrgError("");
    startTransition(async () => {
      const res = await addOrg(orgDraft.name, orgDraft.kind);
      if (res?.error) setOrgError(res.error);
      else {
        toast({ message: `Added ${orgDraft.name.trim()}` });
        setOrgDraft({ name: "", kind: orgDraft.kind });
      }
    });
  };

  return (
    <>
      <Panel title="Organizations" count={props.orgs.length}
        hint={<>Companies inside this workspace. A client owns systems; a provider services them. Each sees only
          what&apos;s shared with it, and neither runs a workspace of its own - a service company that needs
          its own staff, catalog and clients is set up in{" "}
          {props.isPlatform ? <Link href="/settings/tenants">Service providers</Link> : <b>Service companies</b>}{" "}
          instead. Open one to set its look, its people and where its reports go.</>}>

        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "2px 0 10px" }}>
          <Toggle on={view} label="Client sign-in" onClick={() => { setView(!view); setBarMsg(""); }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Client sign-in</div>
            <div className="mut" style={{ fontSize: 11 }}>Master switch. Off blocks every non-staff sign-in, whatever each organization&apos;s list says.</div>
          </div>
        </div>

        <Toolbar
          search={
            <form action="/settings/organizations">
              {kindSel && <input type="hidden" name="kind" value={kindSel} />}
              <input name="q" defaultValue={q} placeholder="Organization name" aria-label="Search organizations" />
            </form>
          }
          facets={
            <FacetStrip facets={(["client", "provider"] as const).map((k) => ({
              key: k, label: k === "client" ? "Clients" : "Providers",
              count: props.orgs.filter((o) => o.kind === k).length || undefined,
              on: kindSel === k, href: orgHref(kindSel === k ? "" : k),
            }))} />
          }
        />
        <DataTable
          cols={[
            { key: "name", label: "Organization", width: "minmax(160px, 1.6fr)" },
            { key: "kind", label: "Kind", width: "90px" },
            { key: "flags", label: "", width: "minmax(90px, 0.8fr)", hideMobile: true },
            { key: "reach", label: "Reach", width: "minmax(160px, 1.2fr)", align: "right", hideMobile: true },
          ]}
          rows={shownOrgs.map((o): DataRow => ({
            key: o.id,
            href: `/settings/organizations/${o.id}`,
            cells: {
              name: (
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {/* Their header color, so the list looks like the workspaces do. */}
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background: o.themeColor || "var(--line)" }} />
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{o.name}</span>
                </span>
              ),
              kind: <Pill tone={o.kind === "provider" ? "warn" : "info"}>{o.kind}</Pill>,
              flags: (
                <span className="mut" style={{ fontSize: 11 }}>
                  {[props.operatorOrgId === o.id ? "operator" : "",
                    props.showSheetSync && props.sheetOrgId === o.id ? "sheet sync" : ""].filter(Boolean).join(" · ")}
                </span>
              ),
              reach: (
                <span className="mut" style={{ fontSize: 11 }}>
                  {o.systems} system{o.systems === 1 ? "" : "s"} ·{" "}
                  {o.logins === 0
                    ? "nobody can sign in"
                    : `${o.logins} sign-in${o.logins === 1 ? "" : "s"}${o.editors ? `, ${o.editors} can edit` : ""}`}
                  {props.showRecipients && !o.recipients.trim() && " · no report recipients"}
                </span>
              ),
            },
          }))}
          empty="None yet - add one, then share systems with it from each system's page"
        />

        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input value={orgDraft.name} onChange={(e) => setOrgDraft({ ...orgDraft, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitOrg(); }}
            placeholder="New organization name" style={{ flex: "1 1 160px", fontSize: 13 }} />
          <select value={orgDraft.kind} onChange={(e) => setOrgDraft({ ...orgDraft, kind: e.target.value })}
            style={{ width: "auto", fontSize: 12 }}>
            <option value="client">client - owns systems</option>
            <option value="provider">provider - services them</option>
          </select>
          <button className="btn sm accent" onClick={submitOrg} disabled={pending || !orgDraft.name.trim()}>Add</button>
        </div>
        {orgError && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 6 }}>{orgError}</div>}
      </Panel>

      {/* A sign-in with no organization has no scope, so it can't sign in at all. */}
      {props.orphans.length > 0 && (
        <div className="card" style={{ borderColor: "#EAD9B0", background: "#FDF8EE" }}>
          <div className="card-title" style={{ color: "var(--t-warn-fg)" }}>Sign-ins with no organization</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            These cannot sign in until they name one - a login with no organization has nothing to see.
          </div>
          {props.orphans.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12 }}>{r.entry}</span>
              <select defaultValue="" disabled={pending} aria-label={`Organization for ${r.entry}`}
                onChange={(e) => { const v = parseInt(e.target.value); if (v) startTransition(async () => { await setClientAccessOrg(r.id, v); }); }}
                style={{ width: "auto", fontSize: 11, padding: "1px 4px" }}>
                <option value="">choose an organization</option>
                {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <button className="btn link" style={{ marginLeft: "auto", color: "var(--t-bad-fg)", fontSize: 11 }} disabled={pending}
                onClick={async () => {
                  if (!(await confirmDialog({ title: `Remove ${r.entry}?`, action: `Remove ${r.entry}`, tone: "bad" }))) return;
                  setError("");
                  startTransition(async () => {
                    await removeClientAccess(r.id);
                    toast({ message: `Removed ${r.entry}` });
                  });
                }}>remove</button>
            </div>
          ))}
          {error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </div>
      )}

      {/* Read-only on purpose. There is no roster to curate any more: a person
          is a login, so this is a window onto the ones that exist rather than a
          second list to keep in step with them. People are added where they get
          their access - the house in Admin, an organization on its own page. */}
      <Panel title="Directory" count={props.directory.length}
        hint={<>Everyone tasks can be assigned to and @mentions can reach. Add somebody by giving them a login:
          your own people in <a href="/settings/admin">Admin</a>, a client&apos;s on their organization&apos;s page.</>}>
        {props.directory.map((p) => (
          <div key={p.email} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
            {p.org && <span className="pill neutral">{p.org}</span>}
            <span className="mut mono" style={{ fontSize: 11, marginLeft: "auto" }}>{p.email}</span>
          </div>
        ))}
        {props.directory.length === 0 && <div className="mut" style={{ fontSize: 12 }}>Nobody has a login yet.</div>}
      </Panel>

      <SaveBar dirty={dirty} saving={pending} message={barMsg}
        onSave={() => startTransition(async () => {
          await updateSettings({ clientAccessEnabled: view });
          setSaved(view);
          setBarMsg(`Client sign-in turned ${view ? "on" : "off"}`);
        })}
        onDiscard={() => setView(saved)}
      />
    </>
  );
}
