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
import { and, asc, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog, eodUpdates, instrumentGases, instruments, orgs, parts, tasks, workOrders,
} from "@/db/schema";
import { GAS_COLOR, STAGE_COLOR, gasAttention, partOpen } from "@/lib/stages";
import { daysSince } from "@/lib/queue";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { brandForTenant } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { shopDay } from "@/lib/shopday";
import { getSystemLabels } from "@/lib/systemLabel";
import { EMAIL, emailShell, esc } from "@/lib/emailTheme";

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
 * handoffFor). One deliberate absence: a "Waiting / blocked" stage adds no
 * line of its own - its blocked TASKS are the reasons, and a reasonless one
 * goes on the follow-up list instead.
 *
 * Parts read literally, because the record can't know who is on the phone to
 * whom: a part moving with tracking rides with the supplier; one stuck
 * without tracking (or backordered with no date) is a plain stated fact -
 * "No tracking yet for X" - in the court of whoever placed the order. A part
 * requested of the partner was ordered by them, so the tracking is theirs to
 * provide; everything else is ours. Repeating the line each morning IS the
 * follow-up.
 */
export function pendingForSystem(
  i: { id: number; externalId: string; stages: string[] },
  ctx: PendingCtx,
): PendingItem[] {
  const items: PendingItem[] = [];
  const add = (court: Court, who: string, what: string, days: number | null = null) =>
    items.push({ systemId: i.id, externalId: i.externalId, court, who, what, days });

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
    const theirOrder = p.requestedOrgId !== null;
    const court: Court = theirOrder ? "partner" : "us";
    const who = theirOrder ? ctx.orgName(p.requestedOrgId) : ctx.operatorName;
    const asked = theirOrder && p.requestedAt ? daysSince(p.requestedAt, ctx.now) : null;
    if (p.status === "Needed" && theirOrder) {
      add("partner", who, `Part to order: ${p.name}`, asked);
    } else if (p.status === "Needed") {
      add("us", who, `Part needed: ${p.name}`);
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
  i: { id: number; externalId: string; stages: string[]; queueOrgId: number | null; lead: string },
  blockedTaskCount: number,
): FollowUp[] {
  if (i.queueOrgId !== null) return [];
  const out: FollowUp[] = [];

  // A blocked system must say why. The reasons live on its blocked tasks (or
  // its queue, handled above); blocked with neither is a question, not a
  // state - and it is our own housekeeping, never the partner's.
  if (i.stages.includes("Waiting / blocked") && blockedTaskCount === 0) {
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

export async function collectDigest(tenantOrgId: number | null): Promise<{
  sections: DigestSection[];
  operatorName: string;
}> {
  const brand = await brandForTenant(tenantOrgId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
  const yesterday = shopDay(cutoff);

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
      eq(eodUpdates.date, yesterday), inArray(eodUpdates.instrumentId, ids),
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
              requestedOrgId: p.requestedOrgId, requestedAt: p.requestedAt,
            })),
          }));
          section.followUps.push(...followUpsForSystem(i, blockedTasks.length));
          for (const x of g.filter((x) => gasAttention(x.status))) {
            section.gas.push({ externalId: i.externalId, gas: x.gas, status: x.status, note: x.note });
          }
        }
      }

      // What happened since yesterday - the hand-written update first (it is
      // the narrative), then the record: tasks done, work orders resolved.
      const lines: string[] = [];
      const u = updateRows.find((x) => x.instrumentId === i.id && !x.skipped);
      if (u?.systemUpdate?.trim()) lines.push(u.systemUpdate.trim());
      if (u?.actionItem?.trim()) lines.push(`Next: ${u.actionItem.trim()}`);
      for (const t of taskRows.filter((t) => t.instrumentId === i.id && t.state === "Done" && t.completedAt && t.completedAt >= cutoff)) {
        lines.push(`Completed: ${t.title}`);
      }
      for (const w of woRows.filter((w) => w.instrumentId === i.id
        && ((w.resolvedAt && w.resolvedAt >= cutoff) || (w.closedAt && w.closedAt >= cutoff)))) {
        lines.push(`Work order${w.number ? ` ${w.number}` : ""} ${w.closedAt && w.closedAt >= cutoff ? "closed" : "resolved"}: ${w.closeSummary || w.title}`);
      }
      if (lines.length) section.work.push({ externalId: i.externalId, label, lines });
    }

    // The rest of the day's record, summarized rather than dumped: the audit
    // log backs it in full, and eight raw "updated notes" lines are noise.
    const touched = auditRows.filter((a) => a.instrumentId !== null && sysIds.has(a.instrumentId));
    if (touched.length) {
      const actors = [...new Set(touched.map((a) => a.actor.split("@")[0]))];
      section.activity = `${touched.length} change${touched.length === 1 ? "" : "s"} logged since yesterday by ${actors.join(", ")}`;
    }

    if (section.board.length || section.work.length || section.handoffs.length) sections.push(section);
  }

  return { sections, operatorName: brand.operatorName };
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

function renderWork(section: DigestSection, internal: boolean): string {
  if (!section.work.length && !(internal && section.activity)) return "";
  const blocks = section.work.map((w) => `
    <div style="margin:6px 0;">
      <div>${sysId(w.externalId)} <span style="color:${EMAIL.muted};font-size:12px;">${esc(w.label)}</span></div>
      ${w.lines.map((l) => `<div style="margin:1px 0 1px 10px;white-space:pre-wrap;">${esc(l)}</div>`).join("")}
    </div>`).join("");
  const activity = internal && section.activity
    ? `<div style="color:${EMAIL.faint};font-size:12px;margin-top:6px;">${esc(section.activity)}</div>` : "";
  const empty = !section.work.length
    ? `<div style="color:${EMAIL.muted};">Nothing written or completed since yesterday.</div>` : "";
  return card(`<div style="font-weight:bold;margin-bottom:2px;">Since yesterday</div>${blocks}${empty}${activity}`);
}

function renderBoard(section: DigestSection, internal: boolean): string {
  if (!section.board.length) return "";
  const th = (h: string) =>
    `<th align="left" style="padding:6px 8px;font-family:${EMAIL.font};font-size:11px;color:${EMAIL.muted};text-transform:uppercase;letter-spacing:0.5px;">${h}</th>`;
  const rows = section.board.map((r) => {
    const gasCells = r.gases.length
      ? r.gases.map((x) => {
          const c = GAS_COLOR[x.status] || { bg: "#EEF1F5", fg: "#475569" };
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

function renderSection(section: DigestSection, internal: boolean, operatorName: string): string {
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
    + renderWork(section, internal)
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
export function renderDigestBody(sections: DigestSection[], internal: boolean, operatorName: string): string {
  if (!sections.length) {
    return `<div style="font-family:${EMAIL.font};font-size:13px;color:${EMAIL.muted};">Nothing in work - no active systems on the board.</div>`;
  }
  const strip = internal ? summaryStrip(digestCounts(sections)) : "";
  return strip + sections.map((s) => renderSection(s, internal, operatorName)).join("");
}

/** The internal edition: every engagement, for the engineering team. */
export async function composeDigest(tenantOrgId: number | null = null): Promise<{ subject: string; html: string }> {
  const brand = await brandForTenant(tenantOrgId);
  const { sections, operatorName } = await collectDigest(tenantOrgId);
  const n = digestCounts(sections);
  const today = todayLabel();
  const url = appUrl();

  const body = renderDigestBody(sections, true, operatorName);

  const busy = n.partner + n.us + n.followUps + n.gas;
  const subject = busy
    ? `Daily digest: ${n.us} on us, ${n.partner} on partners, ${n.followUps} to chase${n.gas ? `, ${n.gas} gas` : ""} - ${today}`
    : `Daily digest: all moving - ${today}`;
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `Daily digest · ${today}`,
    preheader: busy
      ? `${n.us} on us, ${n.partner} on partners, ${n.followUps} to chase, ${n.gas} gas issue${n.gas === 1 ? "" : "s"} across ${n.systems} systems.`
      : `All ${n.systems} systems moving - nothing blocked, nothing to chase.`,
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
  const { sections, operatorName } = await collectDigest(tenantOrgId);
  const section = sections.find((s) => s.orgId === orgId);
  if (!section) return null;
  const n = digestCounts([section]);
  const today = todayLabel();
  const url = appUrl();

  const subject = `${operatorName} × ${section.name}: daily digest - ${today}`;
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `${operatorName} × ${section.name} · Daily digest · ${today}`,
    preheader: n.partner
      ? `${n.partner} item${n.partner === 1 ? "" : "s"} awaiting ${section.name} intervention · ${n.systems} systems in work.`
      : n.handoffs
        ? `${n.handoffs} system${n.handoffs === 1 ? "" : "s"} in your hands · nothing needs your intervention.`
        : `${n.systems} system${n.systems === 1 ? "" : "s"} in work - nothing needs your intervention.`,
    width: 680,
    body: renderDigestBody([section], false, operatorName),
    footer: url
      ? `Sent each morning by ${esc(operatorName)}. Questions on a system? Open it in the portal and reply there: <a href="${esc(url)}" style="color:${EMAIL.faint};">${esc(url.replace(/^https?:\/\//, ""))}</a>`
      : `Sent each morning by ${esc(operatorName)}.`,
  });
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Delivery.
// ---------------------------------------------------------------------------

/**
 * Send the morning's digests: the internal edition to each operator's staff,
 * then a partner edition to every organization that has opted in
 * (digest_recipients set). One workspace at a time, one engagement per
 * partner email - the isolation that keeps one client's systems out of
 * another's inbox is structural, not a filter.
 */
export async function runDailyDigest(): Promise<{ sent: number; partnersSent: number; skipped: string[] }> {
  const allOrgs = await db.select().from(orgs);
  const operators = allOrgs.filter((o) => o.isOperator);
  const workspaces: (number | null)[] = operators.length ? operators.map((o) => o.id) : [null];
  let sent = 0;
  let partnersSent = 0;
  const skipped: string[] = [];

  for (const tenantOrgId of workspaces) {
    const who = operators.find((o) => o.id === tenantOrgId)?.name ?? "this instance";

    // Internal edition, to the workspace's own staff.
    const to = await houseEmails(tenantOrgId);
    if (to.length) {
      const { subject, html } = await composeDigest(tenantOrgId);
      await sendEmail(to, subject, html);
      sent++;
    } else {
      skipped.push(`${who}: nobody to send to`);
    }

    // Partner editions, opt-in per organization. Scoped to this workspace's
    // own organizations, and only ones with a section worth sending.
    const partners = allOrgs.filter((o) =>
      o.digestRecipients.trim()
      && o.id !== tenantOrgId
      && (tenantOrgId === null || o.parentOrgId === tenantOrgId));
    for (const p of partners) {
      const edition = await composePartnerDigest(tenantOrgId, p.id);
      if (!edition) { skipped.push(`${p.name}: nothing on the board`); continue; }
      const recipients = p.digestRecipients.split(",").map((s) => s.trim()).filter(Boolean);
      await sendEmail(recipients, edition.subject, edition.html);
      partnersSent++;
    }
  }

  if (!sent && !skipped.length) throw new Error("No house members configured (STAFF_EMAILS or Settings > Admin)");
  return { sent, partnersSent, skipped };
}
