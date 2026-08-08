"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestAccess, createSystemFromSerial } from "@/app/actions";
import PickOrAdd from "./PickOrAdd";

/**
 * The knock on the door: the serial matched a system in someone else's
 * workspace. Nothing about the owner is shown; the request goes to whoever
 * can decide (staff or the owning organization's editors).
 */
export function RequestAccessCard({ serial, assetDesc, requested }: {
  serial: string; assetDesc: string; requested: boolean;
}) {
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sent">(requested ? "sent" : "idle");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>{assetDesc}</div>
      <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>
        This unit sits on a system in another workspace. You can ask its owner for access.
      </div>
      {state === "sent" ? (
        <div style={{ marginTop: 8 }}>
          <span className="pill" style={{ background: "#FAF0DC", color: "#8A5410" }}>Requested</span>
          <span className="mut" style={{ fontSize: 12, marginLeft: 6 }}>Waiting on the owner. The system appears on your dashboard if they approve.</span>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Who you are and why you're asking, e.g. &quot;We service this instrument for Acme Labs.&quot;"
            style={{ resize: "vertical", fontSize: 13 }} />
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 4 }}>{error}</div>}
          <button className="btn sm accent" style={{ marginTop: 6 }} disabled={pending}
            onClick={() => {
              setError("");
              startTransition(async () => {
                const res = await requestAccess(serial, message);
                if (res?.error) setError(res.error);
                else setState("sent");
              });
            }}>
            {pending ? "Sending..." : "Request access"}
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
export function CreateSystemForm({ serial, kinds }: { serial: string; kinds: string[] }) {
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
        Start its service record here. It goes into your workspace; if the owner joins the platform later, Sierra Spectra can hand the system over to them.
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
          <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="e.g. LC-MS" />
        </div>
      </div>
      <div className="pf3" style={{ marginBottom: 8 }}>
        <div>
          <label>Unit type *</label>
          <PickOrAdd value={draft.kind} options={kinds} newLabel="+ Other..." placeholder="e.g. Mass spec"
            onChange={(kind) => setDraft({ ...draft, kind })} />
        </div>
        <div>
          <label>Model</label>
          <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="LCMS-8050" />
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
