// The asset dossier's service history: lifecycle events merged with every
// task, part, and time entry tagged to the asset, newest first. Pure so the
// fiddly ordering/labeling is unit-testable; the page supplies plain rows.

export type HistoryLine = {
  at: Date;
  instrumentId: number | null; // where it happened (null = unattached lifecycle event)
  kind: "event" | "task" | "part" | "time";
  text: string;
  detail?: string;
};

type EventRow = { kind: string; instrumentId: number | null; detail: string; actor: string; at: Date };
type TaskRow = { title: string; state: string; instrumentId: number | null; createdAt: Date; completedAt: Date | null };
type PartRow = { name: string; status: string; instrumentId: number | null; createdAt: Date };
type TimeRow = { person: string; minutes: number; note: string; instrumentId: number | null; createdAt: Date };

const EVENT_TEXT: Record<string, string> = {
  installed: "Installed",
  removed: "Removed",
  moved: "Moved",
  status: "Status",
  note: "Note",
};

export function mergeAssetHistory(
  events: EventRow[], tasks: TaskRow[], parts: PartRow[], time: TimeRow[],
  formatHours: (minutes: number) => string,
): HistoryLine[] {
  const lines: HistoryLine[] = [
    ...events.map((e) => ({
      at: e.at, instrumentId: e.instrumentId, kind: "event" as const,
      text: `${EVENT_TEXT[e.kind] ?? e.kind}${e.detail ? `: ${e.detail}` : ""}`,
      detail: e.actor,
    })),
    ...tasks.map((t) => ({
      // A done task reads at its completion time; open work reads at creation.
      at: t.completedAt ?? t.createdAt, instrumentId: t.instrumentId, kind: "task" as const,
      text: `${t.state === "Done" ? "✓ " : ""}${t.title}`,
      detail: t.state === "Done" ? undefined : t.state,
    })),
    ...parts.map((p) => ({
      at: p.createdAt, instrumentId: p.instrumentId, kind: "part" as const,
      text: p.name, detail: p.status,
    })),
    ...time.map((t) => ({
      at: t.createdAt, instrumentId: t.instrumentId, kind: "time" as const,
      text: `${formatHours(t.minutes)} — ${t.person}`, detail: t.note || undefined,
    })),
  ];
  return lines.sort((a, b) => b.at.getTime() - a.at.getTime());
}
