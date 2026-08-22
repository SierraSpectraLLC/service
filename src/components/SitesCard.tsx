"use client";

import { useState, useTransition } from "react";
import { addOrgSite, archiveOrgSite, setOrgBillingAddress, updateOrgSite } from "@/app/actions";
import { addressLine, siteLabel } from "@/lib/sites";

export type SiteRow = {
  id: number; name: string; address: string; accessNotes: string;
  contactName: string; contactPhone: string; archived: boolean;
  /** How many systems are installed here - what makes closing one a real decision. */
  systems: number;
};

const emptySite = { name: "", address: "", accessNotes: "", contactName: "", contactPhone: "" };

/**
 * Where the invoice goes, and where the instruments are.
 *
 * Two cards rather than one, because they are two different facts. Billing is a
 * single address on the company; sites are a list, because a client can have
 * three labs and a system lives at exactly one of them.
 *
 * The access notes field is the one that earns the whole feature: the parking
 * garage, the loading dock, who to ask for at the desk. It belongs to a
 * BUILDING, so it is here rather than on the company - where it would be noise
 * on an invoice screen and wrong the day they open a second lab.
 */
export default function SitesCard({ orgId, orgName, billingAddress, sites, canEdit }: {
  orgId: number;
  orgName: string;
  billingAddress: string;
  sites: SiteRow[];
  canEdit: boolean;
}) {
  const [billing, setBilling] = useState(billingAddress);
  const [billingMsg, setBillingMsg] = useState("");
  const [sheet, setSheet] = useState<null | { id?: number }>(null);
  const [draft, setDraft] = useState(emptySite);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const live = sites.filter((s) => !s.archived);
  const closed = sites.filter((s) => s.archived);

  const openEdit = (s: SiteRow) => {
    setDraft({
      name: s.name, address: s.address, accessNotes: s.accessNotes,
      contactName: s.contactName, contactPhone: s.contactPhone,
    });
    setError(""); setSheet({ id: s.id });
  };

  const save = () => {
    if (!draft.name.trim() && !draft.address.trim()) { setError("Give it a name or an address"); return; }
    setError("");
    startTransition(async () => {
      const res = sheet?.id ? await updateOrgSite(sheet.id, draft) : await addOrgSite(orgId, draft);
      if (res?.error) { setError(res.error); return; }
      setSheet(null);
    });
  };

  const row = (s: SiteRow) => (
    <div key={s.id} style={{
      border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", marginBottom: 8,
      opacity: s.archived ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{siteLabel(s)}</span>
        {s.systems > 0 && (
          <span className="pill info">
            {s.systems} system{s.systems === 1 ? "" : "s"}
          </span>
        )}
        {s.archived && <span className="pill faint">closed</span>}
        {canEdit && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn link" style={{ fontSize: 11 }} onClick={() => openEdit(s)}>edit</button>
            <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
              onClick={() => startTransition(async () => { await archiveOrgSite(s.id, !s.archived); })}>
              {s.archived ? "reopen" : "close"}
            </button>
          </span>
        )}
      </div>
      {s.address && <div className="mut" style={{ fontSize: 12 }}>{addressLine(s.address)}</div>}
      {(s.contactName || s.contactPhone) && (
        <div className="mut" style={{ fontSize: 11.5 }}>
          {[s.contactName, s.contactPhone].filter(Boolean).join(" · ")}
        </div>
      )}
      {/* Plain text, like the address above it: these are directions, not a
          warning, and the amber block read as the latter. */}
      {s.accessNotes && (
        <div style={{ marginTop: 6 }}>
          <div className="eyebrow" style={{ marginBottom: 2 }}>Getting in</div>
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{s.accessNotes}</div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Billing address</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
          Where {orgName}&apos;s invoices go. One per company - the labs are below.
        </div>
        <textarea value={billing} rows={4} disabled={!canEdit || pending}
          onChange={(e) => { setBilling(e.target.value); setBillingMsg(""); }}
          placeholder={"Accounts Payable\n123 Cedar St, Suite 400\nReno NV 89501"}
          style={{ width: "100%", fontSize: 13, marginBottom: 6 }} />
        {canEdit && (
          <button className="btn sm" disabled={pending || billing === billingAddress}
            onClick={() => startTransition(async () => {
              const res = await setOrgBillingAddress(orgId, billing);
              setBillingMsg(res?.error ?? "Saved ✓");
            })}>
            Save
          </button>
        )}
        {billingMsg && (
          <span style={{ fontSize: 12, marginLeft: 8, color: billingMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>
            {billingMsg}
          </span>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <div className="card-title">Sites</div>
          {canEdit && (
            <button className="btn sm primary" style={{ marginLeft: "auto" }}
              onClick={() => { setDraft(emptySite); setError(""); setSheet({}); }}>
              ＋ Site
            </button>
          )}
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Where the instruments actually are, and everything a tech needs before driving
          there. A system points at one of these.
        </div>

        {live.map(row)}
        {live.length === 0 && (
          <div className="mut" style={{ fontSize: 13 }}>No sites yet.</div>
        )}
        {closed.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", fontSize: 12.5, padding: "6px 0" }}>
              <b>Closed</b> <span className="mut">· {closed.length}</span>
            </summary>
            {closed.map(row)}
          </details>
        )}
        {error && !sheet && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 6 }}>{error}</div>}
      </div>

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Site">
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)", marginBottom: 10 }}>
              {sheet.id ? "Edit" : "New"} site
            </div>

            <label>Name</label>
            <input value={draft.name} autoFocus placeholder="Building 4 lab"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ marginBottom: 8 }} />

            <label>Address</label>
            <textarea value={draft.address} rows={3} style={{ width: "100%", marginBottom: 8 }}
              placeholder={"123 Cedar St, Suite 400\nReno NV 89501"}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })} />

            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Who to ask for</label>
                <input value={draft.contactName} placeholder="Rita, front desk"
                  onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
              </div>
              <div>
                <label>Phone</label>
                <input value={draft.contactPhone} placeholder="775-555-0143"
                  onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />
              </div>
            </div>

            <label>Getting in</label>
            <textarea value={draft.accessNotes} rows={3} style={{ width: "100%", marginBottom: 4 }}
              placeholder={"Parking garage on Cedar, $30/day - street parking is 2hr only.\nLoading dock round the back, badge needed."}
              onChange={(e) => setDraft({ ...draft, accessNotes: e.target.value })} />
            <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
              The part nobody writes down and everybody needs at 7am. Shown on every system
              installed here.
            </div>

            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 4 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
