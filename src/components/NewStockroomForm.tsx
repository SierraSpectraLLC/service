"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createStockroom } from "@/app/actions";
import { KIND_LABEL, STOCK_KINDS } from "@/lib/stock";

export default function NewStockroomForm({ orgOptions, isHouse, myOrgName }: {
  orgOptions: { id: number; name: string }[];
  isHouse: boolean;
  myOrgName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", kind: "shop", orgId: 0, keeper: "", location: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button className="btn sm primary" onClick={() => setOpen(!open)}>{open ? "Cancel" : "+ New stockroom"}</button>
      {open && (
        <div className="dash-form" style={{ marginTop: 10 }}>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Name *</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Main shelf / Bill's van / Acme cage" />
            </div>
            <div>
              <label>Kind</label>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {STOCK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>
            {isHouse ? (
              <div>
                <label>Belongs to</label>
                <select value={draft.orgId} onChange={(e) => setDraft({ ...draft, orgId: parseInt(e.target.value) })}>
                  <option value={0}>Us (the house)</option>
                  {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <label>Belongs to</label>
                <input value={myOrgName} readOnly style={{ background: "#F4F6F9" }} />
              </div>
            )}
            {draft.kind === "mobile" && (
              <div>
                <label>Kept by</label>
                <input value={draft.keeper} onChange={(e) => setDraft({ ...draft, keeper: e.target.value })} placeholder="Whose van" />
              </div>
            )}
            <div>
              <label>Location</label>
              <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Bay 2 / client site" />
            </div>
          </div>
          <button className="btn sm accent" disabled={pending || !draft.name.trim()}
            onClick={() => startTransition(async () => {
              const res = await createStockroom({ ...draft, orgId: draft.orgId || null });
              if (res?.error) { setError(res.error); return; }
              setOpen(false);
              setDraft({ name: "", kind: "shop", orgId: 0, keeper: "", location: "" });
              if (res.id) router.push(`/stock/${res.id}`);
            })}>{pending ? "Creating..." : "Create"}</button>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </>
  );
}
