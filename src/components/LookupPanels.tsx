"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestAccess, createSystemFromSerial } from "@/app/actions";
import CatalogSelect from "./CatalogSelect";

/**
 * The knock on the door: the serial matched a system in someone else's
 * workspace. Nothing about the owner is shown; the request goes to whoever
 * can decide (staff or the owning organization's editors).
 */
export function RequestAccessCard({ serial, assetDesc, requested, canClaim }: {
  serial: string; assetDesc: string; requested: boolean;
  /** Client organizations can assert the instrument is theirs; providers can't. */
  canClaim: boolean;
}) {
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"access" | "claim">("access");
  const [state, setState] = useState<"idle" | "sent">(requested ? "sent" : "idle");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const claiming = canClaim && kind === "claim";

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>{assetDesc}</div>
      {state === "sent" ? (
        <div style={{ marginTop: 8 }}>
          <span className="pill warn">Requested</span>
          <span className="mut" style={{ fontSize: 12, marginLeft: 6 }}>Under review.</span>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {canClaim && (
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }} role="group" aria-label="What you're asking for">
              {([["access", "I need access"], ["claim", "We own this instrument"]] as const).map(([k, lbl]) => (
                <button key={k} className={`btn sm${kind === k ? " accent" : ""}`} aria-pressed={kind === k}
                  onClick={() => setKind(k)}>{lbl}</button>
              ))}
            </div>
          )}
          <textarea rows={claiming ? 3 : 2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={claiming
              ? "How you came to own it - e.g. \"Purchased from Acme Instruments, PO 4471, March 2024.\" Ownership is granted by review, not by knowing the serial."
              : "Who you are and why you're asking, e.g. \"We service this instrument for Acme Labs.\""}
            style={{ resize: "vertical", fontSize: 13 }} />
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 4 }}>{error}</div>}
          <button className="btn sm accent" style={{ marginTop: 6 }} disabled={pending}
            onClick={() => {
              setError("");
              startTransition(async () => {
                const res = await requestAccess(serial, message, claiming ? "claim" : "access");
                if (res?.error) setError(res.error);
                else setState("sent");
              });
            }}>
            {pending ? "Sending..." : claiming ? "Claim ownership" : "Request access"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The no-match path: nobody on the platform has this serial, so the viewer
 * starts the system's record themselves. Created by a service provider it
 * stays unclaimed until the real owner joins and the house hands it over.
 */
export function CreateSystemForm({ serial, kinds, models, categories }: {
  serial: string; kinds: string[];
  models: Record<string, string[]>; categories: string[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", kind: "", model: "", manufacturer: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createSystemFromSerial({ ...draft, serial });
      if (res?.error) { setError(res.error); return; }
      if (res?.id) router.push(`/instruments/${res.id}`);
    });
  };

  return (
    <div className="dash-form" style={{ marginTop: 10, marginBottom: 0 }}>
      <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
        Nobody has this serial yet - create it and start its service record.
      </div>
      <div className="pf3" style={{ marginBottom: 8 }}>
        <div>
          <label>System ID *</label>
          <input className="mono" value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="Your reference, e.g. SP-101" />
        </div>
        <div>
          <label>Owner / site</label>
          <input value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} placeholder="Whose instrument it is" />
        </div>
        <div>
          <label>Category</label>
          <CatalogSelect value={draft.category} options={categories} ariaLabel="System category"
            onChange={(category) => setDraft({ ...draft, category })} />
        </div>
      </div>
      <div className="pf3" style={{ marginBottom: 8 }}>
        <div>
          <label>Unit type *</label>
          <CatalogSelect value={draft.kind} options={kinds} ariaLabel="Unit type"
            onChange={(kind) => setDraft({ ...draft, kind, model: "" })}
            hint="Define module types in Settings → Catalog" />
        </div>
        <div>
          <label>Model</label>
          <CatalogSelect value={draft.model} options={models[draft.kind] ?? []} ariaLabel="Model"
            onChange={(model) => setDraft({ ...draft, model })}
            hint={`No ${draft.kind || "?"} models defined yet - add them in Settings → Catalog`} />
        </div>
        <div>
          <label>Manufacturer</label>
          <input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} placeholder="Shimadzu" />
        </div>
      </div>
      <div className="mut mono" style={{ fontSize: 12, marginBottom: 8 }}>Serial: {serial}</div>
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
      <button className="btn sm accent" onClick={submit} disabled={pending || !draft.externalId.trim() || !draft.kind.trim()}>
        {pending ? "Creating..." : "Create system"}
      </button>
    </div>
  );
}
