"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { Id, Tabs } from "@/components/ui";

export type ClientLine = {
  id: number; kind: string; description: string; detail: string;
  qty: number; unitCents: number; covered: boolean; coveredBy: string;
};

/**
 * What a client sees when they open the link: this bill, and their account.
 *
 * Two tabs and nothing else. No nav, no login, no sight of anybody else's
 * money - the page was handed everything it renders by a server component
 * that looked it up through the token's own org. Payment buttons are a later
 * stage; with no keys configured there is nothing here that pretends to take
 * money, which is the honest state to ship in.
 */
export default function ClientInvoice({ brandName, orgName, apEmail, invoice, statement }: {
  brandName: string;
  orgName: string;
  apEmail: string;
  invoice: {
    id: number; number: string; issuedOn: string; dueOn: string;
    poNumber: string; note: string; lines: ClientLine[]; paidCents: number;
  };
  statement: {
    openCents: number; payableCents: number; count: number;
    open: { number: string; balanceCents: number; daysLate: number }[];
  };
}) {
  const [tab, setTab] = useState<"invoice" | "account">("invoice");
  const total = invoice.lines.reduce((n, l) => n + (l.covered ? 0 : Math.round(l.qty * l.unitCents)), 0);
  const covered = invoice.lines.filter((l) => l.covered).reduce((n, l) => n + Math.round(l.qty * l.unitCents), 0);
  const due = Math.max(0, total - invoice.paidCents);

  return (
    <>
      <Tabs
        ariaLabel="Your billing"
        active={tab}
        onSelect={(k) => setTab(k as "invoice" | "account")}
        items={[
          { key: "invoice", label: `Invoice ${invoice.number}` },
          { key: "account", label: "Your account", count: statement.count || undefined },
        ]}
      />

      {tab === "invoice" ? (
        <div className="card">
          <div className="eyebrow">{brandName} · for {orgName}</div>
          <h2 className="t-page" style={{ margin: "2px 0 2px" }}>Invoice <Id>{invoice.number}</Id></h2>
          <div className="mut t-small" style={{ marginBottom: 10 }}>
            {invoice.issuedOn ? `issued ${invoice.issuedOn}` : ""}
            {invoice.dueOn ? ` · due ${invoice.dueOn}` : ""}
            {invoice.poNumber ? ` · PO ${invoice.poNumber}` : ""}
          </div>

          {invoice.lines.map((l) => (
            <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
                {(l.detail || l.covered) && (
                  <span className="mut t-meta" style={{ display: "block" }}>
                    {l.detail}
                    {l.covered && `${l.detail ? " · " : ""}covered by ${l.coveredBy || "your agreement"}`}
                  </span>
                )}
              </span>
              <b className="t-body">
                {l.covered ? formatCents(0) : formatCents(Math.round(l.qty * l.unitCents))}
              </b>
            </div>
          ))}

          <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
            <span className="t-body" style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>
              {invoice.paidCents > 0 ? "Payable now" : "Total"}
            </span>
            <b className="t-page">{formatCents(due)}</b>
          </div>

          {covered > 0 && (
            <div className="mut t-small" style={{ marginTop: 8 }}>
              {formatCents(covered)} of this visit was covered by your agreement and bills at nothing.
              The visit is on your service record either way.
            </div>
          )}
          {invoice.note && <div className="t-small" style={{ marginTop: 8 }}>{invoice.note}</div>}
          <div className="mut t-meta" style={{ marginTop: 10 }}>
            Question a line? Reply to the email this link came in. We pause that line while we sort it out,
            and the rest stays due.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="eyebrow">Your account</div>
          <h2 className="t-page" style={{ margin: "2px 0 8px" }}>
            {formatCents(statement.openCents)} open
            <span className="mut t-small" style={{ fontWeight: 400 }}>
              {" "}across {statement.count} invoice{statement.count === 1 ? "" : "s"}
            </span>
          </h2>
          {statement.open.map((v) => (
            <div key={v.number} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <Id>{v.number}</Id>
              <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>
                {v.daysLate > 0 ? `${v.daysLate} days past due` : "inside terms"}
              </span>
              <b className="t-body">{formatCents(v.balanceCents)}</b>
            </div>
          ))}
          {statement.open.length === 0 && <div className="mut t-body">Nothing is outstanding. Thank you.</div>}
          <div className="mut t-small" style={{ marginTop: 10 }}>
            Reminders go to {apEmail || "the contact on file"} rather than to the lab. Tell us if that
            should change and we will point them at the right desk.
          </div>
        </div>
      )}
    </>
  );
}
