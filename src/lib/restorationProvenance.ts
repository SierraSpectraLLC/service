// Provenance percentage - how much of a system's history is documented.
//
// Computed, never stored: the same philosophy as money balances. A pure
// function over the record's facts returns the figure and its line items, so
// the sidebar, the queue column, and any future buyer-facing surface all
// agree by construction. The server gathers the input; nothing here reads a
// database.
//
// The model is a weighted checklist. Each line carries a weight; a line earns
// its weight fully, fractionally, or not at all. Lines that do not apply yet
// (no restore tasks, no checklists instantiated, no outside work) are left
// out of BOTH sides of the division rather than scored - a project fresh off
// the truck is judged on what a receiving can know, not on paperwork no stage
// has produced. An `unknown` interview answer earns half: an honest gap is
// documented history ("nobody knows" is an answer the next buyer can act on),
// but it is not knowledge.
import type { Tone } from "@/lib/tones";
import { PROVENANCE_QUESTIONS } from "@/lib/restoration";

export type ProvenanceInput = {
  /** Serialized components: how many the project has, how many resolved
   * against a serial (catalog or manual). */
  components: { total: number; serialed: number };
  /** questionKey -> answer; '' or absent = never asked. */
  answers: Map<string, string>;
  /** Restore-stage tasks on the project. null = stage not reached (no tasks
   * yet and none expected). */
  tasks: { total: number; done: number } | null;
  /** Bench (verify) and on-site (commission) verdicts: 'pass' | 'fail' |
   * null = none recorded. */
  verifyVerdict: string | null;
  onsiteVerdict: string | null;
  pcBackup: boolean;
  wipeCert: boolean;
  /** Tickable items across the project's checklist runs. null = none
   * instantiated yet. */
  checklists: { total: number; checked: number } | null;
  /** Outside work rows and how many carry a report. null = none logged. */
  outsideWork: { total: number; documented: number } | null;
};

export type ProvenanceLine = {
  key: string;
  label: string;
  tone: Tone;
  /** The pill text: "4/4", "Unknown", "PASS", "Missing". */
  value: string;
  earned: number;
  weight: number;
};

export type Provenance = { pct: number; lines: ProvenanceLine[] };

// The weights. Chosen once, in one place, so the number is arguable rather
// than mysterious. Interview weight is per question.
const W = {
  serials: 20,
  question: 6,
  tasks: 16,
  verify: 12,
  onsite: 8,
  pcBackup: 4,
  wipeCert: 8,
  checklists: 8,
  outsideWork: 4,
} as const;

const QUESTION_LABEL: Record<string, string> = {
  operational_at_deinstall: "Running at deinstall",
  last_pm_date: "Last PM",
  pm_docs: "Maintenance records",
  contract_history: "Contract history",
};

export function provenanceOf(input: ProvenanceInput): Provenance {
  const lines: ProvenanceLine[] = [];

  // Serials. A project with zero components earns nothing here rather than
  // being excused - a system with no received components has no documented
  // hardware at all.
  {
    const { total, serialed } = input.components;
    const fractionKnown = total > 0 ? serialed / total : 0;
    lines.push({
      key: "serials",
      label: "Serials matched",
      tone: total > 0 && serialed === total ? "good" : serialed > 0 ? "warn" : "bad",
      value: `${serialed}/${total}`,
      earned: W.serials * fractionKnown,
      weight: W.serials,
    });
  }

  // The interview: answered earns full, 'unknown' earns half, unasked earns
  // nothing.
  for (const q of PROVENANCE_QUESTIONS) {
    const a = input.answers.get(q.key) ?? "";
    const earned = a === "" ? 0 : a === "unknown" ? W.question / 2 : W.question;
    lines.push({
      key: q.key,
      label: QUESTION_LABEL[q.key] ?? q.key,
      tone: a === "" ? "bad" : a === "unknown" ? "warn" : "good",
      value: a === "" ? "Not asked" : a === "unknown" ? "Unknown" : "On record",
      earned,
      weight: W.question,
    });
  }

  // The work record since receiving - findings become tasks, tasks close.
  if (input.tasks !== null && input.tasks.total > 0) {
    const { total, done } = input.tasks;
    lines.push({
      key: "tasks",
      label: "Restore tasks",
      tone: done === total ? "good" : "warn",
      value: done === total ? "Complete" : `${total - done} open`,
      earned: W.tasks * (done / total),
      weight: W.tasks,
    });
  }

  // Verdicts. A FAIL on file is still documentation - the record knows the
  // truth - but only half of it: history the next owner must re-prove.
  const verdictLine = (key: string, label: string, weight: number, v: string | null) => {
    lines.push({
      key,
      label,
      tone: v === "pass" ? "good" : v === "fail" ? "bad" : "warn",
      value: v === "pass" ? "PASS" : v === "fail" ? "FAIL" : "None",
      earned: v === "pass" ? weight : v === "fail" ? weight / 2 : 0,
      weight,
    });
  };
  verdictLine("verify_verdict", "Checkout verdict", W.verify, input.verifyVerdict);
  verdictLine("onsite_verdict", "On-site checkout", W.onsite, input.onsiteVerdict);

  lines.push({
    key: "pc_backup",
    label: "PC backup",
    tone: input.pcBackup ? "good" : "warn",
    value: input.pcBackup ? "Imaged" : "Pending",
    earned: input.pcBackup ? W.pcBackup : 0,
    weight: W.pcBackup,
  });
  lines.push({
    key: "wipe_cert",
    label: "Wipe certificate",
    tone: input.wipeCert ? "good" : "warn",
    value: input.wipeCert ? "On file" : "Pending",
    earned: input.wipeCert ? W.wipeCert : 0,
    weight: W.wipeCert,
  });

  if (input.checklists !== null && input.checklists.total > 0) {
    const { total, checked } = input.checklists;
    lines.push({
      key: "checklists",
      label: "Checklists",
      tone: checked === total ? "good" : "warn",
      value: `${checked}/${total}`,
      earned: W.checklists * (checked / total),
      weight: W.checklists,
    });
  }

  if (input.outsideWork !== null && input.outsideWork.total > 0) {
    const { total, documented } = input.outsideWork;
    lines.push({
      key: "outside_work",
      label: "Outside work",
      tone: documented === total ? "good" : "warn",
      value: documented === total ? "Documented" : `${total - documented} undocumented`,
      earned: W.outsideWork * (documented / total),
      weight: W.outsideWork,
    });
  }

  const weight = lines.reduce((s, l) => s + l.weight, 0);
  const earned = lines.reduce((s, l) => s + l.earned, 0);
  const pct = weight === 0 ? 0 : Math.round((100 * earned) / weight);
  return { pct, lines };
}
