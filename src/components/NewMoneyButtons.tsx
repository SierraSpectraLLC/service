"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { createBlankInvoice, createBlankQuote } from "@/app/actions";

export type ClientOption = { id: number; name: string };

/**
 * Invoices and quotes with no job behind them: a deposit, a shipment, a
 * correction, a price worked up over the phone. Pick the client, get a blank
 * draft, and type the lines onto it there.
 */
export function NewInvoiceButton({ clients }: { clients: ClientOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
        <select value={orgId || ""} onChange={(e) => setOrgId(parseInt(e.target.value) || 0)} autoFocus>
          <option value="">Pick the client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
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
      toast({ message: `Drafted a quote for ${clients.find((c) => c.id === orgId)?.name ?? "the client"}` });
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
        <select value={orgId || ""} onChange={(e) => setOrgId(parseInt(e.target.value) || 0)} autoFocus
          style={{ marginBottom: 8 }}>
          <option value="">Pick the client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
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
