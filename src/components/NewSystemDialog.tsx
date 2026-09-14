"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInstrument } from "@/app/actions";
import PickOrAdd from "./PickOrAdd";
import CatalogSelect from "./CatalogSelect";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

/** The three lists the form offers, gathered by whichever page opens it. */
export type NewSystemOptions = {
  /** Client organizations plus the names already typed on systems. */
  clients: string[];
  /** The catalog's system types, plus those in use. */
  categories: string[];
  /** People this reader may hand a system to. Empty hides the picker. */
  people: string[];
};

const BLANK = { externalId: "", client: "", category: "", priority: "", lead: "" };

/**
 * A system on the books: its tag, whose work it is, what kind it is.
 *
 * One dialog for the two rooms that add systems - the board and the registry -
 * so a system entered from either lands the same row with the same fields, and
 * a change to the form is a change to both. The registry had no way to add one
 * at all: the flat list of every system on record was the one page that could
 * not put a system on it.
 *
 * No model or name field, deliberately. A system is named by the assets added
 * on its page (lib/systemLabel), so asking for a name here invites a second
 * spelling of a thing the record can already say for itself.
 */
export default function NewSystemDialog({ clients, categories, people, onClose }: NewSystemOptions & {
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // The first unmet requirement, in plain words, live in the footer.
  const problem = draft.externalId.trim() ? null : "give it a system ID";

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createInstrument({
        externalId: draft.externalId, client: draft.client, category: draft.category,
        priority: parseInt(draft.priority) || 99, lead: draft.lead,
      });
      // A tag already on the books is the one thing somebody typing this in
      // gets wrong, and it arrives as a sentence rather than as a crash.
      if (res.error || res.id === undefined) { setError(res.error ?? "Could not create the system"); return; }
      toast({ message: `Created ${draft.externalId.trim()}` });
      onClose();
      router.push(`/instruments/${res.id}`);
    });
  };

  return (
    <Dialog open onClose={onClose} title="New system"
      context="The system is named by the assets you add on its page."
      footer={
        <>
          <DialogStatus error={error} problem={problem} />
          <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn accent" onClick={submit} disabled={pending || !!problem}>
            {pending ? "Creating..." : "Create system"}
          </button>
        </>
      }>
      <div className="pf3" style={{ marginBottom: 8 }}>
        <div>
          <label>System ID *</label>
          <input value={draft.externalId} aria-label="System ID" autoFocus placeholder="G-012"
            onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} />
        </div>
        <div>
          <label>Client</label>
          <PickOrAdd value={draft.client} options={clients} newLabel="+ New client..." placeholder="New client name"
            onChange={(client) => setDraft({ ...draft, client })} />
        </div>
        <div>
          <label>Priority</label>
          <input value={draft.priority} aria-label="Priority" placeholder="11"
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
        </div>
      </div>
      <div className="pf2" style={{ marginBottom: 8 }}>
        <div>
          <label>Type</label>
          {/* What it is decides which section it lists under on the registry,
              and which upkeep and gases the catalog brings it. */}
          <CatalogSelect value={draft.category} options={categories} ariaLabel="System type"
            onChange={(category) => setDraft({ ...draft, category })}
            hint="Define system types in Settings → Catalog" />
        </div>
      </div>
      {people.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mut t-small">Lead:</span>
          <select value={draft.lead} aria-label="Lead" className="t-small" style={{ width: "auto" }}
            onChange={(e) => setDraft({ ...draft, lead: e.target.value })}>
            <option value="">-</option>
            {people.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}
    </Dialog>
  );
}

/**
 * The dialog with its own button, for a page rendered on the server.
 *
 * The board holds the trigger itself, because it sits in a row with that
 * page's other actions; the registry only needs "a button that opens this".
 */
export function NewSystemButton({ clients, categories, people }: NewSystemOptions) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm primary" onClick={() => setOpen(true)}>+ New system</button>
      {open && (
        <NewSystemDialog clients={clients} categories={categories} people={people}
          onClose={() => setOpen(false)} />
      )}
    </>
  );
}
