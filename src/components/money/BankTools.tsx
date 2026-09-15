"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import {
  bankLinkToken, connectBank, importBankLines, matchBankLine, postBankLine, recordBankPayment,
  setBankOpening, syncBankNow, unmatchBankLine,
} from "@/app/money/actions";
import type { Suggestion } from "@/lib/ledger/match";
import { POST_AS } from "@/lib/ledger/match";

/** The buttons on one unmatched bank line: match, record, or post. */
export function BankLineActions({ txnId, suggestions, moneyIn, memo }: {
  txnId: number; suggestions: Suggestion[]; moneyIn: boolean; memo: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [account, setAccount] = useState("");
  const run = (fn: () => Promise<{ error?: string }>, ok: string) => startTransition(async () => {
    const res = await fn();
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: ok });
    router.refresh();
  });
  return (
    <span className="inline-form">
      {suggestions.map((s, i) => {
        if (s.kind === "entry") return (
          <button key={i} className="btn sm primary" disabled={pending} onClick={() => run(() => matchBankLine(txnId, s.entryId), `Matched bank line to entry #${s.entryId}`)}>
            Match #{s.entryId}
          </button>
        );
        if (s.kind === "invoice") return (
          <button key={i} className="btn sm primary" disabled={pending} onClick={() => run(() => recordBankPayment(txnId, s.invoiceId), `Recorded the bank line as payment on ${s.number} - bank / receivable, matched`)}>
            Payment on {s.number}
          </button>
        );
        if (s.kind === "income") return (
          <button key={i} className="btn sm" disabled={pending} onClick={() => run(() => postBankLine(txnId, { account: "revenue_fees", memo: memo || "Unidentified deposit" }), "Posted bank line as other income - matched")}>
            Post as other income
          </button>
        );
        return (
          <select key={i} value={account} disabled={pending} aria-label="Post as" onChange={(e) => {
            const a = e.target.value; setAccount(a);
            if (a) run(() => postBankLine(txnId, { account: a, memo }), `Posted bank line to ${POST_AS.find((p) => p.account === a)?.label ?? a} - matched`);
          }}>
            <option value="">Post as…</option>
            {s.accounts.map((a) => <option key={a} value={a}>{POST_AS.find((p) => p.account === a)?.label ?? a}</option>)}
          </select>
        );
      })}
      {moneyIn && !suggestions.some((s) => s.kind === "income") && (
        <button className="btn sm" disabled={pending} onClick={() => run(() => postBankLine(txnId, { account: "revenue_fees", memo: memo || "Unidentified deposit" }), "Posted bank line as other income - matched")}>
          Other income
        </button>
      )}
    </span>
  );
}

export function UnmatchButton({ txnId }: { txnId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn link t-meta" disabled={pending} onClick={async () => {
      if (!(await confirmDialog({ title: "Unmatch this bank line?", body: "The entry stays on the books. The line goes back to needing a home.", action: "Unmatch" }))) return;
      startTransition(async () => {
        const res = await unmatchBankLine(txnId);
        if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
        toast({ message: "Unmatched" });
        router.refresh();
      });
    }}>unmatch</button>
  );
}

/** Pull the feed now. */
export function SyncBankButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn sm" disabled={pending} onClick={() => startTransition(async () => {
      const res = await syncBankNow();
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Pulled the feed - ${res.added ?? 0} new line${res.added === 1 ? "" : "s"}` });
      router.refresh();
    })}>{pending ? "Pulling…" : "Pull the feed"}</button>
  );
}

/** Paste a statement: date, description, amount per line. */
export function BankImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form onSubmit={(e) => { e.preventDefault(); startTransition(async () => {
      const res = await importBankLines(text);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Imported ${res.added} line${res.added === 1 ? "" : "s"}${res.skipped ? `, ${res.skipped} skipped` : ""}` });
      setText("");
      router.refresh();
    }); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ width: "100%" }}
        placeholder={"2026-09-08, SHELL OIL 57210 FRESNO CA, -61.20\n2026-09-14, ACH CREDIT CASCADE ENV LABS, 2820.00"} />
      <div className="inline-form" style={{ marginTop: 8 }}>
        <button className="btn sm primary" type="submit" disabled={pending || !text.trim()}>{pending ? "Importing…" : "Import lines"}</button>
        <span className="t-meta mut">One line per transaction: date, description, amount. Money in positive. Pasting the same lines twice adds nothing.</span>
      </div>
    </form>
  );
}

/** The balance before the feed's first line. */
export function BankOpeningForm({ today, openingCents, openingOn }: { today: string; openingCents: number; openingOn: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState(openingOn ? (openingCents / 100).toFixed(2) : "");
  const [on, setOn] = useState(openingOn || today);
  const [pending, startTransition] = useTransition();
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); startTransition(async () => {
      const res = await setBankOpening({ amount, on });
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: "Set the bank's opening balance" });
      router.refresh();
    }); }}>
      <label>Balance before the first line<input type="text" value={amount} inputMode="decimal" placeholder="24,310.00" onChange={(e) => setAmount(e.target.value)} /></label>
      <label>As of<input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
      <button className="btn sm" type="submit" disabled={pending}>Save</button>
    </form>
  );
}

declare global {
  interface Window { Plaid?: { create: (o: Record<string, unknown>) => { open: () => void } } }
}

/** Open Plaid Link, then keep the connection. Owner only; renders nothing until the script is here. */
export function BankConnectButton({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!configured || window.Plaid) { setReady(!!window.Plaid); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, [configured]);
  if (!configured) return <span className="t-meta mut">Set PLAID_CLIENT_ID and PLAID_SECRET on the instance to connect a bank; until then, paste statements below.</span>;
  return (
    <button className="btn sm primary" disabled={!ready || pending} onClick={() => startTransition(async () => {
      const res = await bankLinkToken();
      if (res.error || !res.token) { toast({ message: res.error ?? "No token", tone: "bad" }); return; }
      window.Plaid?.create({
        token: res.token,
        onSuccess: (publicToken: string, meta: { institution?: { name?: string } }) => startTransition(async () => {
          const r = await connectBank({ publicToken, institution: meta?.institution?.name ?? "" });
          if (r.error) { toast({ message: r.error, tone: "bad" }); return; }
          toast({ message: `Connected - ${r.added ?? 0} line${r.added === 1 ? "" : "s"} pulled` });
          router.refresh();
        }),
      }).open();
    })}>{ready ? "Connect a bank" : "Loading…"}</button>
  );
}
