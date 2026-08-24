"use client";

import { useState, useTransition } from "react";
import { addOrgSite, archiveOrgSite, setOrgBillingAddress, updateOrgSite } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { addressLine, siteLabel } from "@/lib/sites";
import AddressField from "@/components/AddressField";

export type SiteRow = {
  id: number; name: string; address: string; accessNotes: string;
  contactName: string; contactPhone: string; contactEmail: string; archived: boolean;
  /** One-way road miles from the shop. 0 = never measured. */
  onewayMiles: number;
  /** How many systems are installed here - what makes closing one a real decision. */
  systems: number;
};

const emptySite = { name: "", address: "", accessNotes: "", contactName: "", contactPhone: "", contactEmail: "", onewayMiles: "" };

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
      contactName: s.contactName, contactPhone: s.contactPhone, contactEmail: s.contactEmail,
      onewayMiles: s.onewayMiles ? String(s.onewayMiles) : "",
    });
    setError(""); setSheet({ id: s.id });
  };

  // The first unmet requirement, in plain words, live in the footer.
  const problem = !draft.name.trim() && !draft.address.trim() ? "give it a name or an address" : null;

  const save = () => {
    setError("");
    startTransition(async () => {
      const res = sheet?.id ? await updateOrgSite(sheet.id, draft) : await addOrgSite(orgId, draft);
      if (res?.error) { setError(res.error); return; }
      toast({ message: sheet?.id ? "Saved the site" : "Added the site" });
      setSheet(null);
    });
  };

  const row = (s: SiteRow) => (
    <div key={s.id} style={{
      border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", marginBottom: 8,
      opacity: s.archived ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span className="t-body" style={{ fontWeight: 700 }}>{siteLabel(s)}</span>
        {s.systems > 0 && (
          <span className="pill info">
            {s.systems} system{s.systems === 1 ? "" : "s"}
          </span>
        )}
        {s.archived && <span className="pill faint">closed</span>}
        {canEdit && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn link" onClick={() => openEdit(s)}>edit</button>
            <button className="btn link" disabled={pending}
              onClick={() => startTransition(async () => { await archiveOrgSite(s.id, !s.archived); toast({ message: s.archived ? "Reopened the site" : "Closed the site" }); })}>
              {s.archived ? "reopen" : "close"}
            </button>
          </span>
        )}
      </div>
      {s.address && <div className="mut t-small">{addressLine(s.address)}{s.onewayMiles > 0 ? ` · ${s.onewayMiles} mi` : ""}</div>}
      {(s.contactName || s.contactPhone) && (
        <div className="mut" style={{ fontSize: 12 }}>
          {[s.contactName, s.contactPhone, s.contactEmail].filter(Boolean).join(" · ")}
        </div>
      )}
      {/* Plain text, like the address above it: these are directions, not a
          warning, and the amber block read as the latter. */}
      {s.accessNotes && (
        <div style={{ marginTop: 6 }}>
          <div className="eyebrow" style={{ marginBottom: 2 }}>Getting in</div>
          <div className="t-small" style={{ whiteSpace: "pre-wrap" }}>{s.accessNotes}</div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Billing address</div>
        <div className="mut t-small" style={{ marginBottom: 8 }}>
          Where {orgName}&apos;s invoices go. One per company - the labs are below.
        </div>
        <textarea value={billing} rows={4} disabled={!canEdit || pending}
          onChange={(e) => { setBilling(e.target.value); setBillingMsg(""); }}
          placeholder={"Accounts Payable\n123 Cedar St, Suite 400\nReno NV 89501"}
          className="t-body" style={{ width: "100%", marginBottom: 6 }} />
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
          <span className="t-small" style={{ marginLeft: 8, color: billingMsg === "Saved ✓" ? "#2E6B2E" : "#A32D2D" }}>
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
        <div className="mut t-small" style={{ marginBottom: 10 }}>
          Where the instruments actually are, and everything a tech needs before driving
          there. A system points at one of these.
        </div>

        {live.map(row)}
        {live.length === 0 && (
          <div className="mut t-body">No sites yet.</div>
        )}
        {closed.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, padding: "6px 0" }}>
              <b>Closed</b> <span className="mut">· {closed.length}</span>
            </summary>
            {closed.map(row)}
          </details>
        )}
        {error && !sheet && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
      </div>

      {sheet && (
        <Dialog open onClose={() => setSheet(null)} title={sheet.id ? "Edit site" : "New site"}
          context={orgName}
          footer={
            <>
              <DialogStatus error={error} problem={problem} />
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Saving..."
                  : sheet.id
                    ? (draft.name.trim() ? `Save ${draft.name.trim()}` : "Save site")
                    : (draft.name.trim() ? `Add ${draft.name.trim()}` : "Add site")}
              </button>
            </>
          }>
            <div className="dialog-section">Where it is</div>
            <label>Name</label>
            <input value={draft.name} autoFocus placeholder="Building 4 lab"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ marginBottom: 8 }} />

            <label>Address</label>
            {/* Pick, don't type: a chosen suggestion is Google's own formatted
                address, and those always geocode - which is what the routed
                miles and the directions link stand on. Plain typing still
                works, and is all there is without a browser key. */}
            <div style={{ marginBottom: 8 }}>
              <AddressField value={draft.address} ariaLabel="Site address"
                placeholder="123 Cedar St, Suite 400, Reno NV 89501"
                onChange={(address) => setDraft({ ...draft, address })} />
            </div>

            <label>Distance from the shop</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input value={draft.onewayMiles} inputMode="numeric" placeholder="140" style={{ width: 90 }}
                onChange={(e) => setDraft({ ...draft, onewayMiles: e.target.value.replace(/[^0-9]/g, "") })} />
              <span className="mut t-small">road miles one-way - prefills the travel rules on a work order here</span>
            </div>

            <div className="dialog-section">Who to ask for</div>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Contact</label>
                <input value={draft.contactName} placeholder="Rita, front desk"
                  onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
              </div>
              <div>
                <label>Phone</label>
                <input value={draft.contactPhone} placeholder="775-555-0143"
                  onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />
              </div>
              <div>
                <label>Email</label>
                {/* The en-route email's recipient: who to tell we are coming. */}
                <input type="email" value={draft.contactEmail} placeholder="rita@labzen.com"
                  onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
              </div>
            </div>

            <div className="dialog-section">Getting in</div>
            <textarea value={draft.accessNotes} rows={3} style={{ width: "100%", marginBottom: 4 }}
              placeholder={"Parking garage on Cedar, $30/day - street parking is 2hr only.\nLoading dock round the back, badge needed."}
              onChange={(e) => setDraft({ ...draft, accessNotes: e.target.value })} />
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              The part nobody writes down and everybody needs at 7am. Shown on every system
              installed here.
            </div>

        </Dialog>
      )}
    </>
  );
}
