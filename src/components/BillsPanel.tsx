"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createBill, updateBill } from "@/app/actions";
import { STIPEND_SHAPES, WEEKDAY_NAMES, previewFirstCycle, shapeTerms } from "@/lib/stipends";
import { billAction, billCadence, billMonthlyCents, checkBill, DUE_SOON_DAYS } from "@/lib/bills";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type BillRow = {
  id: number;
  name: string;
  payee: string;
  kind: string;
  amountCents: number;
  cadence: string;
  everyMonths: number;
  dayOfMonth: number;
  everyWeeks: number;
  weekday: number;
  startsOn: string;
  endsOn: string;
  active: boolean;
  lastOn: string;
  /** When the pass next posts it. "" = never again. */
  nextOn: string;
  portalUrl: string;
  accountRef: string;
  person: string;
  autopay: boolean;
  note: string;
};

/** One cycle landing soon: which bill, and the day. */
export type SoonRow = { billId: number; on: string };

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}/${y.slice(2)}`;
};

/**
 * What there is to do about a bill, as the one control beside it.
 *
 * The portal link is the feature: "get to the place I pay it in one click".
 * Autopay is a pill because there is nothing to do but know. A bill with
 * neither says so quietly rather than showing a dead button.
 */
function Action({ b }: { b: Pick<BillRow, "autopay" | "portalUrl"> }) {
  const what = billAction(b);
  if (what === "autopay") return <Pill tone="info">autopay</Pill>;
  if (what === "pay") {
    return (
      <a href={b.portalUrl} target="_blank" rel="noopener noreferrer" className="btn sm accent">
        Pay →
      </a>
    );
  }
  return <span className="mut t-meta">no portal link</span>;
}

/**
 * The bills desk: what the company pays to exist, on a cycle.
 *
 * Two lists, deliberately. COMING DUE is the working list - the next two
 * weeks, in date order, with the pay link beside each - because that is what
 * somebody opens this page to do. STANDING BILLS is the register, every
 * arrangement whether or not anything is due, for setting up and changing.
 *
 * Each posts to Overhead on its day by itself - see lib/billRun - so nothing
 * here is a "mark paid" button. The owner's call: half of these are autopay,
 * and a ledger that waited for a click would read low every month by
 * exactly the bills nobody clicked.
 */
export default function BillsPanel({ rows, soon, roster, categories, isOwner, today }: {
  rows: BillRow[];
  soon: SoonRow[];
  /** Who a benefit can belong to: the roster, by name. */
  roster: { name: string }[];
  categories: string[];
  /** Only the owner may create or change one. */
  isOwner: boolean;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BillRow | null>(null);
  const [err, setErr] = useState("");
  const blank = () => ({
    name: "", payee: "", amount: "",
    kind: categories.find((c) => /insur|benefit|software|util|phone|rent|lease/i.test(c)) ?? categories[0] ?? "Other",
    shape: "m1-1", dayOfMonth: "1", weekday: "1",
    // The 1st of the current month: "starting this month" is what somebody
    // setting one up almost always means, and the pass posts the month it
    // was set up in rather than the month after.
    startsOn: `${today.slice(0, 7)}-01`, endsOn: "",
    portalUrl: "", accountRef: "", person: "", autopay: false, note: "",
  });
  const [draft, setDraft] = useState(blank);
  const [edit, setEdit] = useState({
    amount: "", endsOn: "", note: "", name: "", payee: "", portalUrl: "", accountRef: "", autopay: false,
  });

  const cents = Math.round(parseFloat(draft.amount.replace(/[^0-9.]/g, "")) * 100) || 0;
  const { shape, picksDay, terms } = shapeTerms(draft.shape, draft.dayOfMonth, draft.weekday);
  const problem = checkBill({
    name: draft.name, amountCents: cents, ...terms,
    startsOn: draft.startsOn, endsOn: draft.endsOn, portalUrl: draft.portalUrl,
  });
  const firstOn = previewFirstCycle(draft.startsOn, terms.dayOfMonth, terms.cadence, terms.weekday);

  const running = rows.filter((r) => r.active);
  const monthly = running.reduce((n, r) => n + billMonthlyCents(r), 0);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const soonRows = soon.flatMap((s) => {
    const b = byId.get(s.billId);
    return b ? [{ ...s, b }] : [];
  });
  const soonCents = soonRows.reduce((n, s) => n + s.b.amountCents, 0);
  const toPay = soonRows.filter((s) => !s.b.autopay);

  return (
    <>
      <Panel
        title="Coming due"
        count={soonRows.length || undefined}
        hint={soonRows.length
          ? `${formatCents(soonCents)} in the next ${DUE_SOON_DAYS} days`
            + (toPay.length ? ` · ${toPay.length} to go and pay` : " · all autopay")
          : `Nothing in the next ${DUE_SOON_DAYS} days`}
        empty={rows.length ? `Nothing falls due in the next ${DUE_SOON_DAYS} days.` : undefined}
      >
        {soonRows.length > 0 && soonRows.map((s) => (
          <div key={`${s.billId}-${s.on}`} className="row-2"
            style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span className="t-small" style={{ width: 72 }}>
              {s.on === today ? <b>today</b> : mdy(s.on)}
            </span>
            <span className="t-body" style={{ flex: "1 1 200px", minWidth: 0 }}>
              <b>{s.b.name}</b>
              <span className="mut t-meta">
                {s.b.payee ? ` · ${s.b.payee}` : ""}
                {s.b.accountRef ? ` · ${s.b.accountRef}` : ""}
                {s.b.person ? ` · ${s.b.person}'s` : ""}
              </span>
            </span>
            <span className="t-body" style={{ width: 92, textAlign: "right", fontWeight: 700 }}>
              {formatCents(s.b.amountCents)}
            </span>
            <span style={{ width: 110, textAlign: "right" }}><Action b={s.b} /></span>
          </div>
        ))}
      </Panel>

      <Panel
        title="Standing bills"
        count={rows.length || undefined}
        hint={<>
          What it costs to exist, on a cycle - insurance, benefits, the phone line, the lease.
          Each one posts itself to <Link href="/money/expenses">Overhead</Link> on its day, whether
          it autopays or you pay it at the link. Nothing to mark.
        </>}
        actions={isOwner
          ? <button className="btn sm primary" onClick={() => { setDraft(blank()); setErr(""); setAdding(true); }} disabled={pending}>+ Bill</button>
          : undefined}
        empty={isOwner
          ? "Nothing standing yet. Set up the first policy and it lands on Overhead every cycle without anybody logging it."
          : "Nothing standing yet. The owner sets these up."}
      >
        {rows.length > 0 && (
          <>
            <DataTable
              cols={[
                { key: "what", label: "Bill", width: "minmax(200px, 1.6fr)" },
                { key: "amount", label: "Amount", width: "110px", align: "right" },
                { key: "when", label: "Next", width: "150px" },
                { key: "pay", label: "", width: "110px", align: "right" },
                { key: "act", label: "", width: "110px", align: "right" },
              ]}
              rows={rows.map((r) => ({
                key: String(r.id),
                cells: {
                  what: (
                    <>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      {r.payee && <span className="mut"> · {r.payee}</span>}
                      <div className="mut t-meta">
                        {r.kind} · {billCadence(r)}
                        {r.person ? ` · ${r.person}'s` : ""}
                        {r.accountRef ? ` · ${r.accountRef}` : ""}
                      </div>
                    </>
                  ),
                  amount: <span style={{ fontWeight: 700 }}>{formatCents(r.amountCents)}</span>,
                  when: r.active ? (
                    <span className="t-small">
                      {r.nextOn || <span className="mut">finished</span>}
                      {/* Behind, not scheduled: the pass posts it on its next run. */}
                      {r.nextOn && r.nextOn < today && <> <Pill tone="warn">catching up</Pill></>}
                      <div className="mut t-meta">
                        {r.lastOn ? `last posted ${r.lastOn}` : "not posted yet"}
                      </div>
                    </span>
                  ) : <Pill tone="faint">paused</Pill>,
                  pay: <Action b={r} />,
                  act: isOwner ? (
                    <span style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button className="btn sm link" disabled={pending}
                        onClick={() => {
                          setEdit({
                            amount: (r.amountCents / 100).toFixed(2), endsOn: r.endsOn, note: r.note,
                            name: r.name, payee: r.payee, portalUrl: r.portalUrl,
                            accountRef: r.accountRef, autopay: r.autopay,
                          });
                          setErr(""); setEditing(r);
                        }}>edit</button>
                      <button className="btn sm link" disabled={pending}
                        onClick={async () => {
                          if (r.active && !(await confirmDialog({
                            title: `Pause ${r.name}?`,
                            body: "It stops posting to Overhead each cycle. What it has already posted stays on the ledger, and restarting it later does not back-post the gap.",
                            action: "Pause it",
                          }))) return;
                          startTransition(async () => {
                            const res = await updateBill(r.id, { active: !r.active });
                            if (res?.error) { toast({ message: res.error }); return; }
                            toast({ message: r.active ? "Paused" : "Running again" });
                            router.refresh();
                          });
                        }}>{r.active ? "pause" : "restart"}</button>
                    </span>
                  ) : null,
                },
              }))}
            />
            <div className="mut t-small" style={{ marginTop: 8 }}>
              {formatCents(monthly)} a month across {running.length} running
              bill{running.length === 1 ? "" : "s"}
              {running.some((r) => r.autopay)
                ? ` · ${formatCents(running.filter((r) => r.autopay).reduce((n, r) => n + billMonthlyCents(r), 0))} of it autopay`
                : ""}.
            </div>
          </>
        )}
      </Panel>

      {adding && (
        <Dialog open onClose={() => setAdding(false)} size="sm" title="New standing bill"
          context="It posts itself to Overhead every cycle. Anything already due this cycle posts now."
          footer={
            <>
              <DialogStatus error={err} problem={problem}
                ok={firstOn ? `First cycle ${firstOn}` : undefined} />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || problem !== null}
                onClick={() => startTransition(async () => {
                  const res = await createBill({
                    name: draft.name, payee: draft.payee, amount: draft.amount, kind: draft.kind,
                    ...terms,
                    startsOn: draft.startsOn, endsOn: draft.endsOn,
                    portalUrl: draft.portalUrl, accountRef: draft.accountRef,
                    person: draft.person, autopay: draft.autopay, note: draft.note,
                  });
                  if (res?.error) { setErr(res.error); return; }
                  toast({ message: res.posted
                    ? `Set up - ${res.posted} cycle${res.posted === 1 ? "" : "s"} posted to Overhead`
                    : `Set up - it posts first on ${firstOn}` });
                  setAdding(false);
                  router.refresh();
                })}>
                {pending ? "Setting up..." : "Set it up"}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>What it is</label>
              <input value={draft.name} aria-label="What it is" placeholder="Liability policy" autoFocus
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label>Paid to</label>
              <input value={draft.payee} aria-label="Paid to" placeholder="The Hartford"
                onChange={(e) => setDraft({ ...draft, payee: e.target.value })} />
            </div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Amount ($)</label>
              <input value={draft.amount} aria-label="Amount" inputMode="decimal" placeholder="412.00"
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
            <div>
              <label>Category</label>
              <select value={draft.kind} aria-label="Category"
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>How often</label>
              <select value={draft.shape} aria-label="How often"
                onChange={(e) => setDraft({ ...draft, shape: e.target.value })}>
                {STIPEND_SHAPES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </div>
            <div>
              <label>Whose</label>
              <select value={draft.person} aria-label="Whose"
                onChange={(e) => setDraft({ ...draft, person: e.target.value })}>
                <option value="">The company&apos;s</option>
                {roster.map((p) => <option key={p.name} value={p.name}>{p.name} - a benefit of theirs</option>)}
              </select>
            </div>
          </div>
          {picksDay && (
            <div style={{ marginBottom: 8 }}>
              <label>Day of the month</label>
              <input value={draft.dayOfMonth} aria-label="Day of the month" inputMode="numeric"
                onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })} />
              <div className="field-hint">
                1 to 31. A 31 lands on the last day of every month, so a short month is never skipped.
              </div>
            </div>
          )}
          {shape.cadence === "weeks" && (
            <div style={{ marginBottom: 8 }}>
              <label>Which day</label>
              <select value={draft.weekday} aria-label="Which day"
                onChange={(e) => setDraft({ ...draft, weekday: e.target.value })}>
                {WEEKDAY_NAMES.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
              </select>
            </div>
          )}
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Starting</label>
              <input type="date" value={draft.startsOn} aria-label="Starting"
                onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} />
            </div>
            <div>
              <label>Until (optional)</label>
              <input type="date" value={draft.endsOn} aria-label="Until"
                onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} />
            </div>
          </div>
          <label>Where you pay it</label>
          <input value={draft.portalUrl} aria-label="Where you pay it" placeholder="https://..."
            inputMode="url"
            onChange={(e) => setDraft({ ...draft, portalUrl: e.target.value })} />
          <div className="field-hint">The carrier&apos;s portal. It becomes the Pay button beside the bill.</div>
          <div className="pf2" style={{ marginTop: 8, marginBottom: 8 }}>
            <div>
              <label>Account or policy no.</label>
              <input value={draft.accountRef} aria-label="Account or policy number" placeholder="GL-4471-22"
                onChange={(e) => setDraft({ ...draft, accountRef: e.target.value })} />
            </div>
            <div>
              <label>Note</label>
              <input value={draft.note} aria-label="Note" placeholder="Renews in March"
                onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </div>
          </div>
          <label className="row-2" style={{ alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={draft.autopay}
              onChange={(e) => setDraft({ ...draft, autopay: e.target.checked })} />
            <span className="t-body">Comes out automatically - nothing to do on the day</span>
          </label>
          <div className="field-hint" style={{ marginTop: 8 }}>
            {firstOn
              ? <>It posts <b>{billCadence(terms)}</b>, first on <b>{firstOn}</b>.
                  {" "}Leave the end date blank to run until you stop it.</>
              : "Pick the day it starts."}
          </div>
        </Dialog>
      )}

      {editing && (
        <Dialog open onClose={() => setEditing(null)} size="sm"
          title={editing.name}
          context="Changing the amount does not re-price what has already posted."
          footer={
            <>
              <DialogStatus error={err} />
              <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await updateBill(editing.id, edit);
                  if (res?.error) { setErr(res.error); return; }
                  toast({ message: "Saved" });
                  setEditing(null);
                  router.refresh();
                })}>
                Save
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>What it is</label>
              <input value={edit.name} aria-label="What it is" autoFocus
                onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </div>
            <div>
              <label>Paid to</label>
              <input value={edit.payee} aria-label="Paid to"
                onChange={(e) => setEdit({ ...edit, payee: e.target.value })} />
            </div>
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Amount ($)</label>
              <input value={edit.amount} aria-label="Amount" inputMode="decimal"
                onChange={(e) => setEdit({ ...edit, amount: e.target.value })} />
            </div>
            <div>
              <label>Until</label>
              <input type="date" value={edit.endsOn} aria-label="Until"
                onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} />
            </div>
          </div>
          <label>Where you pay it</label>
          <input value={edit.portalUrl} aria-label="Where you pay it" inputMode="url" placeholder="https://..."
            onChange={(e) => setEdit({ ...edit, portalUrl: e.target.value })} />
          <div className="pf2" style={{ marginTop: 8, marginBottom: 8 }}>
            <div>
              <label>Account or policy no.</label>
              <input value={edit.accountRef} aria-label="Account or policy number"
                onChange={(e) => setEdit({ ...edit, accountRef: e.target.value })} />
            </div>
            <div>
              <label>Note</label>
              <input value={edit.note} aria-label="Note"
                onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
            </div>
          </div>
          <label className="row-2" style={{ alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={edit.autopay}
              onChange={(e) => setEdit({ ...edit, autopay: e.target.checked })} />
            <span className="t-body">Comes out automatically</span>
          </label>
          <div className="field-hint" style={{ marginTop: 8 }}>
            {editing.lastOn
              ? `Last posted ${editing.lastOn}. Pausing stops the next one without touching that.`
              : "It has not posted yet."}
          </div>
        </Dialog>
      )}
    </>
  );
}
