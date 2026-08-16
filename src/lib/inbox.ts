// The notification vocabulary and the one preference rule. Pure - the
// tables live in db/schema, the writes in lib/notify and app/actions.

/**
 * localStorage key for the OS-alerts opt-in. Shared, because two components
 * touch it from opposite ends of the app: the inbox page sets it, and the
 * header's poller reads it when something new arrives.
 */
export const DESKTOP_KEY = "notify:desktop";

export const NOTIFY_KINDS = [
  { kind: "task_assigned", label: "A task is assigned to me" },
  { kind: "system_assigned", label: "I'm made lead on a system" },
  { kind: "discussion", label: "Discussion posts and @mentions" },
  { kind: "mention", label: "I'm @mentioned in a task note" },
  { kind: "access_request", label: "Access requests and ownership claims" },
  { kind: "gas_empty", label: "A gas is marked empty" },
  { kind: "queue", label: "A system moves into my queue" },
  { kind: "handoff", label: "A system changes hands" },
  { kind: "issue", label: "A client reports a problem" },
  { kind: "pm_request", label: "A client asks for maintenance" },
  { kind: "renewal", label: "A contract is coming up for renewal" },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]["kind"];

export const isNotifyKind = (k: string): k is NotifyKind =>
  NOTIFY_KINDS.some((n) => n.kind === k);

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
