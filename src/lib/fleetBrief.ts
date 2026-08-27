// One client's fleet, written down for somebody outside this workspace.
//
// Two things a service company constantly needs and has to do by hand: tell a
// peer what a shared client actually runs ("Emery Pharma, twelve systems - here
// is the list"), and put that same list in an email in the next thirty seconds.
// Both are the same artifact, so there is exactly ONE composer here and the
// copy button, the email and the shared page all render from it. The lesson is
// borrowed from lib/eodEmail, where the clipboard and the mail drifted apart
// and the clipboard quietly carried lines the email had been filtering out.
//
// WHAT IS NOT IN THE ROW TYPE IS THE DESIGN. FleetRow has no cost, no price, no
// purchase order and no discussion. Not because the renderers avoid printing
// them - because there is nowhere to put them, so no later edit can add one
// without changing the type and meeting this comment. Same discipline as
// lib/dossier's SystemDossier, and for the same reason: the recipient is
// frequently a competitor, and what a job cost is the owner's business.
//
// What IS in it is what a peer needs to answer "can you cover this for me next
// Tuesday": what the machine is, what modules and serials are in it, which
// building it lives in, whether it is running, and whether somebody already has
// a contract on it. That last one is the whole reason to ask.
//
// Pure. Callers hand in the rows.

import { esc, emailShell, mutedLine } from "@/lib/emailTheme";
import { CLIENT_STATE, type ClientState } from "@/lib/clientView";
import { coverageSummary, type CoverageState } from "@/lib/coverage";

/** One module inside a system: what it is, what model, what serial. */
export type FleetModule = {
  kind: string;
  model: string;
  serial: string;
  manufacturer: string;
};

/**
 * One system, as a peer may see it.
 *
 * Deliberately not a database row and deliberately narrow - see the header. If
 * a field is not here it does not leave the workspace.
 */
export type FleetRow = {
  externalId: string;
  /** The human name, composed the same way every other surface composes it. */
  label: string;
  category: string;
  siteName: string;
  modules: FleetModule[];
  state: ClientState;
  coverage: CoverageState;
  /** "Under contract" / "Agilent" / "Contract lapsed" / "No contract on file". */
  coverageBadge: string;
};

export type FleetBrief = {
  client: string;
  /** Who is sending it. A brief with no sender is a list nobody can act on. */
  from: string;
  today: string;
  /** "12 instruments · 9 under a service contract". Never names an operator. */
  headline: string;
  groups: { site: string; rows: FleetRow[] }[];
  /** How the reader gets a live view, when one was minted. */
  link: { url: string; expiresOn: string } | null;
  note: string;
};

/**
 * Group by building, and only when there is more than one.
 *
 * A twelve-system client at one address is a list; the same twelve across two
 * buildings is two lists, because "which of these are in Hayward" is the first
 * question a peer asks and the one that decides whether they can help at all.
 * Systems with no site recorded gather at the end under a plain word rather
 * than an empty heading.
 */
export function groupBySite(rows: FleetRow[]): { site: string; rows: FleetRow[] }[] {
  const named = [...new Set(rows.map((r) => r.siteName.trim()).filter(Boolean))].sort();
  const unsited = rows.filter((r) => !r.siteName.trim());
  if (named.length <= 1 && unsited.length === 0) return [{ site: "", rows }];
  if (named.length === 0) return [{ site: "", rows }];
  const groups = named.map((site) => ({ site, rows: rows.filter((r) => r.siteName.trim() === site) }));
  if (unsited.length) groups.push({ site: "Site not recorded", rows: unsited });
  return groups;
}

/** The order a peer wants: whatever is broken first, then by name. */
const bySeverityThenName = (a: FleetRow, b: FleetRow): number =>
  CLIENT_STATE[a.state].rank - CLIENT_STATE[b.state].rank
  || a.externalId.localeCompare(b.externalId, undefined, { numeric: true });

export function buildFleetBrief(input: {
  client: string;
  from: string;
  today: string;
  rows: FleetRow[];
  link?: { url: string; expiresOn: string } | null;
  note?: string;
}): FleetBrief {
  const rows = [...input.rows].sort(bySeverityThenName);
  return {
    client: input.client.trim() || "the client",
    from: input.from.trim(),
    today: input.today,
    // The client's own estate, counted the way their own page counts it -
    // covered means ANY live contract, ours or anybody's, because a peer asking
    // "who has this one" wants the true answer and not our share of it.
    headline: coverageSummary(rows.map((r) => r.coverage)),
    groups: groupBySite(rows).map((g) => ({ site: g.site, rows: [...g.rows].sort(bySeverityThenName) })),
    link: input.link ?? null,
    note: (input.note ?? "").trim(),
  };
}

/** "Mass Spec · Thermo Altis · SN 12345", the way lib/assetServes names a unit. */
export const moduleLine = (m: FleetModule): string =>
  [m.kind, [m.manufacturer, m.model].filter(Boolean).join(" "), m.serial && `SN ${m.serial}`]
    .filter(Boolean).join(" · ") || "Unit";

/** The second line under a system: where it is, how it is, who has it. */
export function systemMeta(r: FleetRow, showSite: boolean): string {
  return [
    showSite && r.siteName.trim(),
    CLIENT_STATE[r.state].label,
    r.coverageBadge,
  ].filter(Boolean).join(" · ");
}

/**
 * The plain-text brief.
 *
 * Not a fallback for the HTML one - this IS the copy button, and it is the form
 * most of these actually travel in, because a peer gets it pasted into a text
 * message or the middle of a reply. So it has to survive having no formatting
 * at all: no table alignment, no characters that turn into mojibake on a phone.
 */
export function renderFleetBriefText(b: FleetBrief): string {
  const out: string[] = [];
  out.push(`${b.client} - fleet summary (${b.today})`);
  out.push(b.headline);
  if (b.from) out.push(`From ${b.from}`);
  if (b.note) { out.push(""); out.push(b.note); }

  for (const g of b.groups) {
    out.push("");
    if (g.site) out.push(`-- ${g.site} --`);
    for (const r of g.rows) {
      out.push(`${r.externalId}  ${r.label}`);
      const meta = systemMeta(r, false);
      if (meta) out.push(`  ${meta}`);
      for (const m of r.modules) out.push(`  - ${moduleLine(m)}`);
    }
  }
  if (b.link) {
    out.push("");
    out.push(`Live list: ${b.link.url}`);
    out.push(`This link stops working on ${b.link.expiresOn}.`);
  }
  return out.join("\n");
}

/** The same brief as an email body, for emailShell. */
export function fleetBriefBody(b: FleetBrief): string {
  const parts: string[] = [];
  parts.push(`<div style="font-size:16px;font-weight:bold;">${esc(b.client)}</div>`);
  parts.push(`<div style="margin-top:2px;">${esc(b.headline)}</div>`);
  if (b.note) parts.push(`<div style="margin-top:10px;">${esc(b.note)}</div>`);

  for (const g of b.groups) {
    if (g.site) {
      parts.push(`<div style="margin-top:16px;font-weight:bold;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;">${esc(g.site)}</div>`);
    }
    for (const r of g.rows) {
      parts.push(`<div style="margin-top:12px;padding-top:10px;border-top:1px solid #E6E6E6;">
        <div><b>${esc(r.externalId)}</b> ${esc(r.label)}</div>
        ${systemMeta(r, false) ? `<div style="font-size:12px;color:#666666;">${esc(systemMeta(r, false))}</div>` : ""}
        ${r.modules.length
          ? `<div style="font-size:12px;color:#333333;margin-top:4px;">${
            r.modules.map((m) => esc(moduleLine(m))).join("<br />")}</div>`
          : ""}
      </div>`);
    }
  }
  if (b.link) {
    parts.push(mutedLine(`Live list: <a href="${esc(b.link.url)}">${esc(b.link.url)}</a> - stops working on ${esc(b.link.expiresOn)}.`));
  }
  return parts.join("\n");
}

export function renderFleetBriefHtml(b: FleetBrief, brand: { name: string; logoUrl?: string }): string {
  return emailShell({
    brand: brand.name,
    logoUrl: brand.logoUrl,
    preheader: b.headline,
    body: fleetBriefBody(b),
    // Wider than a notification: this is a list, and a list wrapping at 560px
    // puts a serial on its own line where it reads as a separate module.
    width: 640,
    footer: b.from
      ? `Sent by ${esc(b.from)}. Equipment details only - nothing here is a price or a quote.`
      : "Equipment details only - nothing here is a price or a quote.",
  });
}

/** The subject line. The client and the date, because these get filed. */
export const fleetBriefSubject = (b: FleetBrief): string =>
  `${b.client} - fleet summary (${b.today})`;

/** Everything wrong with a request to send one. Empty means go ahead. */
export function briefProblems(rows: FleetRow[], to: string[]): string[] {
  const out: string[] = [];
  if (rows.length === 0) out.push("There are no systems on file for this client yet");
  if (to.length === 0) out.push("Say who it goes to");
  if (to.length > MAX_RECIPIENTS) out.push(`At most ${MAX_RECIPIENTS} addresses at a time`);
  const bad = to.filter((a) => !looksLikeEmail(a));
  if (bad.length) out.push(`That is not an address: ${bad[0]}`);
  return out;
}

/**
 * The first hand-typed recipient list in the app - everything else sends to
 * addresses already stored on an organization. So it is capped, and small: this
 * is a note to a colleague, and a field that accepts thirty addresses is a
 * field somebody will eventually paste a mailing list into.
 */
export const MAX_RECIPIENTS = 5;

const looksLikeEmail = (a: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim());

/** Split what somebody typed. Commas, semicolons, spaces and newlines all work. */
export function parseRecipients(raw: string): string[] {
  return [...new Set(
    raw.split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean),
  )];
}
