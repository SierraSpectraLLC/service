"use client";

import { useState, useTransition } from "react";
import { recordCoverage, removeCoverage } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

/**
 * Recording that somebody else covers this machine.
 *
 * It lives on the record rather than on a settings screen because this is
 * where the gap is noticed: a client reading "No service contract on file"
 * under their own instrument is exactly the person who knows it is covered by
 * the manufacturer, and asking them to go and find an agreements form is
 * asking them not to bother.
 *
 * Never our own contracts. Those are the commercial relationship and they are
 * written on the agreements screen by staff - the server refuses this door for
 * them whatever the form sends, and the note below says so plainly rather than
 * letting somebody discover it by being rejected.
 */
export default function CoverageRecorder({
  instrumentId, operatorName, existingId, existingProvider,
}: {
  instrumentId: number;
  operatorName: string;
  /** The third-party row currently on this system, when there is one. */
  existingId?: number | null;
  existingProvider?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const [f, setF] = useState({
    providerName: "", title: "", number: "", startsOn: "", endsOn: "",
    visitsIncluded: "", partsAllowance: "", laborIncludedHours: "", note: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const save = () => {
    if (f.providerName.trim().length < 2) { setError("Say who provides the service"); return; }
    setError("");
    start(async () => {
      const res = await recordCoverage({ instrumentId, ...f });
      if (res?.error) setError(res.error);
      else {
        setOpen(false);
        toast({ message: `Recorded ${f.providerName.trim()} coverage` });
        setF({ ...f, providerName: "", title: "", number: "", startsOn: "", endsOn: "", note: "" });
      }
    });
  };

  const drop = async () => {
    if (!existingId) return;
    const ok = await confirmDialog({
      title: "Take this coverage off the record?",
      body: `${existingProvider || "This company"}'s contract stops being shown against this system. Nothing else about the record changes.`,
      action: "Remove it",
      tone: "bad",
    });
    if (!ok) return;
    start(async () => {
      const res = await removeCoverage(existingId);
      if (res?.error) toast({ message: res.error, tone: "bad" });
      else toast({ message: "Coverage removed" });
    });
  };

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
      <button className="btn sm" onClick={() => { setOpen(true); setError(""); }}>
        {existingId ? "Record another contract" : "Record who covers this"}
      </button>
      {existingId && (
        <button className="btn sm link danger" onClick={drop} disabled={busy}>Remove</button>
      )}

      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Who covers this system?"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={busy}>
                {busy ? "Saving..." : "Record it"}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Who provides the service *</label>
              <input value={f.providerName} onChange={set("providerName")}
                placeholder="Agilent, Thermo, the manufacturer…" />
            </div>
            <div>
              <label>Contract number</label>
              <input value={f.number} onChange={set("number")} placeholder="Theirs, if you have it" />
            </div>
            <div>
              <label>What it is called</label>
              <input value={f.title} onChange={set("title")} placeholder="Advantage Gold, full service…" />
            </div>
            <div>
              <label>Starts</label>
              <input value={f.startsOn} onChange={set("startsOn")} placeholder="2026-01-01" />
            </div>
            <div>
              <label>Ends</label>
              <input value={f.endsOn} onChange={set("endsOn")} placeholder="2027-03-01" />
            </div>
            <div>
              <label>Visits included</label>
              <input value={f.visitsIncluded} onChange={set("visitsIncluded")} placeholder="Leave blank if you don't know" />
            </div>
            <div>
              <label>Parts allowance</label>
              <input value={f.partsAllowance} onChange={set("partsAllowance")} placeholder="$2,500" />
            </div>
            <div>
              <label>Labor hours included</label>
              <input value={f.laborIncludedHours} onChange={set("laborIncludedHours")} placeholder="40" />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label className="t-small">Anything worth remembering</label>
            <textarea value={f.note} onChange={set("note")} rows={2}
              placeholder="Renews automatically unless cancelled 90 days out" />
          </div>
          <div className="mut t-meta">
            {/* Said before the attempt rather than discovered through a
                refusal. The other door is the agreements screen. */}
            This records a contract <b>somebody else</b> holds, against this system only.
            It changes nothing about what {operatorName} bills — {operatorName}&apos;s own
            agreements are written on the agreements screen.
          </div>
        </Dialog>
      )}
    </div>
  );
}
