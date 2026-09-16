"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { addOrg, createBlankInvoice, createBlankQuote } from "@/app/actions";

export type ClientOption = { id: number; name: string };

const NEW = "new";

/**
 * Who the paper is for - picked from the roster, or added right here.
 *
 * The roster is the only place a client could be created, so pricing work
 * for somebody new meant leaving a half-typed quote, going to Clients,
 * adding them, and coming back to start again. A new client is one field -
 * a name - and nothing else about them is needed to put a price in front of
 * them, so the picker takes it: the company is created (the same staff-only
 * addOrg the roster runs, with its own plan check and audit) and selected,
 * and the draft carries on.
 */
function ClientPicker({ clients, value, onPick, onAdded, disabled }: {
  clients: ClientOption[];
  value: number;
  onPick: (id: number) => void;
  onAdded: (c: ClientOption) => void;
  disabled?: boolean;
}) {
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const add = () => {
    const n = name.trim();
    if (!n) return;
    setError("");
    startTransition(async () => {
      const res = await addOrg(n, "client");
      if (res?.error || !res?.id) { setError(res?.error ?? "That didn't save"); return; }
      onAdded({ id: res.id, name: n });
      toast({ message: `Added ${n}` });
      setTyping(false);
      setName("");
    });
  };

  if (typing) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="row-2" style={{ flexWrap: "nowrap" }}>
          <input autoFocus value={name} placeholder="Company name" aria-label="New client name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          <button type="button" className="btn sm accent" style={{ flexShrink: 0 }}
            disabled={pending || !name.trim()} onClick={add}>
            {pending ? "Adding..." : "Add"}
          </button>
          <button type="button" className="btn sm" style={{ flexShrink: 0 }} disabled={pending}
            onClick={() => { setTyping(false); setName(""); setError(""); }}>
            List
          </button>
        </div>
        <div className="field-hint">
          Added to the client roster, and everything else about them - terms, sites, people - is set there later.
        </div>
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 4 }}>{error}</div>}
      </div>
    );
  }
  return (
    <select value={value || ""} disabled={disabled} autoFocus style={{ marginBottom: 8 }}
      onChange={(e) => {
        if (e.target.value === NEW) { setTyping(true); onPick(0); return; }
        onPick(parseInt(e.target.value) || 0);
      }}>
      <option value="">Pick the client</option>
      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value={NEW}>+ New client...</option>
    </select>
  );
}

/**
 * Invoices and quotes with no job behind them: a deposit, a shipment, a
 * correction, a price worked up over the phone. Pick the client, get a blank
 * draft, and type the lines onto it there.
 */
export function NewInvoiceButton({ clients }: { clients: ClientOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A client added from inside the dialog joins the list for the rest of it.
  const [roster, setRoster] = useState(clients);
  const [orgId, setOrgId] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const create = () => {
    if (!orgId) return;
    setError("");
    startTransition(async () => {
      const res = await createBlankInvoice(orgId);
      if (res.error || !res.id) { setError(res.error ?? "That didn't save"); return; }
      toast({ message: "Drafted a blank invoice" });
      router.push(`/money/invoices/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm primary" onClick={() => { setOrgId(0); setError(""); setOpen(true); }}>
        ＋ Invoice
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title="New invoice"
        context="A blank draft, not tied to a job. Lines are typed on the draft."
        footer={
          <>
            <DialogStatus error={error} problem={orgId ? null : "pick the client"} ok="Ready to draft." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={create} disabled={pending || !orgId}>
              {pending ? "Drafting..." : "Draft it"}
            </button>
          </>
        }>
        <label>Who gets the bill</label>
        <ClientPicker clients={roster} value={orgId} onPick={setOrgId} disabled={pending}
          onAdded={(c) => { setRoster((r) => [...r, c]); setOrgId(c.id); }} />
      </Dialog>
    </>
  );
}

/** Thirty days to answer, matching what a quote from a job defaults to. */
const daysOut = (today: string, days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function NewQuoteButton({ clients, today }: { clients: ClientOption[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A client added from inside the dialog joins the list for the rest of it.
  const [roster, setRoster] = useState(clients);
  const [orgId, setOrgId] = useState(0);
  const [title, setTitle] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [depositPct, setDepositPct] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const problem = !orgId ? "pick the client"
    : !title.trim() ? "say what it is for"
      : !expiresOn ? "pick the day it lapses"
        : depositPct.trim() !== "" && !Number.isFinite(Number(depositPct)) ? "the deposit must be a number"
          : null;

  const create = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await createBlankQuote(orgId, {
        title, expiresOn, depositPct: Number(depositPct) || 0,
      });
      if (res.error || !res.id) { setError(res.error ?? "That didn't save"); return; }
      toast({ message: `Drafted a quote for ${roster.find((c) => c.id === orgId)?.name ?? "the client"}` });
      router.push(`/money/quotes/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm primary" onClick={() => {
        setOrgId(0); setTitle(""); setExpiresOn(daysOut(today, 30)); setDepositPct(""); setError(""); setOpen(true);
      }}>
        ＋ Quote
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title="New quote"
        context="A blank draft, not tied to a job. Lines are typed on the draft."
        footer={
          <>
            <DialogStatus error={error} problem={problem} ok="Ready to draft." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={create} disabled={pending || !!problem}>
              {pending ? "Drafting..." : "Draft it"}
            </button>
          </>
        }>
        <label>Who it is for</label>
        <ClientPicker clients={roster} value={orgId} onPick={setOrgId} disabled={pending}
          onAdded={(c) => { setRoster((r) => [...r, c]); setOrgId(c.id); }} />
        <label>What it is for</label>
        <input value={title} placeholder="Relocate the GC-2010 to lab 4"
          onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 8 }} />
        <div className="pf2">
          <div>
            <label>Good until</label>
            <input type="date" value={expiresOn} min={today} onChange={(e) => setExpiresOn(e.target.value)} />
          </div>
          <div>
            <label>Deposit on approval, %</label>
            <input value={depositPct} inputMode="numeric" placeholder="0"
              onChange={(e) => setDepositPct(e.target.value)} />
          </div>
        </div>
      </Dialog>
    </>
  );
}
