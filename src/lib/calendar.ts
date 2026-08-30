import { anticipated, type RecurringTerms } from "@/lib/recurring";
import { noteDays, noteLabel } from "@/lib/calendarNotes";

/**
 * The company calendar, derived - never stored.
 *
 * Everything on it is a date the app already keeps for its own reasons: a
 * booked maintenance visit, a cycle falling due, a task's date, a quote's
 * last good day, an invoice's due day, a contract's end, a retainer cycle
 * about to raise itself. The calendar is one more READER of those facts, so
 * it can never disagree with the pages that own them - and there is no event
 * table to drift out of sync.
 *
 * ONE exception, and it is deliberate: a "note" is a dated fact with no other
 * row to live on - a lab shut for an audit week, a delivery expected Tuesday.
 * It is stored, because there is nothing to derive it from. See
 * db/schema.calendarNotes.
 */

export type CalKind =
  | "visit" | "pm" | "task" | "quote" | "invoice" | "renewal" | "retainer" | "note";

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
  note: "Notes",
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
  /** Written by hand rather than derived - see the header. */
  notes?: {
    id: number; onDate: string; endsOn: string; title: string;
    /** Whose note, for the shop's own calendar - "" for its own. */
    orgName: string;
  }[];
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

  /*
   * ONE LINE PER MACHINE PER DAY, not one per job.
   *
   * Maintenance clusters: a system's schedules were usually written on the
   * same day at the same cadence, so they come due together, and a fleet of
   * them comes due together too. Emitted one event per schedule, a single
   * Tuesday read "Quarterly source clean @ TOC-001", "Source housekeeping @
   * TOC-001", "Annual PM @ TOC-001" and eleven more - which is not a calendar
   * anybody can look at, and the title of one of fourteen jobs is not even the
   * useful fact. The useful fact is WHICH MACHINE needs somebody.
   *
   * So schedules are gathered per machine per day and collapsed. One job keeps
   * its own title, because there the title IS the fact and nothing is gained by
   * hiding it; several become "TOC-001 maintenance due", with the count, and
   * the link goes where the list of them already lives.
   */
  const cluster = new Map<string, {
    date: string; kind: CalKind; href: string; label: string; system: string; n: number;
  }>();
  for (const s of inp.schedules) {
    if (s.paused) continue;
    const href = s.instrumentId !== null ? `/instruments/${s.instrumentId}`
      : s.assetId !== null ? `/assets/${s.assetId}` : "/maintenance";
    // Booked and due are different days and different facts, so they cluster
    // apart: a machine can have one of each in the same week.
    const [date, kind] = s.bookedOn
      ? [s.bookedOn, "visit" as const]
      : [s.nextDue, "pm" as const];
    if (!inRange(date)) continue;
    /* Keyed on the RECORD, not on the label. Two machines can carry the same
       tag in different workspaces, and a schedule with no machine behind it at
       all must not be pooled with every other orphan on that day. */
    const who = s.instrumentId !== null ? `i${s.instrumentId}`
      : s.assetId !== null ? `a${s.assetId}` : `s${s.id}`;
    const key = `${date}|${kind}|${who}`;
    const seen = cluster.get(key);
    if (seen) { seen.n++; continue; }
    cluster.set(key, {
      date, kind, href, n: 1,
      label: s.title, system: s.systemLabel,
    });
  }
  for (const c of cluster.values()) {
    const where = c.system ? ` @ ${c.system}` : "";
    out.push({
      date: c.date, kind: c.kind, href: c.href,
      label: c.n === 1
        ? `${c.label}${where}`
        : `${c.system || "Unassigned"} ${c.kind === "visit" ? "booked in" : "maintenance due"}`
          + ` · ${c.n} jobs`,
      tone: lateTone(c.date, c.kind === "visit" ? "info" : "warn"),
    });
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

  /*
   * The written notes, one event per day covered. Not late-toned however old
   * they are: a note is a statement about a day rather than something owed, so
   * "the site was shut last Tuesday" is not overdue - it just happened.
   */
  for (const nt of inp.notes ?? []) {
    for (const day of noteDays(nt, from, to)) {
      out.push({
        date: day, kind: "note", href: `/calendar?m=${day.slice(0, 7)}`,
        label: `${noteLabel(nt, day)}${nt.orgName ? ` - ${nt.orgName}` : ""}`,
        tone: "neutral",
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
