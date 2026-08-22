// The daily digest, rebuilt around engagements.
//
// A service company's day is not one flat fleet - it is a set of working
// relationships: Sierra Spectra × LabZen, Sierra Spectra × GMI, and the
// house's own bench. The digest mirrors that. Each engagement gets a section
// that answers, in order, the questions a morning stand-up asks:
//
//   1. What is stuck, and WHOSE move is it - theirs, ours, or a supplier's?
//   2. What should we chase today - the follow-up list?
//   3. What is handed off - with the partner, out of our hands?
//   4. What actually happened since yesterday?
//   5. Where does every system stand right now?
//
// The same section renders twice. The INTERNAL edition stitches every
// engagement together for the engineering team, cross-fleet rollup on top.
// The PARTNER edition is one engagement, worded for the other side, and goes
// only to recipients that organization has been opted into
// (orgs.digest_recipients) - never merged, so no organization ever sees
// another's systems. Same isolation rule as the EOD report, one level up.
import { and, asc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings, auditLog, eodUpdates, instrumentGases, instruments, orgs, parts, tasks, workOrders,
} from "@/db/schema";
import { BLOCKED_STAGE, GAS_TONE, STAGE_COLOR, gasAttention, partOpen } from "@/lib/stages";
import { TONE_HEX } from "@/lib/tones";
import { daysSince } from "@/lib/queue";
import { houseEmails } from "@/lib/house";
import { digestFrom, digestReplyTo, sendEmail } from "@/lib/email";
import { brandForTenant } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { shopDay, shopHour, shopToday } from "@/lib/shopday";
import { getSystemLabels } from "@/lib/systemLabel";
import { EMAIL, emailShell, esc } from "@/lib/emailTheme";
import { mailHost, threadHeaders, threadRootId } from "@/lib/emailThread";
import { digestDayEnabled, digestGapDays, weekdayOfShopDay, windowLabel } from "@/lib/digestDays";

// ---------------------------------------------------------------------------
// The classifications - pure, so they are unit-tested.
// ---------------------------------------------------------------------------

/**
 * partner  the other organization in this engagement (or a named third org)
 * us       the operator - our bench, our decision, our shipment
 * supplier a vendor the wait rides on - a part on order that is moving
 */
export type Court = "partner" | "us" | "supplier";

export type PendingItem = {
  systemId: number;
  externalId: string;
  court: Court;
  /** Who the wait is on, by name - shown when it isn't the obvious party. */
  who: string;
  what: string;
  /** Whole days waited, where the record carries a start. Null = unknown. */
  days: number | null;
};

/**
 * A system parked in another organization's queue. NOT a blocker: kicking a
 * finished repair to the partner's queue is how it leaves our board, and the
 * digest must read it that way - handed off, out of our hands - never as
 * something anyone is "waiting" on.
 */
export type HandoffItem = {
  systemId: number;
  externalId: string;
  /** The system's name - parked systems leave the board, so this names them. */
  label: string;
  holder: string;
  reason: string;
  days: number;
};

/**
 * Our own housekeeping to chase today, repeated until the record that clears
 * it exists. Internal only: a part stuck without tracking is not housekeeping
 * but a PENDING item, courted by whoever placed the order (see
 * pendingForSystem) - the digest states the fact, not who is telephoning whom.
 */
export type FollowUp = { systemId: number; externalId: string; text: string };

export type PendingCtx = {
  /** The org this section belongs to (null = the operator's own work). */
  sectionOrgId: number | null;
  orgName: (id: number | null) => string;
  operatorName: string;
  blockedTasks: { title: string }[];
  waitingWorkOrders: { number: string; title: string; orgId: number | null }[];
  openParts: {
    name: string; status: string; eta: string; tracking: string;
    requestedOrgId: number | null; requestedAt: Date | null;
    /** Set when the part sits on one of OUR purchase orders. */
    poId: number | null;
  }[];
  now: Date;
};

export const handoffFor = (
  i: {
    id: number; externalId: string;
    queueOrgId: number | null; queueReason: string; queueSince: Date | null; createdAt: Date;
  },
  label: string,
  orgName: (id: number | null) => string,
  now: Date,
): HandoffItem | null =>
  i.queueOrgId === null ? null : {
    systemId: i.id, externalId: i.externalId, label,
    holder: orgName(i.queueOrgId), reason: i.queueReason,
    days: daysSince(i.queueSince ?? i.createdAt, now),
  };

/**
 * What one system is genuinely waiting on, each item assigned to a court.
 * Only for systems in OUR queue - a handed-off system pends nothing (see
 * handoffFor).
 *
 * A blocked system leads with the reason it was blocked for, which is demanded
 * at the moment of blocking (actions.toggleStage) and aged from that moment.
 * Its blocked TASKS list beneath as their own lines. A blocked system with
 * neither goes to the follow-up list instead - it predates the requirement,
 * and the only useful thing to say about it is that nobody knows.
 *
 * Parts read literally, because the record can't know who is on the phone to
 * whom: a part moving with tracking rides with the supplier; one stuck
 * without tracking (or backordered with no date) is a plain stated fact -
 * "No tracking yet for X" - in the court of whoever is buying it. Repeating
 * the line each morning IS the follow-up.
 *
 * Who that is, in order of how much the record actually knows: a formal
 * request names who was asked and when; failing that, a part on one of our
 * purchase orders is ours, because we went and bought it; failing that, in a
 * partner engagement it belongs to the owner of the instrument - their
 * machine, their money, their vendor account - and only the house's own work
 * falls to us by default. Before this, an unrequested part read as ours on
 * every engagement, which told a client their own purchasing was our job.
 */
export function pendingForSystem(
  i: {
    id: number; externalId: string; stages: string[];
    blockedReason: string; blockedSince: Date | null;
  },
  ctx: PendingCtx,
): PendingItem[] {
  const items: PendingItem[] = [];
  const add = (court: Court, who: string, what: string, days: number | null = null) =>
    items.push({ systemId: i.id, externalId: i.externalId, court, who, what, days });

  if (i.stages.includes(BLOCKED_STAGE) && i.blockedReason.trim()) {
    add("us", ctx.operatorName, `Blocked: ${i.blockedReason.trim()}`,
      i.blockedSince ? daysSince(i.blockedSince, ctx.now) : null);
  }
  if (i.stages.includes("Waiting to ship")) {
    add("us", ctx.operatorName, "Ready and waiting to ship");
  }
  for (const t of ctx.blockedTasks) add("us", ctx.operatorName, `Blocked task: ${t.title}`);
  for (const w of ctx.waitingWorkOrders) {
    const theirs = w.orgId !== null && w.orgId === ctx.sectionOrgId;
    add(theirs ? "partner" : "us", theirs ? ctx.orgName(w.orgId) : ctx.operatorName,
      `Work order${w.number ? ` ${w.number}` : ""} waiting: ${w.title}`);
  }
  for (const p of ctx.openParts) {
    const buyer = p.requestedOrgId ?? (p.poId === null ? ctx.sectionOrgId : null);
    const theirs = buyer !== null;
    const court: Court = theirs ? "partner" : "us";
    const who = theirs ? ctx.orgName(buyer) : ctx.operatorName;
    // Only a formal request carries a date, so only it can be aged.
    const asked = p.requestedAt ? daysSince(p.requestedAt, ctx.now) : null;
    if (p.status === "Needed") {
      add(court, who, theirs ? `Part to order: ${p.name}` : `Part needed: ${p.name}`, asked);
    } else if ((p.status === "Ordered" || p.status === "In transit") && p.tracking) {
      add("supplier", "supplier",
        `Part ${p.status === "Ordered" ? "on order" : "in transit"}: ${p.name}${p.eta ? ` - ETA ${p.eta}` : ""}`);
    } else if (p.status === "Ordered" || p.status === "In transit") {
      add(court, who, `No tracking yet for ${p.name}`, asked);
    } else if (p.status === "Backordered") {
      add(court, who, `Backordered: ${p.name} - no firm ETA yet`, asked);
    }
  }
  return items;
}

/**
 * The chase list: what somebody should go ask about today, repeated every
 * morning until the record that answers it exists. A handed-off system chases
 * nothing - it is out of our hands.
 */
export function followUpsForSystem(
  i: {
    id: number; externalId: string; stages: string[];
    queueOrgId: number | null; lead: string; blockedReason: string;
  },
  blockedTaskCount: number,
): FollowUp[] {
  if (i.queueOrgId !== null) return [];
  const out: FollowUp[] = [];

  // A blocked system must say why. Blocking has demanded a reason since
  // actions.toggleStage started asking, so what lands here is the backlog: a
  // system blocked before that, with no reason and no blocked task to stand in
  // for one. Our own housekeeping, never the partner's.
  if (i.stages.includes(BLOCKED_STAGE) && !i.blockedReason.trim() && blockedTaskCount === 0) {
    out.push({
      systemId: i.id, externalId: i.externalId,
      text: `Blocked with no recorded reason - ask ${i.lead || "the team"} what's blocking and what clears it`,
    });
  }
  return out;
}

/** The three courts in reading order, each keeping its items' order. */
export function courts(items: PendingItem[]): Record<Court, PendingItem[]> {
  return {
    partner: items.filter((x) => x.court === "partner"),
    us: items.filter((x) => x.court === "us"),
    supplier: items.filter((x) => x.court === "supplier"),
  };
}

// ---------------------------------------------------------------------------
// Collection - one pass over the workspace, grouped into engagement sections.
// ---------------------------------------------------------------------------

type GasIssue = { externalId: string; gas: string; status: string; note: string };
type WorkBlock = { externalId: string; label: string; lines: string[] };
type BoardRow = {
  externalId: string; label: string; stages: string[];
  gases: { gas: string; status: string }[];
  openParts: number; lead: string;
  /** Internal edition only. */
  notes: string;
};

export type DigestSection = {
  orgId: number | null;
  /** The partner org's name; the operator's own name for the null section. */
  name: string;
  board: BoardRow[];
  pending: PendingItem[];
  followUps: FollowUp[];
  handoffs: HandoffItem[];
  gas: GasIssue[];
  work: WorkBlock[];
  /** "9 changes logged since yesterday by joe, chris" - internal only. */
  activity: string;
};

export async function collectDigest(tenantOrgId: number | null, sinceDays = 1): Promise<{
  sections: DigestSection[];
  operatorName: string;
  /** What the work section calls its window: "Since yesterday", "Over the weekend". */
  window: string;
}> {
  const brand = await brandForTenant(tenantOrgId);
  const now = new Date();
  // The window is "since the last edition", not "the last 24 hours" - that
  // one change is what makes skipped days work: a digest resting over the
  // weekend covers Friday-to-Monday when it comes back, so weekend work
  // arrives Monday under its own day instead of never.
  const span = Math.min(7, Math.max(1, Math.round(sinceDays)));
  const cutoff = new Date(now.getTime() - span * 24 * 3600 * 1000);
  const sinceDate = shopDay(cutoff);
  const todayStr = shopDay(now);
  const multiDay = span > 1;
  // Lines in a multi-day window say which day they happened - "Sat · " - so
  // Monday's reader can tell Saturday's fix from this morning's.
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const tagOf = (d: Date) => (multiDay ? `${DAYS[weekdayOfShopDay(shopDay(d))]} · ` : "");
  const tagOfDay = (iso: string) => (multiDay ? `${DAYS[weekdayOfShopDay(iso)]} · ` : "");

  const mine = tenantOrgId === null ? undefined : eq(instruments.tenantOrgId, tenantOrgId);
  const rows = await db.select().from(instruments)
    .where(and(eq(instruments.archived, false), mine))
    .orderBy(asc(instruments.priority), asc(instruments.externalId));
  const ids = rows.map((r) => r.id);

  const none = <T,>() => Promise.resolve([] as T[]);
  const [labels, gasRows, partRows, taskRows, woRows, updateRows, auditRows, orgRows] = await Promise.all([
    getSystemLabels(rows),
    ids.length ? db.select().from(instrumentGases).where(inArray(instrumentGases.instrumentId, ids)) : none<typeof instrumentGases.$inferSelect>(),
    ids.length ? db.select().from(parts).where(inArray(parts.instrumentId, ids)) : none<typeof parts.$inferSelect>(),
    ids.length ? db.select().from(tasks).where(and(
      inArray(tasks.instrumentId, ids),
      or(eq(tasks.state, "Blocked"), gte(tasks.completedAt, cutoff)),
    )) : none<typeof tasks.$inferSelect>(),
    ids.length ? db.select().from(workOrders).where(and(
      inArray(workOrders.instrumentId, ids),
      or(eq(workOrders.state, "waiting"), gte(workOrders.resolvedAt, cutoff), gte(workOrders.closedAt, cutoff)),
    )) : none<typeof workOrders.$inferSelect>(),
    ids.length ? db.select().from(eodUpdates).where(and(
      gte(eodUpdates.date, sinceDate), lt(eodUpdates.date, todayStr),
      inArray(eodUpdates.instrumentId, ids),
    )) : none<typeof eodUpdates.$inferSelect>(),
    db.select().from(auditLog).where(gte(auditLog.createdAt, cutoff)),
    db.select().from(orgs),
  ]);

  const orgName = (id: number | null) =>
    id === null ? brand.operatorName : (orgRows.find((o) => o.id === id)?.name ?? "another organization");

  // One section per owning organization, house-stewarded work first.
  const owners: (number | null)[] = [];
  for (const r of rows) {
    const key = r.ownerOrgId ?? null;
    if (!owners.includes(key)) owners.push(key);
  }
  owners.sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return orgName(a).localeCompare(orgName(b));
  });

  const sections: DigestSection[] = [];
  for (const ownerId of owners) {
    const systems = rows.filter((r) => (r.ownerOrgId ?? null) === ownerId);
    const section: DigestSection = {
      orgId: ownerId, name: orgName(ownerId),
      board: [], pending: [], followUps: [], handoffs: [], gas: [], work: [], activity: "",
    };
    const sysIds = new Set(systems.map((s) => s.id));

    for (const i of systems) {
      const shipped = i.stages.includes("Shipped");
      const label = labels.get(i.id) ?? i.model;
      const g = gasRows.filter((x) => x.instrumentId === i.id);
      const openParts = partRows.filter((p) => p.instrumentId === i.id && partOpen(p.status));

      if (!shipped) {
        // A system in another org's queue is handed off - it lists once under
        // "With <them>" and raises nothing: no pendings, no follow-ups, no
        // gas attention, and no board row. It is not on our repair board.
        const handoff = handoffFor(i, label, orgName, now);
        if (handoff) {
          section.handoffs.push(handoff);
        } else {
          section.board.push({
            externalId: i.externalId, label, stages: i.stages,
            gases: g.map((x) => ({ gas: x.gas, status: x.status })),
            openParts: openParts.length, lead: i.lead,
            notes: i.notes,
          });
          const blockedTasks = taskRows.filter((t) => t.instrumentId === i.id && t.state === "Blocked");
          section.pending.push(...pendingForSystem(i, {
            sectionOrgId: ownerId, orgName, operatorName: brand.operatorName, now,
            blockedTasks: blockedTasks.map((t) => ({ title: t.title })),
            waitingWorkOrders: woRows.filter((w) => w.instrumentId === i.id && w.state === "waiting")
              .map((w) => ({ number: w.number, title: w.title, orgId: w.orgId })),
            openParts: openParts.map((p) => ({
              name: p.name, status: p.status, eta: p.eta, tracking: p.tracking,
              requestedOrgId: p.requestedOrgId, requestedAt: p.requestedAt, poId: p.poId,
            })),
          }));
          section.followUps.push(...followUpsForSystem(i, blockedTasks.length));
          for (const x of g.filter((x) => gasAttention(x.status))) {
            section.gas.push({ externalId: i.externalId, gas: x.gas, status: x.status, note: x.note });
          }
        }
      }

      // What happened in the window - the hand-written updates first (they
      // are the narrative, in day order), then the record: tasks done, work
      // orders resolved. In a multi-day window every line carries its day.
      const lines: string[] = [];
      const ups = updateRows.filter((x) => x.instrumentId === i.id && !x.skipped)
        .sort((a, b) => a.date.localeCompare(b.date));
      for (const u of ups) {
        if (u.systemUpdate?.trim()) lines.push(`${tagOfDay(u.date)}${u.systemUpdate.trim()}`);
        if (u.actionItem?.trim()) lines.push(`${tagOfDay(u.date)}Next: ${u.actionItem.trim()}`);
      }
      for (const t of taskRows.filter((t) => t.instrumentId === i.id && t.state === "Done" && t.completedAt && t.completedAt >= cutoff)) {
        lines.push(`${tagOf(t.completedAt!)}Completed: ${t.title}`);
      }
      for (const w of woRows.filter((w) => w.instrumentId === i.id
        && ((w.resolvedAt && w.resolvedAt >= cutoff) || (w.closedAt && w.closedAt >= cutoff)))) {
        const closed = w.closedAt && w.closedAt >= cutoff;
        lines.push(`${tagOf((closed ? w.closedAt : w.resolvedAt)!)}Work order${w.number ? ` ${w.number}` : ""} ${closed ? "closed" : "resolved"}: ${w.closeSummary || w.title}`);
      }
      if (lines.length) section.work.push({ externalId: i.externalId, label, lines });
    }

    // The rest of the day's record, summarized rather than dumped: the audit
    // log backs it in full, and eight raw "updated notes" lines are noise.
    const touched = auditRows.filter((a) => a.instrumentId !== null && sysIds.has(a.instrumentId));
    if (touched.length) {
      const actors = [...new Set(touched.map((a) => a.actor.split("@")[0]))];
      section.activity = `${touched.length} change${touched.length === 1 ? "" : "s"} logged in the window by ${actors.join(", ")}`;
    }

    if (section.board.length || section.work.length || section.handoffs.length) sections.push(section);
  }

  return {
    sections, operatorName: brand.operatorName,
    window: windowLabel(span, weekdayOfShopDay(sinceDate)),
  };
}

// ---------------------------------------------------------------------------
// Rendering - email dialect: tables, inline styles, nothing external.
// ---------------------------------------------------------------------------

const pill = (text: string, bg: string, fg: string) =>
  `<span style="display:inline-block;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-family:${EMAIL.font};">${esc(text)}</span>`;

const stagePill = (s: string) => {
  const c = STAGE_COLOR[s] || { bg: "#EEF1F5", fg: "#475569" };
  return pill(s, c.bg, c.fg);
};

const card = (inner: string, border = EMAIL.border, bg = "#FFFFFF") =>
  `<div style="border:1px solid ${border};background:${bg};border-radius:10px;padding:12px 14px;margin:10px 0;font-family:${EMAIL.font};font-size:13px;color:${EMAIL.ink};">${inner}</div>`;

const groupHead = (label: string, n: number, color: string) =>
  `<div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:${color};margin:8px 0 4px;">${esc(label)} (${n})</div>`;

const sysId = (id: string) =>
  `<span style="font-family:${EMAIL.mono};font-size:12px;font-weight:bold;color:${EMAIL.ink};">${esc(id)}</span>`;

function renderPending(section: DigestSection, internal: boolean, operatorName: string): string {
  const c = courts(section.pending);
  if (!section.pending.length) return "";
  const line = (x: PendingItem, expectedWho: string) => {
    const aside = x.who !== expectedWho && x.court !== "supplier" ? ` <span style="color:${EMAIL.muted};">(with ${esc(x.who)})</span>` : "";
    const age = x.days !== null ? ` <span style="color:${EMAIL.faint};">· ${x.days}d</span>` : "";
    return `<div style="margin:2px 0;">${sysId(x.externalId)} &nbsp;${esc(x.what)}${aside}${age}</div>`;
  };
  const groups: string[] = [];
  if (c.partner.length) {
    // The house section has no partner; anything in this court there is a
    // named third organization's. The partner edition names the organization
    // rather than saying "you" - a daily email that opens with an accusation
    // gets read as one.
    const head = !internal ? `Waiting for ${section.name} intervention`
      : section.orgId === null ? "Waiting on others" : `Waiting on ${section.name}`;
    const expected = section.orgId === null ? "" : section.name;
    groups.push(groupHead(head, c.partner.length, "#8A5410")
      + c.partner.map((x) => line(x, expected)).join(""));
  }
  if (c.us.length) {
    // Partner voice drops the first person: the email is FROM the operator
    // but READ by the partner, and "us" makes them stop to work out who.
    groups.push(groupHead(internal ? "Waiting on us" : `With ${operatorName}`, c.us.length, "#A32D2D")
      + c.us.map((x) => line(x, operatorName)).join(""));
  }
  if (c.supplier.length) {
    groups.push(groupHead("With suppliers", c.supplier.length, "#475569")
      + c.supplier.map((x) => line(x, "supplier")).join(""));
  }
  return card(`<div style="font-weight:bold;margin-bottom:2px;">Blocked &amp; pending</div>${groups.join("")}`);
}

/** The chase list. Internal only - it is our own housekeeping, nobody else's. */
function renderFollowUps(section: DigestSection): string {
  if (!section.followUps.length) return "";
  const lines = section.followUps.map((f) =>
    `<div style="margin:2px 0;">${sysId(f.externalId)} &nbsp;${esc(f.text)}</div>`).join("");
  return card(`<b style="color:#8A5410;">Follow up today (${section.followUps.length})</b>
    <div style="font-size:12px;color:${EMAIL.muted};margin:2px 0 4px;">Repeats every morning until the record that clears it exists.</div>${lines}`,
    "#EAD9B8", "#FDF8EE");
}

/** Handed-off systems: with the partner, out of our hands. Neutral on purpose. */
function renderHandoffs(section: DigestSection, internal: boolean, operatorName: string): string {
  if (!section.handoffs.length) return "";
  // Sections can mix holders (a third org holding one system); name each line's
  // holder only when it differs from the section's partner.
  const expected = section.orgId === null ? "" : section.name;
  const lines = section.handoffs.map((h) => {
    const aside = h.holder !== expected ? ` <span style="color:${EMAIL.muted};">(with ${esc(h.holder)})</span>` : "";
    return `<div style="margin:3px 0;">${sysId(h.externalId)} <span style="color:${EMAIL.muted};font-size:12px;">${esc(h.label)}</span>${h.reason ? ` &nbsp;·&nbsp; ${esc(h.reason)}` : ""}${aside} <span style="color:${EMAIL.faint};">· ${h.days}d</span></div>`;
  }).join("");
  const title = section.orgId === null ? "Handed off" : `With ${section.name}`;
  const sub = internal
    ? "In their queue - off our repair board, nothing needed from us."
    : `Handed off by ${operatorName} - nothing pending from our side on these.`;
  return card(`<div style="font-weight:bold;">${esc(title)} (${section.handoffs.length})</div>
    <div style="font-size:12px;color:${EMAIL.muted};margin:2px 0 4px;">${esc(sub)}</div>${lines}`);
}

function renderGas(section: DigestSection): string {
  if (!section.gas.length) return "";
  const lines = section.gas.map((g) =>
    `<div style="margin:2px 0;">${sysId(g.externalId)} &nbsp;${esc(g.gas)}: ${esc(g.status)}${g.note ? ` <span style="color:${EMAIL.muted};">(${esc(g.note)})</span>` : ""}</div>`).join("");
  return card(`<b style="color:#A32D2D;">Gas attention (${section.gas.length})</b>${lines}`, "#E8B4B4", "#FBE9E9");
}

function renderWork(section: DigestSection, internal: boolean, window: string): string {
  if (!section.work.length && !(internal && section.activity)) return "";
  const blocks = section.work.map((w) => `
    <div style="margin:6px 0;">
      <div>${sysId(w.externalId)} <span style="color:${EMAIL.muted};font-size:12px;">${esc(w.label)}</span></div>
      ${w.lines.map((l) => `<div style="margin:1px 0 1px 10px;white-space:pre-wrap;">${esc(l)}</div>`).join("")}
    </div>`).join("");
  const activity = internal && section.activity
    ? `<div style="color:${EMAIL.faint};font-size:12px;margin-top:6px;">${esc(section.activity)}</div>` : "";
  const empty = !section.work.length
    ? `<div style="color:${EMAIL.muted};">Nothing written or completed in this window.</div>` : "";
  return card(`<div style="font-weight:bold;margin-bottom:2px;">${esc(window)}</div>${blocks}${empty}${activity}`);
}

function renderBoard(section: DigestSection, internal: boolean): string {
  if (!section.board.length) return "";
  const th = (h: string) =>
    `<th align="left" style="padding:6px 8px;font-family:${EMAIL.font};font-size:11px;color:${EMAIL.muted};text-transform:uppercase;letter-spacing:0.5px;">${h}</th>`;
  const rows = section.board.map((r) => {
    const gasCells = r.gases.length
      ? r.gases.map((x) => {
          const c = TONE_HEX[GAS_TONE[x.status] ?? "neutral"];
          return pill(`${x.gas}: ${x.status}`, c.bg, c.fg);
        }).join(" ")
      : `<span style="color:${EMAIL.faint};">-</span>`;
    return `
      <tr>
        <td style="padding:7px 8px;border-top:1px solid ${EMAIL.border};font-family:${EMAIL.font};font-size:13px;vertical-align:top;">
          ${sysId(r.externalId)}<br/>
          <span style="font-size:11px;color:${EMAIL.muted};">${esc(r.label)}</span>
          ${internal && r.notes ? `<br/><span style="font-size:11px;color:${EMAIL.faint};">${esc(r.notes)}</span>` : ""}
        </td>
        <td style="padding:7px 8px;border-top:1px solid ${EMAIL.border};vertical-align:top;line-height:1.9;">${r.stages.map(stagePill).join(" ")}</td>
        <td style="padding:7px 8px;border-top:1px solid ${EMAIL.border};vertical-align:top;line-height:1.9;">${gasCells}</td>
        <td style="padding:7px 8px;border-top:1px solid ${EMAIL.border};font-family:${EMAIL.font};font-size:12px;vertical-align:top;white-space:nowrap;">${r.openParts ? `${r.openParts} open` : `<span style="color:${EMAIL.faint};">-</span>`}</td>
        <td style="padding:7px 8px;border-top:1px solid ${EMAIL.border};font-family:${EMAIL.font};font-size:12px;vertical-align:top;white-space:nowrap;">${esc(r.lead) || `<span style="color:${EMAIL.faint};">-</span>`}</td>
      </tr>`;
  }).join("");
  return `
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:10px 0 2px;">
      <tr>${["System", "Stages", "Gases", "Parts", "Lead"].map(th).join("")}</tr>
      ${rows}
    </table>`;
}

function renderSection(section: DigestSection, internal: boolean, operatorName: string, window: string): string {
  const title = section.orgId === null
    ? `${esc(operatorName)} — own &amp; unassigned`
    : `${esc(operatorName)} × ${esc(section.name)}`;
  const c = courts(section.pending);
  const counts = [
    `${section.board.length} in work`,
    c.partner.length ? `${c.partner.length} on them` : "",
    c.us.length ? `${c.us.length} on us` : "",
    section.followUps.length ? `${section.followUps.length} to chase` : "",
    section.handoffs.length ? `${section.handoffs.length} handed off` : "",
    section.gas.length ? `${section.gas.length} gas` : "",
  ].filter(Boolean).join(" · ");
  const header = internal
    ? `<div style="margin:22px 0 2px;padding-top:14px;border-top:2px solid ${EMAIL.ink};font-family:${EMAIL.font};">
         <span style="font-size:15px;font-weight:bold;color:${EMAIL.ink};">${title}</span>
         <span style="font-size:12px;color:${EMAIL.muted};">&nbsp; ${esc(counts)}</span>
       </div>`
    : "";
  const quiet = !section.pending.length && !section.gas.length && !section.followUps.length
    ? `<div style="font-family:${EMAIL.font};font-size:13px;color:#0F6E56;margin:8px 0;">Nothing blocked - every system is moving.</div>`
    : "";
  return header
    + renderGas(section)
    + (internal ? renderFollowUps(section) : "")
    + renderPending(section, internal, operatorName)
    + quiet
    + renderHandoffs(section, internal, operatorName)
    + renderWork(section, internal, window)
    + renderBoard(section, internal);
}

const todayLabel = () => new Date().toLocaleDateString("en-US", {
  timeZone: process.env.SHOP_TZ || "America/Los_Angeles",
  weekday: "short", month: "short", day: "numeric",
});

/** Cross-section totals, for the subject line and the summary strip. */
export function digestCounts(sections: DigestSection[]) {
  const all = sections.flatMap((s) => s.pending);
  const c = courts(all);
  return {
    systems: sections.reduce((n, s) => n + s.board.length, 0),
    partner: c.partner.length, us: c.us.length, supplier: c.supplier.length,
    followUps: sections.reduce((n, s) => n + s.followUps.length, 0),
    handoffs: sections.reduce((n, s) => n + s.handoffs.length, 0),
    gas: sections.reduce((n, s) => n + s.gas.length, 0),
  };
}

function summaryStrip(n: ReturnType<typeof digestCounts>): string {
  const cell = (value: string, label: string, color = EMAIL.ink) => `
    <td align="center" style="padding:8px 4px;border:1px solid ${EMAIL.border};border-radius:8px;background:${EMAIL.panel};">
      <div style="font-family:${EMAIL.font};font-size:20px;font-weight:bold;color:${color};">${value}</div>
      <div style="font-family:${EMAIL.font};font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:${EMAIL.muted};">${label}</div>
    </td>`;
  return `
    <table width="100%" border="0" cellspacing="6" cellpadding="0" style="margin-bottom:4px;">
      <tr>
        ${cell(String(n.systems), "in work")}
        ${cell(String(n.us), "on us", n.us ? "#A32D2D" : EMAIL.faint)}
        ${cell(String(n.partner), "on partners", n.partner ? "#8A5410" : EMAIL.faint)}
        ${cell(String(n.followUps), "to chase", n.followUps ? "#8A5410" : EMAIL.faint)}
        ${cell(String(n.handoffs), "handed off", EMAIL.muted)}
        ${cell(String(n.gas), "gas issues", n.gas ? "#A32D2D" : EMAIL.faint)}
      </tr>
    </table>`;
}

// ---------------------------------------------------------------------------
// The two editions.
// ---------------------------------------------------------------------------

/**
 * One edition's body from collected sections. Pure - the composers wrap it in
 * the shell, and a preview can render it from fixture data with no database.
 */
export function renderDigestBody(sections: DigestSection[], internal: boolean, operatorName: string, window = "Since yesterday"): string {
  if (!sections.length) {
    return `<div style="font-family:${EMAIL.font};font-size:13px;color:${EMAIL.muted};">Nothing in work - no active systems on the board.</div>`;
  }
  const strip = internal ? summaryStrip(digestCounts(sections)) : "";
  return strip + sections.map((s) => renderSection(s, internal, operatorName, window)).join("");
}

/** The internal edition: every engagement, for the engineering team. */
/** When this edition last went, so its window starts where the last one ended. */
async function lastSentFor(tenantOrgId: number | null, orgId: number | null): Promise<string> {
  const target = orgId ?? tenantOrgId;
  if (target !== null) {
    const [o] = await db.select({ on: orgs.digestLastSentOn }).from(orgs).where(eq(orgs.id, target));
    return o?.on ?? "";
  }
  const [a] = await db.select({ on: appSettings.digestLastSentOn }).from(appSettings).where(eq(appSettings.id, 1));
  return a?.on ?? "";
}

export async function composeDigest(tenantOrgId: number | null = null): Promise<{ subject: string; html: string }> {
  const brand = await brandForTenant(tenantOrgId);
  const gap = digestGapDays(await lastSentFor(tenantOrgId, null), shopToday());
  const { sections, operatorName, window } = await collectDigest(tenantOrgId, gap);
  const n = digestCounts(sections);
  const today = todayLabel();
  const url = appUrl();

  const body = renderDigestBody(sections, true, operatorName, window);

  const busy = n.partner + n.us + n.followUps + n.gas;
  // Constant on purpose: a subject carrying the date or the day's counts
  // started a new Gmail conversation every morning. The counts are in the
  // preheader, which is the line an inbox shows beside the subject anyway.
  // See lib/emailThread.
  const subject = `${operatorName} daily digest`;
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `Daily digest · ${today}`,
    preheader: busy
      ? `${today} - ${n.us} on us, ${n.partner} on partners, ${n.followUps} to chase, ${n.gas} gas issue${n.gas === 1 ? "" : "s"} across ${n.systems} systems.`
      : `${today} - all ${n.systems} systems moving, nothing blocked, nothing to chase.`,
    width: 680,
    body,
    footer: `Sent each morning by ${esc(brand.name)}.${url ? ` Statuses live on each system's page: <a href="${esc(url)}" style="color:${EMAIL.faint};">${esc(url.replace(/^https?:\/\//, ""))}</a>` : ""}`,
  });
  return { subject, html };
}

/**
 * The partner edition: one engagement, worded for the other side. Null when
 * that organization has nothing on the board and nothing happened - a daily
 * "nothing to report" email teaches people to stop reading.
 */
export async function composePartnerDigest(
  tenantOrgId: number | null, orgId: number,
): Promise<{ subject: string; html: string } | null> {
  const brand = await brandForTenant(tenantOrgId);
  const gap = digestGapDays(await lastSentFor(tenantOrgId, orgId), shopToday());
  const { sections, operatorName, window } = await collectDigest(tenantOrgId, gap);
  const section = sections.find((s) => s.orgId === orgId);
  if (!section) return null;
  const n = digestCounts([section]);
  const today = todayLabel();
  const url = appUrl();

  // Constant, for the same reason as the internal edition's.
  const subject = `${operatorName} × ${section.name}: daily digest`;
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `${operatorName} × ${section.name} · Daily digest · ${today}`,
    preheader: n.partner
      ? `${today} - ${n.partner} item${n.partner === 1 ? "" : "s"} awaiting ${section.name} intervention · ${n.systems} systems in work.`
      : n.handoffs
        ? `${today} - ${n.handoffs} system${n.handoffs === 1 ? "" : "s"} in your hands, nothing needs your intervention.`
        : `${today} - ${n.systems} system${n.systems === 1 ? "" : "s"} in work, nothing needs your intervention.`,
    width: 680,
    body: renderDigestBody([section], false, operatorName, window),
    footer: url
      ? `Sent each morning by ${esc(operatorName)}. Questions on a system? Open it in the portal and reply there: <a href="${esc(url)}" style="color:${EMAIL.faint};">${esc(url.replace(/^https?:\/\//, ""))}</a>`
      : `Sent each morning by ${esc(operatorName)}.`,
  });
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Scheduling and delivery.
// ---------------------------------------------------------------------------

/** What decides whether an edition goes out this hour. */
export type DigestSchedule = { digestHour: number; digestLastSentOn: string; digestDays: string };

/**
 * Is this edition due? The cron runs every hour, so this one comparison is the
 * whole schedule.
 *
 * `>=` rather than `===` on purpose: an hour that was missed - a cron blip, a
 * cold start, an hour the module spent switched off - still sends later the
 * same day instead of vanishing until tomorrow. What stops it repeating is the
 * stamp, which is also what makes a hand-pressed "send now" and the schedule
 * agree about whether today's digest has gone.
 */
export function digestDue(s: DigestSchedule, hourNow: number, today: string): boolean {
  if (s.digestLastSentOn === today) return false;
  // A day the digest rests is simply not sent - its work is not lost, because
  // the next edition's window reaches back to the last one (digestGapDays).
  if (!digestDayEnabled(s.digestDays, weekdayOfShopDay(today))) return false;
  return hourNow >= s.digestHour;
}

/** A stored recipient list as addresses. The store is text; this is the list. */
export const digestRecipientList = (stored: string): string[] =>
  stored.split(",").map((x) => x.trim()).filter(Boolean);

export type EditionResult = { sent: boolean; to: string[]; reason?: string };

/** Remember that today's edition has gone out, so nothing sends it twice. */
async function stampSent(tenantOrgId: number | null, orgId: number | null, today: string): Promise<void> {
  const target = orgId ?? tenantOrgId;
  if (target !== null) {
    await db.update(orgs).set({ digestLastSentOn: today }).where(eq(orgs.id, target));
  } else {
    // No operator org on this instance - the singleton carries the schedule.
    await db.update(appSettings).set({ digestLastSentOn: today }).where(eq(appSettings.id, 1));
  }
}

/**
 * Compose and send ONE edition right now, whatever the schedule says, and
 * stamp the day. `orgId` null is the internal edition for the workspace;
 * anything else is that organization's partner edition.
 *
 * The single path both the cron and the "send now" button take, so a
 * hand-sent digest is the same email to the same people, and counts as
 * today's rather than arriving twice.
 */
export async function sendDigestEdition(
  tenantOrgId: number | null, orgId: number | null,
): Promise<EditionResult> {
  const today = shopToday();
  // One running conversation per engagement rather than a fresh email every
  // morning - see lib/emailThread. The key names the engagement, so a client's
  // chain and our own never merge.
  // Anchored to the address the digest itself sends from, so the chain and
  // the sender stay coherent. Changing that address starts one fresh chain -
  // a one-time cost, and the honest one: it is a new sender.
  const from = digestFrom();
  const replyTo = digestReplyTo();
  const host = mailHost(from);
  const send = (to: string[], subject: string, html: string, key: string) =>
    sendEmail(to, subject, html, { from, replyTo, headers: threadHeaders(threadRootId(key, host)) });
  if (orgId === null) {
    const to = await houseEmails(tenantOrgId);
    if (!to.length) return { sent: false, to: [], reason: "nobody to send to" };
    const { subject, html } = await composeDigest(tenantOrgId);
    await send(to, subject, html, `internal-${tenantOrgId ?? 0}`);
    await stampSent(tenantOrgId, null, today);
    return { sent: true, to };
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { sent: false, to: [], reason: "no such organization" };
  const to = digestRecipientList(org.digestRecipients);
  if (!to.length) return { sent: false, to: [], reason: "no recipients configured" };
  const edition = await composePartnerDigest(tenantOrgId, orgId);
  if (!edition) return { sent: false, to, reason: "nothing on the board" };
  await send(to, edition.subject, edition.html, `org-${orgId}`);
  await stampSent(tenantOrgId, orgId, today);
  return { sent: true, to };
}

/**
 * The hourly pass: send every edition that is due and has not gone today.
 *
 * Nothing due is the ordinary outcome - twenty-three hours out of twenty-four
 * this does nothing at all - so a quiet run is a success, not an error. What
 * could not be sent is REPORTED rather than stamped, which means a workspace
 * with no staff addresses says so every hour instead of failing silently, and
 * a partner whose board was empty at seven gets their digest at ten when the
 * day finally has something in it.
 */
export async function runDailyDigest(now = new Date()): Promise<{
  sent: number; partnersSent: number; skipped: string[];
}> {
  const today = shopDay(now);
  const hourNow = shopHour(now);
  const [allOrgs, [settings]] = await Promise.all([
    db.select().from(orgs),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
  ]);
  const operators = allOrgs.filter((o) => o.isOperator);
  const workspaces: (number | null)[] = operators.length ? operators.map((o) => o.id) : [null];
  let sent = 0;
  let partnersSent = 0;
  const skipped: string[] = [];

  for (const tenantOrgId of workspaces) {
    const operator = operators.find((o) => o.id === tenantOrgId);
    const who = operator?.name ?? "this instance";
    // The internal edition keeps its schedule on the operator's own org row -
    // the workspace IS an organization - falling back to the singleton on an
    // instance that has never named one.
    const house: DigestSchedule = operator ?? {
      digestHour: settings?.digestHour ?? 7,
      digestLastSentOn: settings?.digestLastSentOn ?? "",
      digestDays: settings?.digestDays ?? "",
    };
    if (digestDue(house, hourNow, today)) {
      const res = await sendDigestEdition(tenantOrgId, null);
      if (res.sent) sent++;
      else skipped.push(`${who}: ${res.reason}`);
    }

    // Partner editions, opt-in per organization and each on its own hour.
    // Scoped to this workspace's own organizations - the isolation that keeps
    // one client's systems out of another's inbox is structural, not a filter.
    const partners = allOrgs.filter((o) =>
      o.digestRecipients.trim()
      && o.id !== tenantOrgId
      && (tenantOrgId === null || o.parentOrgId === tenantOrgId));
    for (const p of partners) {
      if (!digestDue(p, hourNow, today)) continue;
      const res = await sendDigestEdition(tenantOrgId, p.id);
      if (res.sent) partnersSent++;
      else skipped.push(`${p.name}: ${res.reason}`);
    }
  }

  return { sent, partnersSent, skipped };
}
