"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createStockroom } from "@/app/actions";
import { KIND_LABEL, STOCK_KINDS } from "@/lib/stock";
import Dialog from "@/components/ui/Dialog";
import KeeperPicker from "@/components/KeeperPicker";
import { toast } from "@/components/ui/Toast";

const BLANK = { name: "", kind: "shop", orgId: 0, keeper: "", keeperEmail: "", location: "" };

export default function NewStockroomForm({ orgOptions, isHouse, myOrgName, roster }: {
  orgOptions: { id: number; name: string }[];
  isHouse: boolean;
  myOrgName: string;
  /** This workspace's people, so a van can be handed to one of them by name. */
  roster: { email: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // A dialog, not an inline form: the trigger lives in the page header, and a
  // form unfolding inside a header's action cluster floats in dead space.
  return (
    <>
      <button className="btn sm primary" onClick={() => setOpen(!open)}>+ New stockroom</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New stockroom"
        footer={
          <>
            <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn accent" disabled={pending || !draft.name.trim()}
              onClick={() => startTransition(async () => {
                const res = await createStockroom({ ...draft, orgId: draft.orgId || null });
                if (res?.error) { setError(res.error); return; }
                setOpen(false);
                setDraft(BLANK);
                toast({ message: `Created ${draft.name.trim()}` });
                if (res.id) router.push(`/stock/${res.id}`);
              })}>{pending ? "Creating..." : "Create stockroom"}</button>
          </>
        }>
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
            {/* Only a van or field kit is somebody's. A shop shelf belongs to
                the shop, and a client's cage to the client. */}
            {draft.kind === "mobile" && (
              <KeeperPicker roster={roster} disabled={pending}
                value={{ keeper: draft.keeper, keeperEmail: draft.keeperEmail }}
                onChange={(k) => setDraft({ ...draft, ...k })} />
            )}
            <div>
              <label>Location</label>
              <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Bay 2 / client site" />
            </div>
          </div>
      </Dialog>
    </>
  );
}
