"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createStipend, updateStipend } from "@/app/actions";
import {
  LAST_DAY, WEEKDAY_NAMES, checkStipend, monthlyEquivalentCents, previewFirstCycle,
  stipendCadenceLabel,
} from "@/lib/stipends";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type StipendRow = {
  id: number;
  person: string;
  label: string;
  amountCents: number;
  kind: string;
  /** "months" | "weeks" - see lib/stipends. */
  cadence: string;
  everyMonths: number;
  dayOfMonth: number;
  everyWeeks: number;
  weekday: number;
  startsOn: string;
  endsOn: string;
  active: boolean;
  lastOn: string;
  /** When the pass will next raise it. "" = never again. */
  nextOn: string;
  note: string;
};

/**
 * The dropdown's options, flattened into one list.
 *
 * A cadence select and a separate day-of-month select is two decisions to
 * express one, and the second one is meaningless in the weekly shape - which
 * is how a form ends up with a disabled control nobody can explain. These are
 * the schedules a shop actually asks for, written as sentences.
 */
const SHAPES: { key: string; label: string; cadence: string;
  everyMonths: number; dayOfMonth: number; everyWeeks: number }[] = [
  { key: "m1-1",    label: "Monthly, on the 1st",        cadence: "months", everyMonths: 1,  dayOfMonth: 1,        everyWeeks: 1 },
  { key: "m1-15",   label: "Monthly, on the 15th",       cadence: "months", everyMonths: 1,  dayOfMonth: 15,       everyWeeks: 1 },
  { key: "m1-last", label: "Monthly, on the last day",   cadence: "months", everyMonths: 1,  dayOfMonth: LAST_DAY, everyWeeks: 1 },
  { key: "m1-day",  label: "Monthly, on a day I pick",   cadence: "months", everyMonths: 1,  dayOfMonth: 1,        everyWeeks: 1 },
  { key: "m3",      label: "Every quarter",              cadence: "months", everyMonths: 3,  dayOfMonth: 1,        everyWeeks: 1 },
  { key: "m6",      label: "Every 6 months",             cadence: "months", everyMonths: 6,  dayOfMonth: 1,        everyWeeks: 1 },
  { key: "m12",     label: "Every year",                 cadence: "months", everyMonths: 12, dayOfMonth: 1,        everyWeeks: 1 },
  { key: "w1",      label: "Every week",                 cadence: "weeks",  everyMonths: 1,  dayOfMonth: 1,        everyWeeks: 1 },
  { key: "w2",      label: "Every other week",           cadence: "weeks",  everyMonths: 1,  dayOfMonth: 1,        everyWeeks: 2 },
  { key: "w4",      label: "Every 4 weeks",              cadence: "weeks",  everyMonths: 1,  dayOfMonth: 1,        everyWeeks: 4 },
];

/**
 * Standing reimbursements: the internet stipend, the phone allowance.
 *
 * WHAT THIS IS NOT is worth saying on the screen as well as in the schema,
 * because the natural place to look for "$35 a month to Owen" is payroll. It
 * is not payroll: a stipend pays somebody back for something they bought, so
 * running it through the wage register would tax it as income and bury it in a
 * line nobody can read. It goes through the reimbursement desk like every
 * other out-of-pocket cost, on its own monthly claim.
 *
 * The owner sets them up and changes them - it is a standing commitment of
 * company money - and HR reads them, because HR runs the payout and needs to
 * know what is coming.
 */
export default function StipendsCard({ rows, roster, categories, isOwner, today }: {
  rows: StipendRow[];
  /** Who one can be set up for: the roster, by the name a report carries. */
  roster: { name: string }[];
  categories: string[];
  /** Only the owner may create or change one. Everyone here may read them. */
  isOwner: boolean;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StipendRow | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({
    person: "", label: "", amount: "", kind: "", shape: "m1-1", dayOfMonth: "1", weekday: "1",
    startsOn: "", endsOn: "", note: "",
  });
  const [edit, setEdit] = useState({ amount: "", endsOn: "", note: "", label: "" });

  const openAdd = () => {
    setDraft({
      person: roster[0]?.name ?? "", label: "", amount: "",
      kind: categories.find((c) => /phone|internet/i.test(c)) ?? categories[0] ?? "Other",
      shape: "m1-1", dayOfMonth: "1", weekday: "1",
      // The 1st of the current month: "starting this month" is what somebody
      // setting one of these up almost always means, and lib/stipends pays the
      // month it was set up in rather than the month after.
      startsOn: `${today.slice(0, 7)}-01`,
      endsOn: "", note: "",
    });
    setErr(""); setAdding(true);
  };

  const cents = Math.round(parseFloat(draft.amount.replace(/[^0-9.]/g, "")) * 100) || 0;
  const shape = SHAPES.find((x) => x.key === draft.shape) ?? SHAPES[0];
  // Only the "day I pick" shape reads the day box; every other one carries its
  // own day, so switching to "on the last day" cannot be silently overridden
  // by a number left behind in a field nobody is looking at.
  const picksDay = shape.key === "m1-day";
  const terms = {
    cadence: shape.cadence,
    everyMonths: shape.everyMonths,
    dayOfMonth: picksDay ? parseInt(draft.dayOfMonth, 10) || 0 : shape.dayOfMonth,
    everyWeeks: shape.everyWeeks,
    weekday: parseInt(draft.weekday, 10),
  };
  const problem = checkStipend({
    person: draft.person, label: draft.label, amountCents: cents,
    ...terms, startsOn: draft.startsOn, endsOn: draft.endsOn,
  });
  const firstOn = previewFirstCycle(draft.startsOn, terms.dayOfMonth, terms.cadence, terms.weekday);

  // Averaged per cadence rather than divided by everyMonths: a weekly $12 is
  // $26 a month, and this line read $12 the day weekly schedules shipped.
  const monthly = rows.filter((r) => r.active)
    .reduce((n, r) => n + monthlyEquivalentCents(r), 0);

  return (
    <Panel
      title="Standing reimbursements"
      count={rows.length || undefined}
      hint={<>
        Stipends and allowances that pay themselves - internet, phone, tools. Each one lands on
        that person&apos;s monthly <b>General perks</b> claim at <Link href="/money/reimbursements">Reimbursements</Link>,
        ready for you to mark paid. Deliberately not payroll: this is money somebody is owed back,
        not wages.
      </>}
      actions={isOwner && roster.length > 0
        ? <button className="btn sm primary" onClick={openAdd} disabled={pending}>+ Stipend</button>
        : undefined}
      empty={isOwner
        ? "Nothing standing yet. Set one up and it appears on their claim every month without anybody filing it."
        : "Nothing standing yet. The owner sets these up."}
    >
      {rows.length > 0 && (
        <>
          <DataTable
            cols={[
              { key: "who", label: "Person", width: "minmax(150px, 1.2fr)" },
              { key: "what", label: "What", width: "minmax(150px, 1.4fr)" },
              { key: "amount", label: "Amount", width: "110px", align: "right" },
              { key: "when", label: "Next", width: "150px" },
              { key: "act", label: "", width: "110px", align: "right" },
            ]}
            rows={rows.map((r) => ({
              key: String(r.id),
              cells: {
                who: <span style={{ fontWeight: 600 }}>{r.person}</span>,
                what: (
                  <>
                    <span>{r.label}</span>
                    <div className="mut t-meta">{r.kind} · {stipendCadenceLabel(r)}</div>
                  </>
                ),
                amount: <span style={{ fontWeight: 700 }}>{formatCents(r.amountCents)}</span>,
                when: r.active ? (
                  <span className="t-small">
                    {r.nextOn || <span className="mut">finished</span>}
                    {/* An arrangement whose next payment is in the past is
                        BEHIND, not scheduled - the pass will catch it up on its
                        next run, and saying so beats a date that looks wrong. */}
                    {r.nextOn && r.nextOn < today && <> <Pill tone="warn">catching up</Pill></>}
                    <div className="mut t-meta">
                      {r.lastOn ? `last paid ${r.lastOn}` : "never paid"}
                    </div>
                  </span>
                ) : <Pill tone="faint">paused</Pill>,
                act: isOwner ? (
                  <span style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button className="btn sm link" disabled={pending}
                      onClick={() => {
                        setEdit({
                          amount: (r.amountCents / 100).toFixed(2),
                          endsOn: r.endsOn, note: r.note, label: r.label,
                        });
                        setErr(""); setEditing(r);
                      }}>edit</button>
                    <button className="btn sm link" disabled={pending}
                      onClick={async () => {
                        if (r.active && !(await confirmDialog({
                          title: `Pause ${r.person}'s ${r.label}?`,
                          body: "It stops raising a row each month. What it has already paid stays on the record, and restarting it later does not back-pay the gap.",
                          action: "Pause it",
                        }))) return;
                        startTransition(async () => {
                          const res = await updateStipend(r.id, { active: !r.active });
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
            {formatCents(monthly)} a month across {rows.filter((r) => r.active).length} running
            arrangement{rows.filter((r) => r.active).length === 1 ? "" : "s"}.
          </div>
        </>
      )}

      {adding && (
        <Dialog open onClose={() => setAdding(false)} size="sm" title="New standing reimbursement"
          context="It raises itself every month onto their perks claim. You still mark the claim paid."
          footer={
            <>
              <DialogStatus error={err} problem={problem}
                ok={firstOn ? `First payment ${firstOn}` : undefined} />
              <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending || problem !== null}
                onClick={() => startTransition(async () => {
                  const res = await createStipend({
                    person: draft.person, label: draft.label, amount: draft.amount, kind: draft.kind,
                    ...terms,
                    startsOn: draft.startsOn, endsOn: draft.endsOn, note: draft.note,
                  });
                  if (res?.error) { setErr(res.error); return; }
                  toast({ message: `Set up - it pays first on ${firstOn}` });
                  setAdding(false);
                  router.refresh();
                })}>
                {pending ? "Setting up..." : "Set it up"}
              </button>
            </>
          }>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Who</label>
              <select value={draft.person} aria-label="Who it is for"
                onChange={(e) => setDraft({ ...draft, person: e.target.value })}>
                {roster.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label>Amount ($)</label>
              <input value={draft.amount} aria-label="Amount" inputMode="decimal" placeholder="35.00" autoFocus
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
          </div>
          <label>What it is</label>
          <input value={draft.label} aria-label="What it is" placeholder="Internet stipend"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <div className="field-hint">
            What it says on the claim each month: &quot;Internet stipend - August 2026&quot;.
          </div>
          <div className="pf2" style={{ marginTop: 8, marginBottom: 8 }}>
            <div>
              <label>Category</label>
              <select value={draft.kind} aria-label="Category"
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label>How often</label>
              <select value={draft.shape} aria-label="How often"
                onChange={(e) => setDraft({ ...draft, shape: e.target.value })}>
                {SHAPES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </div>
          </div>
          {/* Only the shape that needs one asks for one. */}
          {picksDay && (
            <div style={{ marginBottom: 8 }}>
              <label>Day of the month</label>
              <input value={draft.dayOfMonth} aria-label="Day of the month" inputMode="numeric"
                onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })} />
              <div className="field-hint">
                1 to 31. A 31 lands on the last day of every month - the 30th in April,
                the 28th in February - so a short month is never skipped.
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
          <div className="pf2">
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
          <div className="field-hint" style={{ marginTop: 8 }}>
            {/* The schedule said back as a sentence, plus the date it actually
                lands on. "Every 2 weeks on Friday from the 3rd" can be misread
                four ways, and the only thing that settles it is the date - so
                it is shown before anybody commits standing company money. */}
            {firstOn
              ? <>It pays <b>{stipendCadenceLabel(terms)}</b>, first on <b>{firstOn}</b>.
                  {" "}Leave the end date blank to run until you stop it.</>
              : "Pick the day it starts."}
          </div>
        </Dialog>
      )}

      {editing && (
        <Dialog open onClose={() => setEditing(null)} size="sm"
          title={`${editing.person}'s ${editing.label}`}
          context="Changing the amount does not re-price what has already been paid."
          footer={
            <>
              <DialogStatus error={err} />
              <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await updateStipend(editing.id, edit);
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
              <label>Amount ($)</label>
              <input value={edit.amount} aria-label="Amount" inputMode="decimal"
                onChange={(e) => setEdit({ ...edit, amount: e.target.value })} autoFocus />
            </div>
            <div>
              <label>Until</label>
              <input type="date" value={edit.endsOn} aria-label="Until"
                onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} />
            </div>
          </div>
          <label>What it is</label>
          <input value={edit.label} aria-label="What it is"
            onChange={(e) => setEdit({ ...edit, label: e.target.value })} />
          <label style={{ marginTop: 8 }}>Note</label>
          <input value={edit.note} aria-label="Note" placeholder="Agreed at the March review"
            onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
          <div className="field-hint" style={{ marginTop: 8 }}>
            {editing.lastOn
              ? `Last paid ${editing.lastOn}. Pausing stops the next one without touching that.`
              : "It has not paid yet."}
          </div>
        </Dialog>
      )}
    </Panel>
  );
}
