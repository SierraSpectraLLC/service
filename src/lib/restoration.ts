// The restoration pipeline's vocabulary and its stage gates.
//
// The five stages are the pipeline's CONTRACT, fixed in code - deliberately
// not the per-tenant stage_defs kanban labels, which are display vocabulary a
// tenant may rename and recolor. A gate is evaluated here as a pure function
// over a snapshot the server gathers; the client's rendering of it is a
// courtesy, never the authority (the signoffGate rule, applied to stages).
import type { Tone } from "@/lib/tones";

export const RESTORATION_STAGES = [
  "receive", "restore", "verify", "ship", "commission", "complete",
] as const;
export type RestorationStage = (typeof RESTORATION_STAGES)[number];

/** The pill on the queue and the pagehead - present tense, like the mock. */
export const RESTORATION_STAGE_LABEL: Record<RestorationStage, string> = {
  receive: "Receiving",
  restore: "Restoring",
  verify: "Verifying",
  ship: "Shipping",
  commission: "Commissioning",
  complete: "Complete",
};

/** In-flight reads `info`, done reads `good`; the queue may override to
 * `warn` when a gate has blocked a project for too long. */
export const RESTORATION_STAGE_TONE: Record<RestorationStage, Tone> = {
  receive: "info", restore: "info", verify: "info", ship: "info",
  commission: "info", complete: "good",
};

export const stageIndex = (s: string): number =>
  RESTORATION_STAGES.indexOf(s as RestorationStage);

/** The stage after this one, or null past the end. */
export function nextStage(s: string): RestorationStage | null {
  const i = stageIndex(s);
  if (i < 0 || i >= RESTORATION_STAGES.length - 1) return null;
  return RESTORATION_STAGES[i + 1];
}

/** A project parked in one stage this long is a project somebody stopped
 * pushing - the queue turns its pill amber to say so. */
export const STALE_DAYS = 14;

export const daysInStage = (stageSince: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - stageSince.getTime()) / 86_400_000));

/** The queue pill's tone: in motion, done, or sitting too long. */
export function queueStageTone(stage: string, stageSince: Date, now: Date): Tone {
  if (stage === "complete") return "good";
  if (daysInStage(stageSince, now) > STALE_DAYS) return "warn";
  return RESTORATION_STAGE_TONE[stage as RestorationStage] ?? "info";
}

export const RESTORATION_SOURCES = ["acquired", "trade_in", "client_transfer"] as const;
export type RestorationSource = (typeof RESTORATION_SOURCES)[number];
export const RESTORATION_SOURCE_LABEL: Record<RestorationSource, string> = {
  acquired: "Acquired",
  trade_in: "Trade-in",
  client_transfer: "Client transfer",
};

// '' = not yet graded. F is "parts machine", not an insult.
export const CONDITION_GRADES = ["A", "B", "C", "D", "F"] as const;

export const FINDING_SEVERITIES = ["bad", "warn"] as const;

// Handoff kit license status. '' = not recorded, which the Receive gate's
// "vaulted or marked none" confirm is about.
export const LICENSE_STATES = ["", "active", "required", "none"] as const;
export const LICENSE_LABEL: Record<string, string> = {
  "": "Not recorded",
  active: "Active license on system",
  required: "License required — none on system",
  none: "No license needed",
};

/**
 * The provenance interview, code-defined for v1. `unknown` is a first-class
 * answer everywhere - distinct from '' (nobody asked), which is what the
 * interview-complete gate refuses. Honest gaps beat invented answers.
 */
export const PROVENANCE_QUESTIONS = [
  {
    key: "operational_at_deinstall",
    question: "Was the system running when it came off the bench?",
    answers: ["running", "down", "unknown"],
  },
  {
    key: "last_pm_date",
    question: "When was it last maintained?",
    // 'date' carries the date itself in the answer row's detail field.
    answers: ["date", "unknown"],
  },
  {
    key: "pm_docs",
    question: "Is there maintenance paper?",
    answers: ["docs", "none", "unknown"],
  },
  {
    key: "contract_history",
    question: "Any service contract in its past?",
    answers: ["yes", "no", "unknown"],
  },
] as const;
export type ProvenanceQuestionKey = (typeof PROVENANCE_QUESTIONS)[number]["key"];

/** True when every question has SOME answer - 'unknown' counts, blank doesn't. */
export function interviewComplete(answers: Map<string, string>): boolean {
  return PROVENANCE_QUESTIONS.every((q) => (answers.get(q.key) ?? "") !== "");
}

// Checklist template stages (checklist_templates.stage).
export const CHECKLIST_STAGES = ["verify_setup", "ship_prep", "commission_onsite"] as const;

/** Arrival photos the Receive gate wants on file before advancing. */
export const ARRIVAL_PHOTO_MIN = 4;

// ── Stage gates ─────────────────────────────────────────────────────────────

export type GateItem = {
  key: string;
  label: string;
  /** 'system' is computed server-side and never user-checkable; 'confirm' is
   * a human checkbox persisted with who/when (restoration_confirms). */
  kind: "system" | "confirm";
  ok: boolean;
};

export const gateReady = (items: GateItem[]): boolean => items.every((i) => i.ok);

/** The confirm-checkbox keys each stage's gate accepts - the validation set
 * for restoration_confirms writes. Keep in step with stageGate below. */
export const STAGE_CONFIRM_KEYS: Record<string, readonly string[]> = {
  receive: ["handoff_vaulted"],
  restore: ["task_photos"],
  verify: ["app_package"],
  ship: ["crated_photos"],
  commission: [],
  complete: [],
};

/**
 * Everything a gate can ask about, gathered by the server at the moment of
 * advancing. Kept flat and dumb so the gathering query stays obvious and the
 * gate itself stays pure.
 */
export type GateSnapshot = {
  components: { total: number; serialed: number; graded: number };
  arrivalPhotos: number;
  interviewComplete: boolean;
  /** Restore-stage tasks (tasks.restorationProjectId) not yet Done. */
  openTasks: number;
  /** Every parts line carries a part number. */
  partsLogged: boolean;
  /** Every outside_work row has a report attached. Vacuously true. */
  outsideDocumented: boolean;
  verifyVerdictPass: boolean;
  /** Unticked items on the verify_setup checklist run(s). */
  benchOpenItems: number;
  wipeDone: boolean;
  /** Unticked items on the ship_prep checklist run(s). */
  prepOpenItems: number;
  /** Serialized components mapped into exactly one crate. */
  crateMap: { total: number; mapped: number };
  trackingOnFile: boolean;
  buyerSet: boolean;
  onsitePass: boolean;
  acceptanceSigned: boolean;
};

const frac = (n: number, of: number) => `${n} of ${of}`;

/**
 * The gate for one stage: what must be true before the project may advance
 * out of it. Confirm items pass when their key is in `confirmed` (a
 * restoration_confirms row exists). `complete` has no gate - there is no
 * stage after it.
 */
export function stageGate(
  stage: string, snap: GateSnapshot, confirmed: Set<string>,
): GateItem[] {
  const confirm = (key: string, label: string): GateItem =>
    ({ key, label, kind: "confirm", ok: confirmed.has(key) });
  const system = (key: string, label: string, ok: boolean): GateItem =>
    ({ key, label, kind: "system", ok });

  switch (stage) {
    case "receive":
      return [
        system("serialized", `${frac(snap.components.serialed, snap.components.total)} components serialized`,
          snap.components.total > 0 && snap.components.serialed === snap.components.total),
        system("graded", "Condition graded on every component",
          snap.components.total > 0 && snap.components.graded === snap.components.total),
        system("arrival_photos", `Arrival photos — ${snap.arrivalPhotos} of ${ARRIVAL_PHOTO_MIN} minimum attached`,
          snap.arrivalPhotos >= ARRIVAL_PHOTO_MIN),
        system("interview", "Provenance interview complete (gaps allowed, skips aren't)",
          snap.interviewComplete),
        confirm("handoff_vaulted", "Handoff kit vaulted or marked none"),
      ];
    case "restore":
      return [
        system("tasks_done", snap.openTasks === 0
          ? "All restore tasks closed"
          : `${snap.openTasks} restore task${snap.openTasks === 1 ? "" : "s"} still open`,
          snap.openTasks === 0),
        system("parts_logged", "All parts logged with PN", snap.partsLogged),
        system("outside_documented", "Outside work documented", snap.outsideDocumented),
        confirm("task_photos", "Before/after photos attached per task"),
      ];
    case "verify":
      return [
        system("verdict", "Checkout verdict: PASS on file", snap.verifyVerdictPass),
        system("bench_setup", snap.benchOpenItems === 0
          ? "Bench setup complete"
          : `${snap.benchOpenItems} bench setup item${snap.benchOpenItems === 1 ? "" : "s"} open`,
          snap.benchOpenItems === 0),
        system("data_wipe", "Prior-owner data wipe complete", snap.wipeDone),
        confirm("app_package", "Application data package reviewed & attached"),
      ];
    case "ship":
      return [
        system("prep_checklist", snap.prepOpenItems === 0
          ? "Prep checklist complete"
          : `${snap.prepOpenItems} prep item${snap.prepOpenItems === 1 ? "" : "s"} open`,
          snap.prepOpenItems === 0),
        system("crate_map", `All serials assigned to a crate (${frac(snap.crateMap.mapped, snap.crateMap.total)})`,
          snap.crateMap.total > 0 && snap.crateMap.mapped === snap.crateMap.total),
        system("carrier", "Declared value & tracking on file", snap.trackingOnFile),
        system("buyer", "Buyer set on the project", snap.buyerSet),
        confirm("crated_photos", "Crated photos attached (before lid-on)"),
      ];
    case "commission":
      return [
        system("onsite_verdict", "On-site checkout verdict on file", snap.onsitePass),
        system("acceptance", "Buyer acceptance signed in their portal", snap.acceptanceSigned),
      ];
    default:
      return [];
  }
}
