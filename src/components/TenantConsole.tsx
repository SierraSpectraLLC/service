"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createOperator, setFreeClients, setWorkspacePlan } from "@/app/actions";
import {
  cleanPlan, freeAllowance, FREE_CLIENTS, FREE_CLIENTS_MAX, planLabel, PLAN_LABEL,
} from "@/lib/plan";
import { DataTable, PageHead, Pill } from "@/components/ui";
import { confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

export type TenantRow = {
  id: number; name: string;
  staff: number; owners: number;
  clients: number; clientLogins: number;
  systems: number; live: number;
  machines: number; invitedOnto: number;
  /** '' = full, 'free' = the client-bounded hand-off tier. See lib/plan. */
  plan: string;
  planSince: string;
  /** Room granted to this workspace by hand, above the tier. Usually 0. */
  freeClients: number;
  since: string;
};

/**
 * One row per service company, and the form that opens a workspace for the next
 * one. The numbers are the ones a price is built from - seats, clients, systems,
 * machines - so an invoice is read here rather than reconstructed later.
 */
export default function TenantConsole({ rows, unassigned, rootOrgId }: {
  rows: TenantRow[];
  /** Staff rows with no company: they see nothing until one is set, so say so. */
  unassigned: string[];
  rootOrgId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  /*
   * The collection lever, and deliberately a human one: the platform takes no
   * card for its own subscriptions anywhere in this codebase, so money arrives
   * by invoice or by conversation and somebody who knows it arrived lifts the
   * limit here. Asking for a reason because a year from now "why is this shop
   * on full" is a question somebody will have - see lib/plan.
   */
  const move = async (r: TenantRow) => {
    const to = cleanPlan(r.plan) === "free" ? "" : "free";
    const why = await confirmReason({
      title: to === "" ? `Put ${r.name} on the full plan?` : `Put ${r.name} back on the free tier?`,
      body: to === ""
        ? "They can take on as many clients as they like, and hand clients to shops that are not"
          + " on Ridgeline yet. Do this once they have actually paid."
        : `They keep every record they have - nothing is deleted and nothing is hidden - but they`
          + ` stop at ${freeAllowance(r.freeClients)} client${freeAllowance(r.freeClients) === 1 ? "" : "s"}`
          + " and cannot invite a shop from outside.",
      action: to === "" ? "Move to full" : "Move to free",
      tone: to === "" ? "primary" : "bad",
    });
    if (why === null) return;
    startTransition(async () => {
      const res = await setWorkspacePlan(r.id, to, why);
      if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `${r.name} is on ${PLAN_LABEL[to].toLowerCase()}` });
      router.refresh();
    });
  };

  /*
   * The sweetener. A shop being handed its first client is easier to win with
   * a second one in the same breath, and this is where that is given - by a
   * person, to one workspace, with the reason kept. The tier itself does not
   * move: every other free workspace still stops at one. See lib/plan.
   */
  const stretch = async (r: TenantRow, to: number) => {
    const room = freeAllowance(r.freeClients);
    const why = await confirmReason({
      title: to > room
        ? `Give ${r.name} ${to} free clients?`
        : `Put ${r.name} back to ${FREE_CLIENTS} free client?`,
      body: to > room
        ? `They can take on ${to} clients on the free tier instead of ${room} - handed to them or`
          + " their own - and nothing else about the tier changes. Do this when it is what wins them."
        : "They keep every record they have. They stop at the tier's own limit, so a workspace"
          + " already over it simply cannot add another.",
      action: to > room ? `Give ${to}` : "Back to the tier",
      tone: to > room ? "primary" : "bad",
    });
    if (why === null) return;
    startTransition(async () => {
      const res = await setFreeClients(r.id, to, why);
      if (res?.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `${r.name}'s free tier covers ${to} client${to === 1 ? "" : "s"}` });
      router.refresh();
    });
  };

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createOperator(name, email);
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Opened ${name.trim()} - ${email.trim().toLowerCase()} can sign in` });
      setName(""); setEmail(""); setOpen(false);
    });
  };

  return (
    <div>
      <PageHead title="Service companies"
        sub="Seats, clients, systems, machines per tenant. Free tiers came in through a hand-off."
        actions={
          <button className="btn sm accent" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "+ Open a workspace"}
          </button>
        } />

      {open && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", margin: "8px 0" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <label className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>Company</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                placeholder="Northwind Analytical" className="t-body" style={{ width: "100%" }} />
            </div>
            <div style={{ flex: "1 1 220px" }}>
              <label className="t-small" style={{ fontWeight: 700, display: "block", marginBottom: 3 }}>Their first owner</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                placeholder="owner@northwind.com" className="t-body" style={{ width: "100%" }} />
            </div>
            <button className="btn sm accent" disabled={pending || !name.trim() || !email.trim()} onClick={submit}>
              {pending ? "Opening..." : "Open"}
            </button>
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {unassigned.length > 0 && (
        <div style={{ fontSize: 13, color: "var(--t-warn-fg)", background: "#FAF0DC", borderRadius: 8, padding: "7px 10px", margin: "8px 0" }}>
          No company set for {unassigned.join(", ")} - they see nothing until one is.
        </div>
      )}

      <DataTable
        cols={[
          { key: "name", label: "Company", width: "minmax(160px, 1.6fr)" },
          { key: "plan", label: "Plan", width: "150px" },
          { key: "seats", label: "Seats", width: "90px", align: "right" },
          { key: "clients", label: "Clients", width: "70px", align: "right", hideMobile: true },
          { key: "logins", label: "Client logins", width: "100px", align: "right", hideMobile: true },
          { key: "systems", label: "Systems", width: "90px", align: "right" },
          { key: "machines", label: "Machines", width: "80px", align: "right", hideMobile: true },
          { key: "invited", label: "Invited onto", width: "95px", align: "right", hideMobile: true },
          { key: "since", label: "Since", width: "90px", hideMobile: true },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          cells: {
            name: (
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <b className="t-body">{r.name}</b>
                {r.id === rootOrgId && <Pill tone="info">runs the platform</Pill>}
              </span>
            ),
            plan: r.id === rootOrgId ? <span className="mut t-small">-</span> : (
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Pill tone={cleanPlan(r.plan) === "free" ? "warn" : "good"}>
                  {planLabel(r.plan, r.freeClients)}
                </Pill>
                <button className="btn link t-meta" disabled={pending} onClick={() => move(r)}>
                  {cleanPlan(r.plan) === "free" ? "to full" : "to free"}
                </button>
                {/* Only where it means something: the grant is read on the free
                    tier alone, so a full workspace is not offered it. */}
                {cleanPlan(r.plan) === "free" && freeAllowance(r.freeClients) < FREE_CLIENTS_MAX && (
                  <button className="btn link t-meta" disabled={pending}
                    onClick={() => stretch(r, freeAllowance(r.freeClients) + 1)}>
                    +1 client
                  </button>
                )}
                {cleanPlan(r.plan) === "free" && freeAllowance(r.freeClients) > FREE_CLIENTS && (
                  <button className="btn link t-meta" disabled={pending}
                    onClick={() => stretch(r, FREE_CLIENTS)}>
                    back to {FREE_CLIENTS}
                  </button>
                )}
              </span>
            ),
            seats: <span style={{ fontSize: 13 }}>{r.staff}{r.owners > 0 && <span className="mut"> ({r.owners} owner{r.owners === 1 ? "" : "s"})</span>}</span>,
            clients: <span style={{ fontSize: 13 }}>{r.clients}</span>,
            logins: <span style={{ fontSize: 13 }}>{r.clientLogins}</span>,
            systems: <span style={{ fontSize: 13 }}>{r.live}{r.systems !== r.live && <span className="mut"> of {r.systems}</span>}</span>,
            machines: <span style={{ fontSize: 13 }}>{r.machines}</span>,
            invited: <span style={{ fontSize: 13 }}>{r.invitedOnto || <span className="mut">-</span>}</span>,
            since: <span className="mut t-small">{r.since}</span>,
          },
        }))}
        empty="No workspaces yet"
      />
    </div>
  );
}
