"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { addProcedure, forkProcedureForModel, updateProcedure } from "@/app/actions";
import Dialog, { DialogStatus, type DialogStep } from "@/components/ui/Dialog";
import PartNumberField from "./PartNumberField";
import { RESULT_LABEL, RESULT_TYPES } from "@/lib/checkout";
import { parseChecklist } from "@/lib/checklist";
import { QUALIFICATIONS } from "@/lib/gxp";
import { describeProcedure, type ProcPart } from "@/lib/procedures";
import { PROVENANCE_BLURB, PROVENANCE_CHOICES, PROVENANCE_LABEL } from "@/lib/provenance";
import {
  OP_LABEL, acceptanceUnits, criterionLabel, parseAcceptance, serializeAcceptance,
  type Acceptance, type Criterion, type CriterionOp,
} from "@/lib/testResult";
import type { ProcedureRow } from "./ProceduresPanel";

/**
 * The add/edit procedure dialog, rebuilt per prompt B3: five stepped sections
 * instead of eleven in one column, a scope LADDER instead of two chip
 * multi-selects, structured pass limits instead of prose, and a footer that
 * names the first problem instead of a banner that shouts before anyone has
 * typed. The Task/Test toggle stays - it is a real fork - and swaps only the
 * fields that differ; nothing else moves.
 */

export type ProcedureSheet = {
  assetType: string;
  /** Editing this row. Absent = creating. */
  id?: number;
  /** Prefill from this row, save as new (scope cleared by the caller's seed). */
  duplicateFrom?: number;
  /** The system type of the band this was launched from, when there was one. */
  bandCategory?: string;
};

type CritDraft = { op: CriterionOp; value: string; unit: string; center: string };

type ScopeChoice = "type" | "category" | "model" | "custom";

type Draft = {
  kind: string; name: string;
  // Task: what closing it records.
  taskRecord: "inspect" | "note" | "none";
  consumesPart: boolean;
  // Test: the result and its acceptance.
  resultType: string;
  criteria: CritDraft[];
  measuredWith: string; replicates: boolean;
  passHint: string; attachReading: boolean; unit: string;
  typicalLow: string; typicalHigh: string;
  prompt: string;
  /** Legacy prose limits, kept so a not-yet-migrated test round-trips. */
  target: string; tolerancePct: string;
  required: boolean; needsReport: boolean;
  // Where it lives.
  scopeChoice: ScopeChoice;
  scopeCategory: string;
  scopeModel: string;
  modelScope: string[]; categoryScope: string[];
  parts: ProcPart[];
  // When it runs.
  runsAtIntake: boolean; repeats: boolean;
  cadEvery: string; cadUnit: "days" | "months" | "injections" | "hours";
  // Steps and compliance.
  notes: string; checklist: string;
  qualification: string; provenance: string;
};

const STEPS: { key: string; label: string }[] = [
  { key: "what", label: "What it is" },
  { key: "where", label: "Where it lives" },
  { key: "when", label: "When it runs" },
  { key: "steps", label: "Steps & checklist" },
  { key: "compliance", label: "Compliance & provenance" },
];

const OPS: CriterionOp[] = ["gte", "lte", "lt", "gt", "pm"];

const emptyCrit = (): CritDraft => ({ op: "lte", value: "", unit: "", center: "" });

const critComplete = (c: CritDraft) =>
  Number.isFinite(parseFloat(c.value)) && c.unit.trim() !== ""
  && (c.op !== "pm" || Number.isFinite(parseFloat(c.center)));

const critToCriterion = (c: CritDraft): Criterion => ({
  op: c.op, value: parseFloat(c.value), unit: c.unit.trim(),
  ...(c.op === "pm" ? { center: parseFloat(c.center) } : {}),
});

/** intervalDays for the two calendar units; null for the usage units. */
const calendarDays = (every: number, unit: Draft["cadUnit"]): number | null =>
  unit === "days" ? every : unit === "months" ? every * 30 : null;

export default function ProcedureDialog({
  sheet, items, modelOptions, modelsByCategory, categories, categoriesByType, focus, onClose, onSaved,
}: {
  sheet: ProcedureSheet;
  items: ProcedureRow[];
  modelOptions: Record<string, string[]>;
  /** assetType -> system type -> the models of that type filed under it. */
  modelsByCategory?: Record<string, Record<string, string[]>>;
  categories: string[];
  categoriesByType: Record<string, string[]>;
  focus?: { assetType: string; model: string };
  onClose: () => void;
  onSaved: (name: string, id: number | undefined, extra: string) => void;
}) {
  const isSystem = sheet.assetType === "system";
  const editingRow = sheet.id ? items.find((x) => x.id === sheet.id) : undefined;
  const seedRow = editingRow ?? (sheet.duplicateFrom ? items.find((x) => x.id === sheet.duplicateFrom) : undefined);
  const served = isSystem ? categories : (categoriesByType[sheet.assetType] ?? []);
  const allModels = modelOptions[sheet.assetType] ?? [];

  const [draft, setDraft] = useState<Draft>(() => initDraft(sheet, seedRow, !!editingRow, focus, served));
  const up = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const [activeStep, setActiveStep] = useState("what");
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["what"]));
  const [applyScope, setApplyScope] = useState<"all" | "only">("all");
  const [applyNow, setApplyNow] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const secRefs = useRef<Record<string, HTMLElement | null>>({});

  const goStep = (key: string) => {
    setVisited((s) => new Set(s).add(activeStep).add(key));
    setActiveStep(key);
    secRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const stepIdx = STEPS.findIndex((s) => s.key === activeStep);

  const isTest = draft.kind === "test";
  const completeCriteria = draft.criteria.filter(critComplete);
  const legacyMeasured = isTest && draft.resultType === "measured"
    && completeCriteria.length === 0 && !!(draft.target.trim() || draft.tolerancePct.trim());

  // ── Scope ─────────────────────────────────────────────────────────────────
  const scopeArrays = (d: Draft): { modelScope: string[]; categoryScope: string[] } => {
    if (isSystem) {
      if (d.scopeChoice === "category" && d.scopeCategory) return { modelScope: [], categoryScope: [d.scopeCategory] };
      if (d.scopeChoice === "custom") return { modelScope: [], categoryScope: d.categoryScope };
      return { modelScope: [], categoryScope: [] };
    }
    if (d.scopeChoice === "model" && d.scopeModel) {
      return { modelScope: [d.scopeModel], categoryScope: d.scopeCategory ? [d.scopeCategory] : [] };
    }
    if (d.scopeChoice === "category" && d.scopeCategory) return { modelScope: [], categoryScope: [d.scopeCategory] };
    if (d.scopeChoice === "custom") return { modelScope: d.modelScope, categoryScope: d.categoryScope };
    return { modelScope: [], categoryScope: [] };
  };

  const modelsFor = (scope: { modelScope: string[]; categoryScope: string[] }): string[] => {
    if (isSystem) return [];
    if (scope.modelScope.length) return scope.modelScope;
    if (scope.categoryScope.length && modelsByCategory) {
      const inCats = new Set(scope.categoryScope.flatMap((c) => modelsByCategory[sheet.assetType]?.[c] ?? []));
      if (inCats.size) return allModels.filter((m) => inCats.has(m));
    }
    return allModels;
  };

  const scope = scopeArrays(draft);
  const covered = modelsFor(scope);
  const before = editingRow ? modelsFor({ modelScope: editingRow.modelScope, categoryScope: editingRow.categoryScope }) : null;
  const starts = before ? covered.filter((m) => !before.includes(m)) : [];
  const stops = before ? before.filter((m) => !covered.includes(m)) : [];

  // The ladder, most general first. A model rung only exists when a concrete
  // model is in hand (the model page, or an edit already scoped to one).
  const rungs: { key: ScopeChoice; label: string; desc: string; path: string }[] = [];
  if (isSystem) {
    rungs.push({ key: "type", label: "Every system", desc: "All system types in the workspace.", path: "Systems" });
    if (served.length) rungs.push({
      key: "category",
      label: draft.scopeCategory ? `Only ${draft.scopeCategory} systems` : "One system type",
      desc: "Just the systems filed under one type.",
      path: draft.scopeCategory ? `Systems > ${draft.scopeCategory}` : "Systems > ...",
    });
  } else {
    rungs.push({
      key: "type", label: `Every ${sheet.assetType.toLowerCase()}`,
      desc: `All system types, all models (${allModels.length} model${allModels.length === 1 ? "" : "s"}).`,
      path: sheet.assetType,
    });
    if (served.length > 1) {
      const catModels = draft.scopeCategory
        ? modelsFor({ modelScope: [], categoryScope: [draft.scopeCategory] }).length
        : null;
      rungs.push({
        key: "category",
        label: draft.scopeCategory ? `${sheet.assetType}s on ${draft.scopeCategory}` : `${sheet.assetType}s on one system type`,
        desc: catModels !== null ? `${catModels} model${catModels === 1 ? "" : "s"}.` : "Pick the system type.",
        path: draft.scopeCategory ? `${draft.scopeCategory} > ${sheet.assetType}` : "...",
      });
    }
    if (draft.scopeModel) rungs.push({
      key: "model", label: `Only ${draft.scopeModel}`, desc: "This model and nothing else.",
      path: `${draft.scopeCategory ? `${draft.scopeCategory} > ` : ""}${sheet.assetType} > ${draft.scopeModel}`,
    });
  }
  if (draft.scopeChoice === "custom" || hasCustomScope(seedRow, isSystem)) {
    const kept = isSystem ? draft.categoryScope : draft.modelScope;
    rungs.push({
      key: "custom", label: "Keep its current scope", desc: kept.join(", ") || "as stored",
      path: "unchanged",
    });
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const cadN = parseInt(draft.cadEvery, 10);
  const cadValid = Number.isInteger(cadN) && cadN > 0;
  const timingValid = draft.runsAtIntake || (draft.repeats && cadValid);

  const stepProblem = (key: string): string | null => {
    if (key === "what") {
      if (!draft.name.trim()) return "name it";
      if (isTest && draft.resultType === "measured" && completeCriteria.length === 0 && !legacyMeasured) return "add a pass limit";
      if (isTest && draft.resultType === "reading" && !draft.unit.trim()) return "give the reading a unit";
      return null;
    }
    if (key === "when") {
      if (!timingValid) return draft.repeats && !cadValid ? "the cadence needs a whole number above zero" : "pick when it runs: at intake, on a cadence, or both";
      return null;
    }
    return null;
  };
  const problem = stepProblem("what") ?? stepProblem("when");

  const steps: DialogStep[] = STEPS.map((s) => ({
    ...s,
    warn: visited.has(s.key) && stepProblem(s.key) !== null,
    done: visited.has(s.key) && s.key !== activeStep && stepProblem(s.key) === null,
  }));

  // ── Timing change notice (edit only) ──────────────────────────────────────
  const effectiveInterval = draft.repeats ? calendarDays(cadN || 0, draft.cadUnit) : null;
  const beforeInterval = editingRow?.intervalDays ?? null;
  const timingChange = editingRow
    ? beforeInterval === null && effectiveInterval !== null ? "added"
      : beforeInterval !== null && effectiveInterval === null ? "removed"
      : beforeInterval !== null && effectiveInterval !== null && beforeInterval !== effectiveInterval ? "changed"
      : null
    : null;

  const sharedBeyondFocus = !!(focus && editingRow
    && (editingRow.modelScope.length === 0 || editingRow.modelScope.length > 1));

  // Units already used across the library, for the unit autocomplete.
  const knownUnits = useMemo(() => {
    const seen = new Set<string>();
    for (const i of items) {
      const a = parseAcceptance(i.acceptance ?? "");
      for (const u of acceptanceUnits(a)) seen.add(u);
      if (a.unit) seen.add(a.unit);
    }
    for (const c of draft.criteria) if (c.unit.trim()) seen.add(c.unit.trim());
    return [...seen].sort();
  }, [items, draft.criteria]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const buildAcceptance = (): Acceptance => {
    if (draft.resultType === "measured") {
      return {
        criteria: completeCriteria.map(critToCriterion),
        measuredWith: draft.measuredWith, replicates: draft.replicates,
      };
    }
    if (draft.resultType === "pass_fail") {
      return { passHint: draft.passHint, attachReading: draft.attachReading, unit: draft.attachReading ? draft.unit : "" };
    }
    if (draft.resultType === "reading") {
      return {
        unit: draft.unit,
        typicalLow: parseFloat(draft.typicalLow) || undefined,
        typicalHigh: parseFloat(draft.typicalHigh) || undefined,
      };
    }
    return { prompt: draft.prompt };
  };

  const save = () => {
    if (problem) return;
    setError("");
    const arrays = scopeArrays(draft);
    const usageCadence = draft.repeats && (draft.cadUnit === "injections" || draft.cadUnit === "hours")
      ? { every: cadN, unit: draft.cadUnit } : null;
    const payload = {
      assetType: sheet.assetType, kind: draft.kind, name: draft.name, notes: draft.notes,
      resultType: isTest ? draft.resultType : (draft.taskRecord === "inspect" ? "inspect_replace" : "pass_fail"),
      // Prose limits survive only while nothing structured replaces them; a
      // note's prompt also rides in target for the older readers of it.
      target: isTest
        ? (draft.resultType === "note" ? draft.prompt
          : draft.resultType === "measured" && completeCriteria.length === 0 ? draft.target : "")
        : "",
      tolerancePct: isTest && draft.resultType === "measured" && completeCriteria.length === 0 ? draft.tolerancePct : "",
      acceptance: isTest ? buildAcceptance() : undefined,
      requiresNote: !isTest && draft.taskRecord === "note",
      consumesPart: !isTest && draft.consumesPart,
      runsAtIntake: draft.runsAtIntake,
      intervalDays: draft.repeats && effectiveInterval !== null ? effectiveInterval : null,
      usage: usageCadence,
      required: draft.required,
      needsReport: isTest && draft.needsReport,
      qualification: draft.qualification,
      parts: draft.parts, modelScope: arrays.modelScope, categoryScope: arrays.categoryScope,
      checklist: draft.checklist, provenance: draft.provenance,
    };
    startTransition(async () => {
      const res = sheet.id
        ? (focus && sharedBeyondFocus && applyScope === "only"
          ? await forkProcedureForModel(sheet.id, focus.model, { ...payload, modelScope: [focus.model] })
          : await updateProcedure(sheet.id, payload, timingChange !== null && applyNow))
        : await addProcedure(payload);
      if (res?.error) { setError(res.error); return; }
      const extra = res && "applied" in res && res.applied ? ` - scheduled on ${res.applied} existing unit${res.applied === 1 ? "" : "s"}`
        : res && "retimed" in res && res.retimed ? ` - re-timed ${res.retimed} existing schedule${res.retimed === 1 ? "" : "s"}`
        : res && "unscheduled" in res && res.unscheduled ? ` - unscheduled from ${res.unscheduled} unit${res.unscheduled === 1 ? "" : "s"}`
        : "";
      onSaved(draft.name.trim(), sheet.id, extra);
    });
  };

  const saveLabel = isSystem
    ? (draft.scopeChoice === "category" && draft.scopeCategory ? `Save to ${draft.scopeCategory} systems`
      : draft.scopeChoice === "custom" ? "Save procedure" : "Save to every system")
    : draft.scopeChoice === "model" && draft.scopeModel ? `Save to ${draft.scopeModel} only`
      : draft.scopeChoice === "category" && draft.scopeCategory ? `Save to ${sheet.assetType}s on ${draft.scopeCategory}`
      : draft.scopeChoice === "custom" ? "Save procedure"
      : `Save to every ${sheet.assetType.toLowerCase()}`;

  const okLine = isSystem
    ? describeProcedure({
        assetType: "system", runsAtIntake: draft.runsAtIntake, intervalDays: effectiveInterval,
        usage: draft.repeats && (draft.cadUnit === "injections" || draft.cadUnit === "hours") && cadValid
          ? { every: cadN, unit: draft.cadUnit } : null,
        modelScope: [], categoryScope: scope.categoryScope, parts: draft.parts,
      })
    : `Covers ${covered.length} model${covered.length === 1 ? "" : "s"}`;

  // ── Section renderer: all five stacked on desktop (step nav scrolls); one
  // at a time on a phone (CSS hides the inactive ones). A plain function, not
  // a component: a component defined inside render would remount its subtree
  // on every keystroke and throw focus out of the inputs.
  const section = (k: string, title: string, children: React.ReactNode) => (
    <section key={k} ref={(el) => { secRefs.current[k] = el; }} className="dialog-stepsec"
      data-active={activeStep === k || undefined}>
      <div className="dialog-section">{title}</div>
      {children}
    </section>
  );

  const check = (label: string, hint: string, on: boolean, set: (v: boolean) => void) => (
    <label className="t-small" style={{ display: "flex", alignItems: "flex-start", gap: 6, margin: 0, fontWeight: 400, color: "var(--ink)", flex: "1 1 220px" }}>
      <input type="checkbox" checked={on} style={{ width: 15, height: 15, marginTop: 2 }}
        onChange={(e) => set(e.target.checked)} />
      <span>{label}<span className="mut t-meta" style={{ display: "block" }}>{hint}</span></span>
    </label>
  );

  return (
    <Dialog open size="lg" onClose={onClose}
      title={sheet.id ? `Edit · ${draft.name || "procedure"}` : "New procedure"}
      context={`${isSystem ? "Systems" : sheet.assetType}${sheet.bandCategory ? ` · launched from ${sheet.bandCategory}` : focus ? ` · launched from ${focus.model}` : ""}`}
      steps={steps} activeStep={activeStep} onStepSelect={goStep}
      footer={
        <>
          <DialogStatus error={error} problem={problem} ok={okLine} />
          <span className="proc-mnav" style={{ display: "contents" }}>
            {stepIdx > 0 && (
              <button className="btn proc-mnav-btn" onClick={() => goStep(STEPS[stepIdx - 1].key)}>&lsaquo; Back</button>
            )}
            {stepIdx < STEPS.length - 1 && (
              <button className="btn proc-mnav-btn" onClick={() => goStep(STEPS[stepIdx + 1].key)}>
                Next: {STEPS[stepIdx + 1].label}
              </button>
            )}
          </span>
          <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn accent" onClick={save} disabled={pending || !!problem}>
            {pending ? "Saving..." : saveLabel}
          </button>
        </>
      }>
      <datalist id="proc-units">{knownUnits.map((u) => <option key={u} value={u} />)}</datalist>

      {/* The Task / Test fork, above the steps: it decides which fields exist. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div className="seg" role="group" aria-label="Procedure kind">
          {(["task", "test"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => up({ kind: k })}>
              {k === "task" ? "☐ Task" : "◎ Test"}
            </button>
          ))}
        </div>
        <span className="mut t-meta">Only the fields that differ swap; everything else stays put.</span>
      </div>

      {section("what", "What it is", <>
        <label>Name *</label>
        <input value={draft.name} onChange={(e) => up({ name: e.target.value })}
          onBlur={() => setVisited((s) => new Set(s).add("what"))}
          placeholder={isTest ? "e.g. Flow Check" : "e.g. Replace inlet septum"}
          style={{ marginBottom: 10 }} />

        {!isTest && (
          <>
            <label>When done, record</label>
            <div className="seg" role="group" aria-label="When done, record" style={{ marginBottom: 4 }}>
              {([["inspect", "Inspected / replaced"], ["note", "Note"], ["none", "Nothing"]] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={draft.taskRecord === k} onClick={() => up({ taskRecord: k })}>{l}</button>
              ))}
            </div>
            <div className="mut t-meta" style={{ marginBottom: 10 }}>
              {draft.taskRecord === "inspect"
                ? "The task closes only by recording which happened - inspected (what was found) or replaced (what went in) - with name and time, like a test result."
                : draft.taskRecord === "note"
                  ? "The task closes only with a note about what was done."
                  : "A tick is the whole record."}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6 }}>
              {check("Required for sign-off", "Nobody can sign off until this is done.",
                draft.required, (v) => up({ required: v }))}
              {check("Consumes a part", "The generated task carries its part list to the bench.",
                draft.consumesPart, (v) => up({ consumesPart: v }))}
            </div>
          </>
        )}

        {isTest && (
          <>
            <label>Result</label>
            <div className="seg" role="group" aria-label="Result type" style={{ flexWrap: "wrap", marginBottom: 8 }}>
              {RESULT_TYPES.map((rt) => (
                <button key={rt} type="button" aria-pressed={draft.resultType === rt}
                  onClick={() => up({ resultType: rt })}>
                  {RESULT_LABEL[rt]}
                </button>
              ))}
            </div>

            {/* The acceptance block: the one region that swaps per result type. */}
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, background: "#FAFBFD" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <span className="t-small" style={{ fontWeight: 700 }}>Acceptance</span>
                {draft.resultType === "measured" && <span className="pill good">graded automatically</span>}
                {draft.resultType === "reading" && <span className="pill neutral">recorded, not judged</span>}
              </div>

              {draft.resultType === "pass_fail" && (
                <>
                  <label>What counts as a pass</label>
                  <textarea value={draft.passHint} rows={2}
                    onChange={(e) => up({ passHint: e.target.value })}
                    placeholder="Shown to the tech as guidance (optional)"
                    className="t-body" style={{ width: "100%", marginBottom: 8, resize: "vertical" }} />
                  {check("Attach a reading too", "The tech records a number and unit alongside the verdict; stored, not graded.",
                    draft.attachReading, (v) => up({ attachReading: v }))}
                  {draft.attachReading && (
                    <div style={{ marginTop: 6, maxWidth: 180 }}>
                      <label>Unit</label>
                      <input value={draft.unit} list="proc-units" onChange={(e) => up({ unit: e.target.value })}
                        placeholder="e.g. mL/min" className="t-body" />
                    </div>
                  )}
                </>
              )}

              {draft.resultType === "measured" && (
                <>
                  <label>Measured with</label>
                  <input value={draft.measuredWith} onChange={(e) => up({ measuredWith: e.target.value })}
                    placeholder="Standard, tool or method - e.g. Caffeine standard, 6 replicate injections"
                    className="t-body" style={{ marginBottom: 8 }} />
                  {legacyMeasured && (
                    <div className="t-small" style={{ padding: "6px 9px", borderRadius: 8, background: "var(--t-warn-bg)", color: "var(--t-warn-fg)", marginBottom: 8 }}>
                      Prose limits from before structured criteria: target {draft.target || "(none)"}
                      {draft.tolerancePct ? ` ± ${draft.tolerancePct}%` : ""}. Add pass limits below to replace
                      them; until then this test stays in the Needs review filter.
                    </div>
                  )}
                  <label>Passes when</label>
                  {draft.criteria.map((c, idx) => {
                    const setC = (patch: Partial<CritDraft>) =>
                      up({ criteria: draft.criteria.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
                    return (
                      <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                        {idx > 0 && <span className="pill faint">OR</span>}
                        <select value={c.op} aria-label="Operator" className="t-body" style={{ width: "auto" }}
                          onChange={(e) => setC({ op: e.target.value as CriterionOp })}>
                          {OPS.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
                        </select>
                        <input value={c.value} inputMode="decimal" aria-label="Limit value" placeholder="0.15"
                          className="mono t-body" style={{ width: 84 }}
                          onChange={(e) => setC({ value: e.target.value })} />
                        {c.op === "pm" && (
                          <>
                            <span className="mut t-small">of</span>
                            <input value={c.center} inputMode="decimal" aria-label="Center value" placeholder="1.00"
                              className="mono t-body" style={{ width: 84 }}
                              onChange={(e) => setC({ center: e.target.value })} />
                          </>
                        )}
                        <input value={c.unit} list="proc-units" aria-label="Unit" placeholder="unit, e.g. %RSD"
                          className="t-body" style={{ width: 120 }}
                          onChange={(e) => setC({ unit: e.target.value })} />
                        {draft.criteria.length > 1 && (
                          <button type="button" className="btn link danger" aria-label="Remove this criterion"
                            onClick={() => up({ criteria: draft.criteria.filter((_, i) => i !== idx) })}>✕</button>
                        )}
                      </div>
                    );
                  })}
                  <button type="button" className="btn sm" style={{ marginBottom: 8 }}
                    onClick={() => up({ criteria: [...draft.criteria, emptyCrit()] })}>
                    + Alternate criterion
                  </button>
                  <div className="mut t-meta" style={{ marginBottom: 6 }}>
                    Criteria with different units mean the tech may enter either; the result passes
                    if any criterion is met.
                  </div>
                  {check("Also record the raw replicates", "The work-order form presents the replicate readings plus the computed value.",
                    draft.replicates, (v) => up({ replicates: v }))}
                </>
              )}

              {draft.resultType === "reading" && (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ maxWidth: 160 }}>
                      <label>Unit *</label>
                      <input value={draft.unit} list="proc-units" onChange={(e) => up({ unit: e.target.value })}
                        placeholder="e.g. counts" className="t-body" />
                    </div>
                    <div style={{ maxWidth: 130 }}>
                      <label>Typical low</label>
                      <input value={draft.typicalLow} inputMode="decimal" onChange={(e) => up({ typicalLow: e.target.value })}
                        placeholder="optional" className="mono t-body" />
                    </div>
                    <div style={{ maxWidth: 130 }}>
                      <label>Typical high</label>
                      <input value={draft.typicalHigh} inputMode="decimal" onChange={(e) => up({ typicalHigh: e.target.value })}
                        placeholder="optional" className="mono t-body" />
                    </div>
                  </div>
                  <div className="mut t-meta" style={{ marginTop: 4 }}>
                    The typical range is a muted hint for the tech. It never produces a fail.
                  </div>
                </>
              )}

              {draft.resultType === "note" && (
                <>
                  <label>Prompt for the tech</label>
                  <input value={draft.prompt} onChange={(e) => up({ prompt: e.target.value })}
                    placeholder='e.g. "Describe spray stability at 0.2 mL/min"' className="t-body" />
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
              {check("Required for sign-off", "Nobody can sign off until this test is done.",
                draft.required, (v) => up({ required: v }))}
              {check("Needs a report attached", "A file - tune report, printout, photo - must be on the result before sign-off.",
                draft.needsReport, (v) => up({ needsReport: v }))}
            </div>

            {/* The row as the tech will meet it on the work order. */}
            <div className="proc-preview">
              <div className="mut t-meta" style={{ marginBottom: 4 }}>On the work order:</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="t-body" style={{ fontWeight: 700 }}>{draft.name.trim() || "Test name"}</span>
                {draft.resultType === "pass_fail" && (
                  <>
                    <span className="seg" aria-hidden="true"><button type="button" tabIndex={-1}>Pass</button><button type="button" tabIndex={-1}>Fail</button></span>
                    {draft.attachReading && <span className="proc-prevbox mono">{draft.unit || "reading"}</span>}
                  </>
                )}
                {draft.resultType === "measured" && (
                  <>
                    {(acceptanceUnits({ criteria: completeCriteria.map(critToCriterion) }).length
                      ? acceptanceUnits({ criteria: completeCriteria.map(critToCriterion) }) : ["unit"]).map((u) => (
                      <span key={u} className="proc-prevbox mono">{u}</span>
                    ))}
                    <span className="mut t-meta">
                      {completeCriteria.length
                        ? `passes ${completeCriteria.map((c) => criterionLabel(critToCriterion(c))).join(" or ")}`
                        : "add a pass limit"}
                    </span>
                    <span className="pill good">Pass</span>
                  </>
                )}
                {draft.resultType === "reading" && (
                  <>
                    <span className="proc-prevbox mono">{draft.unit || "unit"}</span>
                    {(draft.typicalLow || draft.typicalHigh) && (
                      <span className="pill neutral">typically {draft.typicalLow || "?"} to {draft.typicalHigh || "?"}</span>
                    )}
                  </>
                )}
                {draft.resultType === "note" && (
                  <span className="proc-prevbox" style={{ minWidth: 180 }}>
                    <span className="mut t-small">{draft.prompt.trim() || "What you found"}</span>
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </>)}

      {section("where", "Where it lives", <>
        <div className="proc-scope" role="radiogroup" aria-label="Where it lives">
          {rungs.map((r) => (
            <label key={r.key} className={`proc-rung${draft.scopeChoice === r.key ? " on" : ""}`}>
              <input type="radio" name="proc-scope" checked={draft.scopeChoice === r.key}
                onChange={() => up({ scopeChoice: r.key })} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="t-body" style={{ fontWeight: 700, display: "block" }}>{r.label}</span>
                <span className="mut t-small">{r.desc}</span>
                {r.key === "category" && draft.scopeChoice === "category" && served.length > 1 && (
                  <select value={draft.scopeCategory} className="t-small" style={{ width: "auto", display: "block", marginTop: 4 }}
                    aria-label="Which system type" onChange={(e) => up({ scopeCategory: e.target.value })}>
                    {!draft.scopeCategory && <option value="">Pick a system type...</option>}
                    {served.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </span>
              <span className="mono t-meta mut proc-rung-path">{r.path}</span>
            </label>
          ))}
        </div>

        {!isSystem && (
          <div className="proc-covers">
            <div className="t-small" style={{ fontWeight: 700, marginBottom: 2 }}>
              Covers {covered.length} model{covered.length === 1 ? "" : "s"}
              {covered.length > 0 && ":"}
            </div>
            {covered.length > 0 && (
              <div className="mono t-small" style={{ color: "var(--slate)" }}>
                {covered.slice(0, 8).join(", ")}{covered.length > 8 ? ` +${covered.length - 8} more` : ""}
              </div>
            )}
            <div className="mut t-meta" style={{ marginTop: 4 }}>
              Need to leave one out? Save, then turn it off on that model&apos;s page.
            </div>
            {starts.length > 0 && (
              <div className="t-small" style={{ color: "var(--t-warn-fg)", marginTop: 4 }}>
                Starts applying to {starts.length} model{starts.length === 1 ? "" : "s"}: {starts.slice(0, 8).join(", ")}{starts.length > 8 ? ` +${starts.length - 8} more` : ""}
              </div>
            )}
            {stops.length > 0 && (
              <div className="t-small" style={{ color: "var(--t-warn-fg)", marginTop: 2 }}>
                Stops applying to {stops.length} model{stops.length === 1 ? "" : "s"}: {stops.slice(0, 8).join(", ")}{stops.length > 8 ? ` +${stops.length - 8} more` : ""}
              </div>
            )}
          </div>
        )}

        {/* Parts live with scope: which part fits is a property of which
            models this covers. */}
        <label style={{ marginTop: 10 }}>Parts it takes</label>
        <div>
          {draft.parts.map((pt, idx) => {
            const partModels = pt.models ?? [];
            const pool = covered.filter((m) => !partModels.includes(m));
            const setPart = (patch: Partial<ProcPart>) =>
              up({ parts: draft.parts.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
            return (
              <div key={idx} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <input type="number" min={1} max={999} value={pt.qty ?? ""} placeholder="1"
                    aria-label="How many this job takes"
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setPart({ qty: Number.isFinite(n) && n > 1 ? n : undefined });
                    }}
                    className="t-body" style={{ width: 56 }} />
                  <PartNumberField value={pt.number} style={{ flex: 1 }}
                    onChange={(number) => setPart({ number })}
                    onPick={(part) => setPart({ number: part.partNumber, name: pt.name.trim() || part.name })} />
                  <PartNumberField value={pt.name} insert="name" className="" ariaLabel="Part name"
                    placeholder="Name (optional)" style={{ flex: 1 }}
                    onChange={(name) => setPart({ name })}
                    onPick={(part) => setPart({ name: part.name || part.partNumber, number: pt.number.trim() || part.partNumber })} />
                  <button className="btn link danger" aria-label="Remove part"
                    onClick={() => up({ parts: draft.parts.filter((_, i) => i !== idx) })}>✕</button>
                </div>
                {!isSystem && covered.length > 0 && (
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                    <span className="mut t-meta">fits</span>
                    {partModels.length === 0 && <span className="pill faint">all {covered.length}</span>}
                    {partModels.map((m) => (
                      <span key={m} className="pill accent" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {m}
                        <button type="button" className="chip-x t-small" aria-label={`This part no longer fits ${m}`}
                          onClick={() => setPart({ models: partModels.filter((x) => x !== m) })}
                          style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                      </span>
                    ))}
                    {pool.length > 0 && (
                      <select value="" aria-label="Limit this part to a model"
                        onChange={(e) => { if (e.target.value) setPart({ models: [...partModels, e.target.value] }); }}
                        className="t-meta" style={{ width: "auto", padding: "2px 6px" }}>
                        <option value="">+ model...</option>
                        {pool.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="btn sm"
            onClick={() => up({ parts: [...draft.parts, { name: "", number: "" }] })}>
            + Part
          </button>
          <div className="mut t-meta" style={{ marginTop: 6 }}>
            Same work, different part per model? Tag the part with the models it fits and keep
            one procedure.
          </div>
        </div>
      </>)}

      {section("when", "When it runs", <>
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: "8px 10px", marginBottom: 8 }}>
          {check(
            "At intake",
            `Created once when a ${isSystem ? "system" : "unit of a covered model"} is added.`,
            draft.runsAtIntake, (v) => up({ runsAtIntake: v }))}
          <div style={{ marginTop: 8 }}>
            {check(
              "On a cadence",
              `Scheduled on every covered ${isSystem ? "system" : "unit"}, existing and new.`,
              draft.repeats, (v) => up({ repeats: v }))}
          </div>
          {draft.repeats && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8, paddingLeft: 21 }}>
              <span className="t-small">Every</span>
              <input value={draft.cadEvery} inputMode="numeric" aria-label="Cadence count"
                onChange={(e) => up({ cadEvery: e.target.value })}
                className="mono t-body" style={{ width: 76 }} />
              <select value={draft.cadUnit} aria-label="Cadence unit" className="t-small" style={{ width: "auto" }}
                onChange={(e) => up({ cadUnit: e.target.value as Draft["cadUnit"] })}>
                <option value="days">days</option>
                <option value="months">months</option>
                <option value="injections">injections</option>
                <option value="hours">hours</option>
              </select>
              {(draft.cadUnit === "injections" || draft.cadUnit === "hours") && (
                <span className="mut t-meta">
                  Usage-based: shown on the procedure and its intake tasks; nothing counts
                  {" "}{draft.cadUnit} for us, so the calendar never schedules it.
                </span>
              )}
            </div>
          )}
        </div>

        {timingChange && (
          <div className="t-small" style={{ padding: "8px 10px", borderRadius: 8, background: "var(--t-warn-bg)", color: "var(--t-warn-fg)", marginBottom: 8 }}>
            {timingChange === "changed" && <>Existing units keep their current cadence; only units added from now on get the new one.</>}
            {timingChange === "added" && <>Only units added from now on get this schedule; existing units stay unscheduled.</>}
            {timingChange === "removed" && <>Existing units keep their schedules; this only stops new units from getting one.</>}
            <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 0", fontWeight: 700 }}>
              <input type="checkbox" checked={applyNow} style={{ width: 15, height: 15 }}
                onChange={(e) => setApplyNow(e.target.checked)} />
              {timingChange === "changed" && "Also re-time existing units now"}
              {timingChange === "added" && "Also schedule existing units now"}
              {timingChange === "removed" && "Also remove existing schedules now (their tasks stay)"}
            </label>
          </div>
        )}
      </>)}

      {section("steps", "Steps & checklist", <>
        <div className="pf2">
          <div>
            <label>Notes</label>
            <textarea value={draft.notes} rows={5}
              onChange={(e) => up({ notes: e.target.value })}
              placeholder="What doing this involves (optional)"
              className="t-body" style={{ width: "100%", resize: "vertical" }} />
          </div>
          <div>
            <label>
              Checklist
              <span className="mut t-meta" style={{ display: "block", fontWeight: 400 }}>
                One line per step; end a line with a colon to make it a heading.
              </span>
            </label>
            <textarea value={draft.checklist} rows={5}
              onChange={(e) => up({ checklist: e.target.value })}
              placeholder={"Remove & Sonicate:\nLow-Pressure Funnel Assembly\nHigh-Pressure Funnel Assembly"}
              className="t-body" style={{ width: "100%", resize: "vertical" }} />
            {(() => {
              const n = parseChecklist(draft.checklist).filter((l) => !l.heading).length;
              return n ? <div className="mut t-meta" style={{ marginTop: 2 }}>{n} box{n === 1 ? "" : "es"} on every task this makes.</div> : null;
            })()}
          </div>
        </div>
      </>)}

      {section("compliance", "Compliance & provenance", <>
        <details open={draft.qualification !== "" || draft.provenance !== ""}>
          <summary className="t-small" style={{ cursor: "pointer", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill neutral">Qualification: {draft.qualification || "none"}</span>
            <span className="pill neutral">Source: {draft.provenance ? PROVENANCE_LABEL[draft.provenance as keyof typeof PROVENANCE_LABEL] : "not saying"}</span>
          </summary>
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0", flexWrap: "wrap" }}>
            <label style={{ margin: 0 }}>Qualification</label>
            <div className="seg" role="group" aria-label="Qualification">
              {["", ...QUALIFICATIONS].map((q) => (
                <button key={q || "none"} type="button" aria-pressed={draft.qualification === q}
                  onClick={() => up({ qualification: q })}>
                  {q || "None"}
                </button>
              ))}
            </div>
            <span className="mut t-meta">Groups this under IQ/OQ/PQ on regulated (GxP) systems. Others ignore it.</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
            <label style={{ margin: 0 }}>Where it came from</label>
            <div className="seg" role="group" aria-label="Where it came from">
              {["", ...PROVENANCE_CHOICES].map((c) => (
                <button key={c || "none"} type="button" aria-pressed={draft.provenance === c}
                  onClick={() => up({ provenance: c })}>
                  {c ? PROVENANCE_LABEL[c as keyof typeof PROVENANCE_LABEL] : "Not saying"}
                </button>
              ))}
            </div>
          </div>
          <div className="mut t-meta">
            {PROVENANCE_BLURB[(draft.provenance || "") as keyof typeof PROVENANCE_BLURB]}
          </div>
        </details>

        {focus && sharedBeyondFocus && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "#F5F2FB" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="t-small" style={{ fontWeight: 700 }}>Apply this edit to</span>
              <div className="seg" role="group" aria-label="Apply this edit to">
                <button type="button" aria-pressed={applyScope === "all"} onClick={() => setApplyScope("all")}>
                  All covered models
                </button>
                <button type="button" aria-pressed={applyScope === "only"} onClick={() => setApplyScope("only")}>
                  Only {focus.model}
                </button>
              </div>
            </div>
            <div className="mut t-meta" style={{ marginTop: 4 }}>
              {applyScope === "all"
                ? `Other models using this procedure get the change too${editingRow?.modelScope.length ? ` (${editingRow.modelScope.length} models)` : " (every model of the type)"}.`
                : `${focus.model} gets its own copy with this edit; the shared version stays as it was for everyone else, and ${focus.model}'s existing schedules follow the copy.`}
            </div>
          </div>
        )}
      </>)}
    </Dialog>
  );
}

/** Whether the stored scope fits no ladder rung and must be kept verbatim. */
function hasCustomScope(row: ProcedureRow | undefined, isSystem: boolean): boolean {
  if (!row) return false;
  if (isSystem) return row.categoryScope.length > 1;
  return row.modelScope.length > 1 || (row.modelScope.length === 0 && row.categoryScope.length > 1);
}

function initDraft(
  sheet: ProcedureSheet, row: ProcedureRow | undefined, editing: boolean,
  focus: { assetType: string; model: string } | undefined, served: string[],
): Draft {
  const isSystem = sheet.assetType === "system";
  const acc = parseAcceptance(row?.acceptance ?? "");
  const isTest = row?.kind === "test";

  // Scope: read the stored arrays back onto the ladder; anything the ladder
  // can't say is kept verbatim under the "custom" rung.
  // A duplicate deliberately drops the model narrowing (the caller's seed).
  const modelScope = editing ? (row?.modelScope ?? []) : (sheet.duplicateFrom ? [] : row?.modelScope ?? []);
  const categoryScope = row?.categoryScope ?? [];
  let scopeChoice: ScopeChoice;
  let scopeModel = "";
  let scopeCategory = sheet.bandCategory ?? "";
  if (row && (editing || sheet.duplicateFrom)) {
    if (isSystem) {
      scopeChoice = categoryScope.length === 0 ? "type" : categoryScope.length === 1 ? "category" : "custom";
      scopeCategory = categoryScope[0] ?? scopeCategory;
    } else if (modelScope.length === 1) {
      scopeChoice = "model"; scopeModel = modelScope[0]; scopeCategory = categoryScope[0] ?? scopeCategory;
    } else if (modelScope.length > 1 || categoryScope.length > 1) {
      scopeChoice = "custom";
    } else if (categoryScope.length === 1) {
      scopeChoice = "category"; scopeCategory = categoryScope[0];
    } else {
      scopeChoice = "type";
    }
  } else if (focus) {
    scopeChoice = "model"; scopeModel = focus.model;
  } else if (sheet.bandCategory && served.length > 1) {
    scopeChoice = "category";
  } else {
    scopeChoice = "type";
  }

  // Cadence: months when the stored days divide evenly (30/90/180 read as
  // 1/3/6 months); otherwise days. Usage cadence wins the display when set.
  let cadEvery = "365"; let cadUnit: Draft["cadUnit"] = "days"; let repeats = false;
  if (row?.usageEvery && row?.usageUnit) {
    repeats = true; cadEvery = String(row.usageEvery); cadUnit = row.usageUnit as Draft["cadUnit"];
  } else if (row && row.intervalDays !== null) {
    repeats = true;
    if (row.intervalDays % 30 === 0 && row.intervalDays >= 30 && row.intervalDays < 365) {
      cadEvery = String(row.intervalDays / 30); cadUnit = "months";
    } else {
      cadEvery = String(row.intervalDays);
    }
  }

  return {
    kind: row?.kind ?? "task",
    name: row?.name ?? "",
    taskRecord: row?.resultType === "inspect_replace" ? "inspect" : row?.requiresNote ? "note" : "none",
    consumesPart: row?.consumesPart ?? false,
    resultType: isTest ? (row?.resultType ?? "pass_fail") : "pass_fail",
    criteria: acc.criteria?.length
      ? acc.criteria.map((c) => ({ op: c.op, value: String(c.value), unit: c.unit, center: c.center !== undefined ? String(c.center) : "" }))
      : [emptyCrit()],
    measuredWith: acc.measuredWith ?? "",
    replicates: acc.replicates ?? false,
    passHint: acc.passHint ?? "",
    attachReading: acc.attachReading ?? false,
    unit: acc.unit ?? "",
    typicalLow: acc.typicalLow !== undefined ? String(acc.typicalLow) : "",
    typicalHigh: acc.typicalHigh !== undefined ? String(acc.typicalHigh) : "",
    prompt: acc.prompt ?? (isTest && row?.resultType === "note" ? row?.target ?? "" : ""),
    target: row?.target ?? "",
    tolerancePct: row?.tolerancePct ?? "",
    required: row?.required ?? false,
    needsReport: row?.needsReport ?? false,
    scopeChoice, scopeCategory, scopeModel,
    modelScope, categoryScope,
    parts: (row?.parts ?? []).map((p) => ({ ...p })),
    runsAtIntake: row?.runsAtIntake ?? false,
    repeats, cadEvery, cadUnit,
    notes: row?.notes ?? "",
    checklist: row?.checklist ?? "",
    qualification: row?.qualification ?? "",
    provenance: row?.provenance ?? "",
  };
}
