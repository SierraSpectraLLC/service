"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removePmPlan, setPmPlan } from "@/app/actions";
import {
  COVERAGE_LABEL, COVERAGE_TONE, coverageLine, PLAN_MAX_PER_YEAR, perYearLabel,
  type Coverage, type PlanRow,
} from "@/lib/pmPlan";
import { DataTable, Id, Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

export type CoverageRow = {
  instrumentId: number;
  externalId: string;
  label: string;
  category: string;
  coverage: Coverage;
};

/**
 * What this client is owed in preventive maintenance, and whether they got it.
 *
 * Two halves of one question, deliberately on one page. The top is the promise
 * - "every MS twice a year, every LC once" - which is a sentence somebody
 * agreed to and which had nowhere to live. The bottom is what actually
 * happened to each of their systems against it. Separating them into a
 * settings page and a report is how a plan becomes something nobody checks.
 */
export default function PmPlanPanel({
  orgId, orgName, plans, categories, rows, canEdit, year,
}: {
  orgId: number;
  orgName: string;
  plans: PlanRow[];
  /** The categories actually in this client's fleet, for the picker. */
  categories: string[];
  rows: CoverageRow[];
  canEdit: boolean;
  year: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({ category: "", perYear: "2", note: "" });
  const [err, setErr] = useState("");

  // A category already on the plan is not offered again: the row is one per
  // class, and picking a taken one would silently edit rather than add.
  const taken = new Set(plans.map((p) => p.category.trim().toLowerCase()));
  const open = categories.filter((c) => !taken.has(c.trim().toLowerCase()));
  const hasCatchAll = taken.has("");

  const save = (category: string, perYear: number, note = "") =>
    startTransition(async () => {
      const res = await setPmPlan(orgId, { category, perYear, note });
      if (res?.error) { setErr(res.error); toast({ message: res.error }); return; }
      setErr("");
      setDraft({ category: "", perYear: "2", note: "" });
      toast({ message: `${category || "Every system"}: ${perYearLabel(perYear)}` });
      router.refresh();
    });

  const drop = (p: PlanRow) =>
    startTransition(async () => {
      const ok = await confirmDialog({
        title: `Take ${p.category || "every system"} off the plan?`,
        body: "Their systems go back to reading “no plan”. Nothing already done is forgotten - this is the promise, not the history.",
        action: "Take it off",
      });
      if (!ok) return;
      const res = await removePmPlan(p.id);
      if (res?.error) { toast({ message: res.error }); return; }
      router.refresh();
    });

  return (
    <>
      <Panel
        title="Maintenance plan"
        count={plans.length || undefined}
        hint={`What ${orgName} is owed a year, by class of system. The catch-all covers anything no other row names.`}
        empty={canEdit
          ? "Nothing agreed yet. Add a row and their coverage below starts answering."
          : "No maintenance plan has been set for this account."}
      >
        {plans.length > 0 && (
          <DataTable
            cols={[
              { key: "what", label: "Systems", width: "minmax(160px, 1.4fr)" },
              { key: "rate", label: "Owed a year", width: "150px" },
              { key: "note", label: "Note", width: "minmax(120px, 1.2fr)" },
              ...(canEdit ? [{ key: "act", label: "", width: "170px", align: "right" as const }] : []),
            ]}
            rows={plans.map((p) => ({
              key: p.id,
              cells: {
                what: p.category
                  ? <span style={{ fontWeight: 600 }}>{p.category}</span>
                  : <span className="mut">Every other system</span>,
                rate: <Pill tone={p.perYear === 0 ? "faint" : "info"}>{perYearLabel(p.perYear)}</Pill>,
                note: p.note ? <span className="t-small">{p.note}</span> : <span className="mut">&mdash;</span>,
                ...(canEdit ? {
                  act: (
                    <span style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                      <label className="mut t-meta" htmlFor={`per-${p.id}`}>per year</label>
                      <input
                        id={`per-${p.id}`}
                        className="input sm mono"
                        type="number" min={0} max={PLAN_MAX_PER_YEAR}
                        defaultValue={p.perYear}
                        disabled={pending}
                        style={{ width: 62 }}
                        onBlur={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (Number.isInteger(n) && n !== p.perYear) save(p.category, n, p.note);
                        }}
                      />
                      <button className="btn sm link" disabled={pending} onClick={() => drop(p)}>remove</button>
                    </span>
                  ),
                } : {}),
              },
            }))}
          />
        )}

        {canEdit && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <select
              className="input sm" value={draft.category} disabled={pending}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              style={{ maxWidth: 200 }}
              aria-label="Which systems"
            >
              {/* The catch-all leads when it is still free: "everything gets one
                  a year" is the plan most shops actually have, and making them
                  name every class first is the version nobody fills in. */}
              {!hasCatchAll && <option value="">Every system</option>}
              {open.map((c) => <option key={c} value={c}>{c}</option>)}
              {open.length === 0 && hasCatchAll && <option value="">every class is already on the plan</option>}
            </select>
            <input
              className="input sm mono" type="number" min={0} max={PLAN_MAX_PER_YEAR}
              value={draft.perYear} disabled={pending} style={{ width: 62 }}
              onChange={(e) => setDraft((d) => ({ ...d, perYear: e.target.value }))}
              aria-label="Visits a year"
            />
            <span className="mut t-small">a year</span>
            <input
              className="input sm" placeholder="note, optional" value={draft.note} disabled={pending}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              style={{ maxWidth: 220 }}
            />
            <button
              className="btn sm primary"
              disabled={pending || (open.length === 0 && hasCatchAll)}
              onClick={() => save(draft.category, parseInt(draft.perYear, 10))}
            >
              Add
            </button>
            {err && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{err}</span>}
          </div>
        )}
        {canEdit && categories.length === 0 && (
          <div className="mut t-small" style={{ marginTop: 8 }}>
            None of their systems has a class set yet, so only the catch-all can be
            written. A system&apos;s class is the <b>Category</b> field on its own page.
          </div>
        )}
      </Panel>

      <Panel
        title={`Coverage in ${year}`}
        count={rows.length || undefined}
        hint="Every system they own, against the plan above. A PM is counted once per DAY it was worked - three schedules closed on one visit is one visit."
        empty="No systems on this account."
        actions={<Link className="btn sm" href="/maintenance/coverage">Every client</Link>}
      >
        {rows.length > 0 && (
          <DataTable
            cols={[
              { key: "system", label: "System", width: "minmax(160px, 1.5fr)" },
              { key: "class", label: "Class", width: "110px" },
              { key: "standing", label: "Standing", width: "130px" },
              { key: "detail", label: "This year", width: "minmax(180px, 1.6fr)" },
            ]}
            rows={rows.map((r) => ({
              key: r.instrumentId,
              href: `/instruments/${r.instrumentId}`,
              cells: {
                system: (
                  <span style={{ minWidth: 0, display: "block" }}>
                    <Id>{r.externalId}</Id>
                    {r.label && (
                      <span className="mut t-meta" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.label}
                      </span>
                    )}
                  </span>
                ),
                class: r.category
                  ? <span className="t-small">{r.category}</span>
                  : <span className="mut t-small">unclassed</span>,
                standing: (
                  <Pill tone={COVERAGE_TONE[r.coverage.state]}>
                    {COVERAGE_LABEL[r.coverage.state]}
                  </Pill>
                ),
                detail: <span className="mut t-small">{coverageLine(r.coverage)}</span>,
              },
            }))}
          />
        )}
      </Panel>
    </>
  );
}
