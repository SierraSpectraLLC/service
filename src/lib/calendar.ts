import { anticipated, type RecurringTerms } from "@/lib/recurring";

/**
 * The company calendar, derived - never stored.
 *
 * Everything on it is a date the app already keeps for its own reasons: a
 * booked maintenance visit, a cycle falling due, a task's date, a quote's
 * last good day, an invoice's due day, a contract's end, a retainer cycle
 * about to raise itself. The calendar is one more READER of those facts, so
 * it can never disagree with the pages that own them - and there is no event
 * table to drift out of sync.
 */

export type CalKind = "visit" | "pm" | "task" | "quote" | "invoice" | "renewal" | "retainer";

export type CalEvent = {
  date: string;             // YYYY-MM-DD
  kind: CalKind;
  label: string;
  href: string;
  /** Matches the pill vocabulary: bad = late already, warn = needs an eye. */
  tone: "info" | "warn" | "bad" | "neutral" | "good" | "accent";
};

export const KIND_LABEL: Record<CalKind, string> = {
  visit: "Booked visits",
  pm: "Maintenance due",
  task: "Tasks",
  quote: "Quotes expiring",
  invoice: "Invoices due",
  renewal: "Contracts ending",
  retainer: "Retainer cycles",
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) => ISO.test(s);

/** "2026-08" -> the six-ish rows of its grid, Sunday first, ISO day per cell. */
export function monthGrid(ym: string): { weeks: string[][]; days: string[] } {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const weeks: string[][] = [];
  const days: string[] = [];
  const cur = new Date(start);
  do {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      const iso = cur.toISOString().slice(0, 10);
      week.push(iso); days.push(iso);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    weeks.push(week);
  } while (cur.getUTCMonth() === m - 1);
  return { weeks, days };
}

export const monthOf = (iso: string) => iso.slice(0, 7);

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthTitle(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${MONTHS[m - 1] ?? ym} ${y}`;
}

export type CalendarInputs = {
  schedules: {
    id: number; title: string; paused: boolean; nextDue: string;
    bookedOn: string; instrumentId: number | null; assetId: number | null;
    systemLabel: string;
  }[];
  /** Open, dated, non-PM tasks - a PM task's schedule already speaks for it. */
  tasks: { id: number; title: string; dueDate: string; instrumentId: number | null; assignee: string }[];
  quotes: { id: number; number: string; title: string; status: string; expiresOn: string }[];
  invoices: { id: number; number: string; status: string; dueOn: string; orgName: string }[];
  agreements: ({ id: number; number: string; title: string; orgId: number; orgName: string } & RecurringTerms)[];
};

/**
 * Every event in [from, to], oldest first. `today` decides the tones: a date
 * behind us is late, not history - completed things simply are not here,
 * because their date columns clear or their rows close when the work happens.
 */
export function assembleEvents(inp: CalendarInputs, from: string, to: string, today: string): CalEvent[] {
  const out: CalEvent[] = [];
  const inRange = (d: string) => isDay(d) && d >= from && d <= to;
  const lateTone = (d: string, calm: CalEvent["tone"]): CalEvent["tone"] => (d < today ? "bad" : calm);

  for (const s of inp.schedules) {
    if (s.paused) continue;
    const where = s.systemLabel ? ` @ ${s.systemLabel}` : "";
    const href = s.instrumentId !== null ? `/instruments/${s.instrumentId}`
      : s.assetId !== null ? `/assets/${s.assetId}` : "/maintenance";
    if (s.bookedOn) {
      if (inRange(s.bookedOn)) out.push({
        date: s.bookedOn, kind: "visit", href,
        label: `${s.title}${where}`, tone: lateTone(s.bookedOn, "info"),
      });
    } else if (inRange(s.nextDue)) {
      out.push({
        date: s.nextDue, kind: "pm", href,
        label: `${s.title}${where}`, tone: lateTone(s.nextDue, "warn"),
      });
    }
  }

  for (const t of inp.tasks) {
    if (!inRange(t.dueDate)) continue;
    out.push({
      date: t.dueDate, kind: "task",
      href: t.instrumentId !== null ? `/instruments/${t.instrumentId}` : "/work",
      label: `${t.title}${t.assignee ? ` - ${t.assignee}` : ""}`,
      tone: lateTone(t.dueDate, "neutral"),
    });
  }

  for (const q of inp.quotes) {
    if (q.status !== "sent" || !inRange(q.expiresOn)) continue;
    out.push({
      date: q.expiresOn, kind: "quote", href: `/money/quotes/${q.id}`,
      label: `${q.number} last good day`, tone: "warn",
    });
  }

  for (const i of inp.invoices) {
    if (!["sent", "partial"].includes(i.status) || !inRange(i.dueOn)) continue;
    out.push({
      date: i.dueOn, kind: "invoice", href: `/money/invoices/${i.id}`,
      label: `${i.number} due${i.orgName ? ` - ${i.orgName}` : ""}`,
      tone: lateTone(i.dueOn, "neutral"),
    });
  }

  for (const a of inp.agreements) {
    const label = a.number || a.title || `agreement ${a.id}`;
    if (a.status === "active" && inRange(a.endsOn)) {
      out.push({
        date: a.endsOn, kind: "renewal", href: "/money/contracts",
        label: `${label} ends${a.orgName ? ` - ${a.orgName}` : ""}`, tone: "warn",
      });
    }
    // The retainer's forecast, straight from the one schedule that raises it.
    for (const c of anticipated(a, from, to)) {
      out.push({
        date: c.on, kind: "retainer", href: "/money/contracts",
        label: `${label} cycle${a.orgName ? ` - ${a.orgName}` : ""}`, tone: "accent",
      });
    }
  }

  return out.sort((x, y) => x.date.localeCompare(y.date) || x.kind.localeCompare(y.kind));
}

/** Escape ICS text per RFC 5545. */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/**
 * The same events as an iCalendar feed, for the phone calendars the crew
 * already lives in. All-day events on purpose: the app knows days, and a
 * fake 9am would read as a promise nobody made.
 */
export function eventsToIcs(events: CalEvent[], calName: string, baseUrl: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ridgeline//calendar//EN",
    `X-WR-CALNAME:${icsText(calName)}`,
  ];
  for (const e of events) {
    const day = e.date.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      // Stable UID so a re-fetch updates instead of duplicating.
      `UID:${e.kind}-${e.date}-${icsText(e.label).slice(0, 40).replace(/[^\w-]/g, "_")}@ridgeline`,
      `DTSTART;VALUE=DATE:${day}`,
      `SUMMARY:${icsText(`${KIND_LABEL[e.kind].replace(/s$/, "")}: ${e.label}`)}`,
      `URL:${baseUrl}${e.href}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
