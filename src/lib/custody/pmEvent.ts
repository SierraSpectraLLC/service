// One PM, however it was recorded, becomes one event - built HERE and nowhere
// else.
//
// The screen and the sheet are two surfaces for the same procedure set, and
// the promise is that both write the same line: a lamp change ticked on a
// phone and a lamp change ticked on paper must produce byte-identical
// provenance for the same inputs, or the chain says the surface mattered when
// only the work did. tests/pmSurfaces asserts that equality, and the way it
// stays true is that neither surface builds the event - both hand their input
// to this and file what comes back.
//
// Which surface it was is a fact worth keeping and it goes in PRIVATE, where
// it cannot make two identical jobs hash differently downstream.

import type { HowGrade, ProcedureKeyEntry } from "@/lib/custody/types";

export type PmStepInput = {
  key: string;
  state: "done" | "skip" | "na";
  reading?: string;
  unit?: string;
  condition?: string;
  /** Required for skip. Travels: "still due" means nothing without a why. */
  reason?: string;
  partNumber?: string;
  /** Stays: a lot number is a supply-chain fact about the shop, not the machine. */
  lot?: string;
};

export type PmRunInput = {
  steps: PmStepInput[];
  /** Written for whoever holds the machine next. */
  findings: string;
  /** Stays with the shop. */
  privateNotes: string;
  setVersion: number;
  /** Where it was recorded. Private. */
  surface: "screen" | "sheet";
  /** The technician, as typed. Private - the author org is on the event row. */
  technician: string;
  /** Parts fitted, by catalog number. Numbers travel, everything else stays. */
  parts?: { partNumber: string; name?: string; lot?: string; cost?: string }[];
};

export type BuiltPmEvent = {
  kind: "pm";
  howGrade: HowGrade;
  procedureKeys: ProcedureKeyEntry[];
  provenance: Record<string, unknown>;
  private: Record<string, unknown>;
};

const clean = (s: string | undefined): string | undefined => {
  const t = (s ?? "").trim();
  return t ? t : undefined;
};

/**
 * Deterministic on purpose: steps are sorted by key, optional fields are
 * omitted rather than set to "", and nothing about the caller leaks into the
 * travelling half. Two calls with the same steps in a different order build
 * the same event.
 */
export function buildPmEvent(input: PmRunInput): BuiltPmEvent {
  const steps = [...input.steps]
    .filter((s) => s.key.trim())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((s): ProcedureKeyEntry => ({
      key: s.key.trim(),
      state: s.state,
      ...(clean(s.reading) ? { reading: clean(s.reading) } : {}),
      ...(clean(s.unit) ? { unit: clean(s.unit) } : {}),
      ...(clean(s.condition) ? { condition: clean(s.condition) } : {}),
      ...(s.state === "skip" && clean(s.reason) ? { reason: clean(s.reason) } : {}),
      ...(clean(s.partNumber) ? { partNumber: clean(s.partNumber) } : {}),
    }));

  const lots: Record<string, string> = {};
  for (const s of input.steps) if (clean(s.lot)) lots[s.key.trim()] = clean(s.lot)!;

  const parts = (input.parts ?? []).filter((p) => clean(p.partNumber));
  const findings = clean(input.findings);

  return {
    kind: "pm",
    // The steps were worked, one by one, with their states recorded. That is
    // what procedure_run means; a checkbox is not evidence, a worked set is.
    howGrade: "procedure_run",
    procedureKeys: steps,
    provenance: {
      planned: true,
      setVersion: input.setVersion,
      ...(findings ? { findings } : {}),
      ...(parts.length ? { parts: parts.map((p) => ({ partNumber: p.partNumber.trim(), ...(clean(p.name) ? { name: clean(p.name) } : {}) })) } : {}),
    },
    private: {
      surface: input.surface,
      technician: input.technician.trim(),
      ...(clean(input.privateNotes) ? { notes: clean(input.privateNotes) } : {}),
      ...(Object.keys(lots).length ? { lots } : {}),
      ...(parts.some((p) => clean(p.lot) || clean(p.cost))
        ? { parts: parts.map((p) => ({ partNumber: p.partNumber.trim(), ...(clean(p.lot) ? { lot: clean(p.lot) } : {}), ...(clean(p.cost) ? { cost: clean(p.cost) } : {}) })) }
        : {}),
    },
  };
}

/** What a run is missing before it may be filed. Empty = ready. */
export function runProblems(input: PmRunInput): string[] {
  const out: string[] = [];
  if (!input.steps.length) out.push("No steps on this run.");
  for (const s of input.steps) {
    if (s.state === "skip" && !clean(s.reason)) out.push(`Say why ${s.key} was skipped - the reason travels.`);
  }
  if (!clean(input.technician)) out.push("Type the technician's name.");
  return out;
}
