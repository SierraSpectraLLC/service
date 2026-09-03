// The notification vocabulary and the one preference rule. Pure - the
// tables live in db/schema, the writes in lib/notify and app/actions.

/**
 * localStorage key for the OS-alerts opt-in. Shared, because two components
 * touch it from opposite ends of the app: the inbox page sets it, and the
 * header's poller reads it when something new arrives.
 */
export const DESKTOP_KEY = "notify:desktop";

/**
 * WHO CAN EVER RECEIVE ONE.
 *
 * "house" means the audience is always houseEmails() - the operator's own
 * staff - so the notification cannot reach a client no matter what they set.
 * "all" means a client genuinely can be on the recipient list.
 *
 * This is an audience fact, not a permission: preferences here only MUTE the
 * email on a notification somebody was already going to get. Nothing a client
 * switched on ever subscribed them to anything. But the list was shown whole
 * to everybody, and that had two costs. Seven of seventeen rows could never
 * fire for a client, which buries the ones that can. And two of the seven -
 * "Somebody signs in to the portal for the first time" and "The weekly report
 * of who is using the portal" - told every client of every tenant that their
 * portal use is watched and reported on. That is the operator's business to
 * disclose in their own words, not a checkbox's to leak on their behalf.
 */
export type NotifyAudience = "house" | "all";

/**
 * A kind whose email waits for the burst to finish, and the plural it uses
 * when several arrive together.
 *
 * Only bursty kinds get one. Assigning is bursty - a person sits down and
 * writes out an install list - while a gas going empty or a contract coming up
 * for renewal happens once and should interrupt at once. Holding a solitary
 * event buys nothing and costs it thirty seconds of lateness.
 */
export type NotifyHold = { seconds: number; plural: string };

export const NOTIFY_KINDS = [
  {
    kind: "task_assigned", label: "A task is assigned to me", audience: "all",
    hold: { seconds: 30, plural: "tasks" },
  },
  { kind: "system_assigned", label: "I'm made lead on a system", audience: "all" },
  { kind: "discussion", label: "Discussion posts and @mentions", audience: "all" },
  { kind: "mention", label: "I'm @mentioned in a task note", audience: "all" },
  // The OWNING org's editors rule on access to their own equipment, so this
  // reaches them as well as staff - see actions.ownerAudience.
  { kind: "access_request", label: "Access requests and ownership claims", audience: "all" },
  // A claim's notice: the holder, its steward and every author in the open
  // tenure are told a window is running on their free text. All, for the same
  // reason as access_request - the people who can object are not staff.
  { kind: "claim_notice", label: "A claim is running on a system I hold or wrote on", audience: "all" },
  // An outside shop asked to confirm work attributed to it.
  { kind: "countersign", label: "Asked to confirm work attributed to my organization", audience: "all" },
  // The lab is asked to acknowledge a PM just recorded on its instrument. Never
  // gates the record; a signature nobody chased is the only kind worth having.
  { kind: "pm_ack", label: "Asked to acknowledge maintenance on my instrument", audience: "all" },
  { kind: "gas_empty", label: "A gas is marked empty", audience: "house" },
  { kind: "queue", label: "A system moves into my queue", audience: "all" },
  { kind: "handoff", label: "A system changes hands", audience: "all" },
  // Both of these are a client's own message ARRIVING at the shop. Showing a
  // client the switch implies they might be told about their own report.
  { kind: "issue", label: "A client reports a problem", audience: "house" },
  { kind: "pm_request", label: "A client asks for maintenance", audience: "house" },
  { kind: "renewal", label: "A contract is coming up for renewal", audience: "house" },
  // Somebody on our own staff hit a snag in the software. House-only: a client
  // has no business being told the shop's engineers are filing bug reports,
  // and the switch alone would say so.
  { kind: "bug_report", label: "Somebody reports a problem with the software", audience: "house" },
  // Asked OF the owner, so the owner hears it too.
  { kind: "parts_request", label: "We're asked to order parts for our systems", audience: "all" },
  { kind: "message", label: "Somebody messages me directly", audience: "all" },
  { kind: "drop", label: "Files arrive through a drop link I made", audience: "all" },
  { kind: "model_proposal", label: "A model not in the catalog gets recorded", audience: "house" },
  { kind: "sign_in", label: "Somebody signs in to the portal for the first time", audience: "house" },
  { kind: "usage_report", label: "The weekly report of who is using the portal", audience: "house" },
  // Another service company hands us a client. House only: it is a decision
  // about taking on work, and it arrives from outside the workspace entirely.
  { kind: "client_share", label: "Another service company shares a client with us", audience: "house" },
  // Work somebody is offering us, and the answer to one we offered. House
  // only: it is a decision about taking on work, from outside the workspace.
  { kind: "lead", label: "A lead is offered to us, or one of ours is taken", audience: "house" },
] as const satisfies readonly {
  kind: string; label: string; audience: NotifyAudience; hold?: NotifyHold;
}[];

export type NotifyKind = (typeof NOTIFY_KINDS)[number]["kind"];

/**
 * The kinds worth offering this person a switch for.
 *
 * A switch that can never do anything is not a neutral extra row: it is a
 * claim about what happens on this instance, read by somebody who is not
 * supposed to be reading it.
 */
export const notifyKindsFor = (isStaff: boolean): readonly (typeof NOTIFY_KINDS)[number][] =>
  isStaff ? NOTIFY_KINDS : NOTIFY_KINDS.filter((k) => k.audience === "all");

/** Can this kind ever reach this person at all? */
export const mayReceiveKind = (kind: string, isStaff: boolean): boolean =>
  notifyKindsFor(isStaff).some((k) => k.kind === kind);

export const isNotifyKind = (k: string): k is NotifyKind =>
  NOTIFY_KINDS.some((n) => n.kind === k);

/**
 * How long this kind's email waits for the rest of its burst, or null to send
 * at once - which is every kind but one, and the honest default.
 */
export const holdFor = (kind: string): NotifyHold | null => {
  const k = NOTIFY_KINDS.find((n) => n.kind === kind);
  return k && "hold" in k ? k.hold : null;
};

/**
 * May this kind email this person? No stored row means yes - prefs only
 * record opt-outs, so new users and new kinds both default to email on.
 * The in-app inbox row is written regardless; this gates the email alone.
 */
export function emailAllowed(
  prefs: { kind: string; emailOn: boolean }[],
  kind: NotifyKind,
): boolean {
  const row = prefs.find((p) => p.kind === kind);
  return row ? row.emailOn : true;
}
