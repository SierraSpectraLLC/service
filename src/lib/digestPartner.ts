/**
 * The partner daily digest, as an EMAIL.
 *
 * Not a web page squeezed into a mail client: table layout, every style
 * inline, one 600px column that survives Outlook's Word renderer and a 320px
 * phone alike. The reference mock this follows lives in the design notes; the
 * rules it encodes are worth stating, because each was a failure somewhere:
 *
 *   - Tables, never flex or grid. Outlook ignores both.
 *   - No stylesheet except the MSO conditional; Gmail strips <style> in some
 *     views and every class with it.
 *   - width="600" for Outlook (which ignores max-width and lays out from the
 *     attribute) AND style="width:100%;max-width:600px" for everything else.
 *     Not width:600px: a table cannot shrink below the width it is told to
 *     be, so a fixed pixel width plus max-width:100% is a 600px table with a
 *     horizontal scrollbar on a phone - measured at 320px, which is the only
 *     way anybody finds out.
 *   - A hidden preheader as the first body child, or the inbox previews
 *     whatever cell happens to win.
 *   - Under 80 KB total, because Gmail clips the rest and appends a "view
 *     entire message" link that half of readers never press.
 *
 * The view model is built by the caller (lib/digest) so this file is pure and
 * a fixture can render the exact bytes that get sent. Colours come from
 * TONE_HEX, the same pairs the app's pills use; stage pills keep whatever hex
 * that tenant's stage definitions carry.
 */
import { EMAIL, esc } from "@/lib/emailTheme";
import { TONE_HEX } from "@/lib/tones";
import type { Court, PendingCause, PendingItem } from "@/lib/digest";

/** One line of "your move" or "with us": an imperative, and why it matters. */
export type PartnerAsk = {
  externalId: string;
  /** The imperative: "Order the part: X", "Tracking numbers for Y". */
  ask: string;
  /** Muted second line: the system, and what the ask is holding up. */
  why: string;
};

export type PartnerHandback = {
  externalId: string;
  label: string;
  /** What was done - the reason it went back to them. */
  what: string;
  /** "2d" / "3w". */
  age: string;
};

export type PartnerSystem = {
  externalId: string;
  label: string;
  /** ONE stage, with its tenant hex. Blank name = no pill. */
  stage: string;
  stageBg: string;
  stageFg: string;
  /** The short "where it is" fragment, already carrying "(above)" if it applies. */
  status: string;
  /** Only when a gas is actually blocking: "needs Ar". Blank otherwise. */
  gasNeed: string;
  openParts: number;
  /** First name or display name, never a username. Blank when unassigned. */
  lead: string;
};

export type PartnerDigestView = {
  operatorName: string;
  clientName: string;
  /** "Saturday, Aug 22". */
  dateLabel: string;
  portalUrl: string;
  needs: PartnerAsk[];
  blocked: PartnerAsk[];
  handedBack: PartnerHandback[];
  inWork: PartnerSystem[];
  /** Rows dropped by the size caps, so the mail can say so out loud. */
  moreHandedBack: number;
  moreInWork: number;
};

const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "Menlo,Consolas,monospace";
const GROUND = EMAIL.ground;
const LINE = EMAIL.border;
const BODY_INK = EMAIL.body;

/**
 * How many rows each list may carry before it says "+N more in the portal".
 *
 * A fleet of two hundred systems would otherwise render a 120 KB email that
 * Gmail clips mid-table - and a clipped list is worse than a counted one,
 * because the reader cannot tell it was cut.
 */
export const MAX_HANDED_BACK = 40;
export const MAX_IN_WORK = 60;

/** "2d" / "3w" - the age of something, at the precision anybody acts on. */
export const age = (days: number): string =>
  days >= 14 ? `${Math.round(days / 7)}w` : `${Math.max(0, Math.round(days))}d`;

/** "Tue Aug 26" - a date somebody reads off a line, not an ISO stamp. */
export const dayLabel = (d: Date, tz = process.env.SHOP_TZ || "America/Los_Angeles"): string =>
  d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });

/**
 * The name a person is called, never the login. "joe.vincent@x.com" and
 * "jvincent" both read as noise on a client's screen; the first name of a
 * display name is what the client hears on the phone.
 */
export function firstName(lead: string): string {
  const raw = (lead ?? "").trim();
  if (!raw) return "";
  // An address is a username by another name - take what is in front of it,
  // and only when it looks like a name rather than an initial-and-surname id.
  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  const spoken = local.replace(/[._]+/g, " ").trim();
  const first = spoken.split(/\s+/)[0] ?? "";
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const cell = (extra: string) =>
  `padding:9px 0;border-top:1px solid ${LINE};${extra}`;

const idCell = (id: string, first: boolean, pad = "9px") =>
  `<td style="padding:${pad} 0;border-top:1px solid ${LINE};vertical-align:top;${first ? "width:64px;" : ""}font-family:${MONO};font-size:12px;font-weight:700;color:${EMAIL.ink};">${esc(id)}</td>`;

const sectionHead = (label: string, n: number, color: string, sub = "") => `
  <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:${color};">${esc(label.toUpperCase())} &middot; ${n}</div>
  ${sub ? `<div style="font-size:12px;color:${EMAIL.muted};margin-top:3px;">${esc(sub)}</div>` : ""}`;

/** A section is a row of the outer card; empty sections are never rendered. */
const section = (inner: string) => `
<tr><td style="padding:18px 24px 0;font-family:${FONT};">${inner}</td></tr>`;

/** The two-line ask rows shared by "needs you" and "blocked with us". */
function askRows(items: PartnerAsk[]): string {
  return items.map((x, i) => `
    <tr>${idCell(x.externalId, i === 0)}
        <td style="${cell(`font-size:14px;color:${BODY_INK};`)}">${esc(x.ask)}${
          x.why ? `<div style="font-size:12px;color:${EMAIL.muted};margin-top:2px;">${esc(x.why)}</div>` : ""
        }</td></tr>`).join("");
}

const table = (rows: string) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${rows}</table>`;

/** One summary tile. The whole tile is the link, so a thumb can hit it. */
function tile(n: number, label: string, tone: { bg: string; fg: string }, href: string): string {
  const inner = `<div style="font-size:22px;font-weight:800;color:${tone.fg};line-height:1;">${n}</div>
    <div style="font-size:11px;color:${tone.fg};margin-top:3px;">${esc(label)}</div>`;
  return `<td width="25%" style="padding:10px 8px;background:${tone.bg};border-radius:8px;text-align:center;">${
    href ? `<a href="${esc(href)}" style="text-decoration:none;color:${tone.fg};display:block;">${inner}</a>` : inner
  }</td>`;
}

const moreLine = (n: number, what: string, href: string) => n <= 0 ? "" : `
  <div style="font-size:12px;color:${EMAIL.muted};margin-top:8px;">
    ${n} more ${esc(what)} <a href="${esc(href)}" style="color:${EMAIL.link};">in the portal</a>.
  </div>`;

/**
 * The whole email. Subject lives with the composer; this renders the body a
 * client actually opens.
 */
export function renderPartnerDigest(v: PartnerDigestView, preheader: string): string {
  const needsLabel = `Needs ${v.clientName}`;
  const blockedLabel = `Blocked with ${v.operatorName}`;
  const portal = v.portalUrl;
  // The dashboard's own facets, which read from the VIEWER's side: on the
  // client's portal "Ours to move" is their court and "With someone else" is
  // ours. Tiles with no exact facet link to the list itself rather than
  // pretend to filter it.
  const filtered = (f: string) => (portal ? `${portal}/?f=${encodeURIComponent(f)}` : "");
  const plain = portal || "";

  const sections = [
    v.needs.length ? section(sectionHead(needsLabel, v.needs.length, TONE_HEX.warn.fg) + table(askRows(v.needs))) : "",
    v.blocked.length ? section(sectionHead(blockedLabel, v.blocked.length, TONE_HEX.bad.fg) + table(askRows(v.blocked))) : "",
    v.handedBack.length ? section(
      sectionHead(`Handed back to ${v.clientName}`, v.handedBack.length, TONE_HEX.good.fg,
        "Nothing pending from our side. Ready for the next step on your end.")
      + table(v.handedBack.map((h, i) => `
        <tr>${idCell(h.externalId, i === 0, "7px")}
            <td style="padding:7px 0;border-top:1px solid ${LINE};font-size:13px;color:${BODY_INK};">${
              esc([h.label, h.what].filter(Boolean).join(" · "))
            } <span style="color:${EMAIL.faint};">&middot; ${esc(h.age)}</span></td></tr>`).join(""))
      + moreLine(v.moreHandedBack, "handed back", plain)) : "",
    v.inWork.length ? section(
      sectionHead(`In work at ${v.operatorName}`, v.inWork.length, TONE_HEX.neutral.fg,
        "One line per system: where it is and what's next.")
      + table(v.inWork.map((s, i) => {
        const bits = [s.status, s.gasNeed, s.openParts > 0 ? `${s.openParts} part${s.openParts === 1 ? "" : "s"} open` : "", s.lead]
          .filter(Boolean).map(esc).join(" · ");
        const pill = s.stage
          ? `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:${s.stageBg};color:${s.stageFg};font-size:11px;font-weight:700;">${esc(s.stage)}</span>${bits ? "&nbsp; " : ""}`
          : "";
        return `
        <tr>${idCell(s.externalId, i === 0, "8px")}
            <td style="padding:8px 0;border-top:1px solid ${LINE};font-size:13px;color:${BODY_INK};">${esc(s.label)}${
              pill || bits ? `<div style="font-size:12px;color:${EMAIL.muted};margin-top:2px;">${pill}${bits}</div>` : ""
            }</td></tr>`;
      }).join(""))
      + moreLine(v.moreInWork, "in work", plain)) : "",
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${esc(`${v.operatorName} × ${v.clientName}: daily digest`)}</title>
<!--[if mso]><style>table{border-collapse:collapse}td{font-family:Arial,sans-serif}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${GROUND};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:${GROUND};">${esc(preheader)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;border:1px solid ${LINE};">

<tr><td style="height:4px;background:${EMAIL.ink};border-radius:10px 10px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:18px 24px 14px;border-bottom:1px solid ${LINE};font-family:${FONT};">
  <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:${EMAIL.ink};">${esc(v.operatorName.toUpperCase())}</div>
  <div style="font-size:12px;color:${EMAIL.muted};margin-top:2px;">${esc(`Daily digest for ${v.clientName} · ${v.dateLabel}`)}</div>
</td></tr>

<tr><td style="padding:16px 24px 4px;font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${tile(v.needs.length, "need you", TONE_HEX.warn, plain)}
    <td width="8"></td>
    ${tile(v.blocked.length, "blocked with us", TONE_HEX.bad, filtered("With someone else"))}
    <td width="8"></td>
    ${tile(v.handedBack.length + v.moreHandedBack, "handed back", TONE_HEX.good, filtered("Ours to move"))}
    <td width="8"></td>
    ${tile(v.inWork.length + v.moreInWork, "in work", TONE_HEX.neutral, plain)}
  </tr></table>
</td></tr>
${sections}
<tr><td style="padding:20px 24px 8px;font-family:${FONT};" align="center">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${EMAIL.ink};border-radius:8px;"><a href="${esc(plain)}" style="display:inline-block;padding:10px 18px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;">Open the portal</a></td></tr></table>
</td></tr>
<tr><td style="padding:8px 24px 20px;font-family:${FONT};font-size:11px;color:${EMAIL.faint};line-height:1.5;text-align:center;">
  Sent each morning by ${esc(v.operatorName)}. Questions on a system? Open it in the portal and reply there.${
    plain ? `<br><a href="${esc(plain)}" style="color:${EMAIL.faint};">${esc(plain.replace(/^https?:\/\//, ""))}</a>` : ""
  }
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The same digest as plain text, from the same view model - the half of
 * multipart/alternative that a text client, a screen reader in text mode, or
 * a spam filter reads. Generated rather than hand-kept, so it can never drift
 * from what the HTML says.
 */
export function renderPartnerDigestText(v: PartnerDigestView, preheader: string): string {
  const out: string[] = [];
  const rule = "-".repeat(58);
  out.push(`${v.operatorName.toUpperCase()} - daily digest for ${v.clientName}`);
  out.push(v.dateLabel);
  out.push("");
  out.push(preheader);
  const block = (title: string, lines: string[], sub = "") => {
    if (!lines.length) return;
    out.push("", rule, title.toUpperCase(), ...(sub ? [sub] : []), "");
    out.push(...lines);
  };
  block(`Needs ${v.clientName} (${v.needs.length})`,
    v.needs.flatMap((x) => [`  ${x.externalId}  ${x.ask}`, ...(x.why ? [`          ${x.why}`] : [])]));
  block(`Blocked with ${v.operatorName} (${v.blocked.length})`,
    v.blocked.flatMap((x) => [`  ${x.externalId}  ${x.ask}`, ...(x.why ? [`          ${x.why}`] : [])]));
  block(`Handed back to ${v.clientName} (${v.handedBack.length + v.moreHandedBack})`,
    [
      ...v.handedBack.map((h) => `  ${h.externalId}  ${[h.label, h.what].filter(Boolean).join(" - ")} (${h.age})`),
      ...(v.moreHandedBack ? [`  ...and ${v.moreHandedBack} more in the portal.`] : []),
    ],
    "Nothing pending from our side.");
  block(`In work at ${v.operatorName} (${v.inWork.length + v.moreInWork})`,
    [
      ...v.inWork.map((s) => {
        const bits = [s.stage, s.status, s.gasNeed, s.openParts > 0 ? `${s.openParts} part${s.openParts === 1 ? "" : "s"} open` : "", s.lead]
          .filter(Boolean).join(" - ");
        return `  ${s.externalId}  ${s.label}${bits ? `\n          ${bits}` : ""}`;
      }),
      ...(v.moreInWork ? [`  ...and ${v.moreInWork} more in the portal.`] : []),
    ]);
  out.push("", rule, `Open the portal: ${v.portalUrl}`);
  out.push(`Sent each morning by ${v.operatorName}. Questions on a system? Open it in the portal and reply there.`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The view model: one engagement's section, turned into what a client reads.
// Pure, so a fixture renders the exact bytes that get sent.
// ---------------------------------------------------------------------------

/** Shorthand a client reads on a line. Unknown gases keep their full name. */
const GAS_SHORT: Record<string, string> = {
  Helium: "He", Nitrogen: "N2", Argon: "Ar", Hydrogen: "H2", Oxygen: "O2",
};

/**
 * Remarks the machine wrote about our own bookkeeping, which a client must
 * never read: the sheet sync's "no longer on the Google sheet", a parity
 * note, an internal aside. Free text reaches this email in exactly two places
 * - the reason a system was handed back, and the reason one is blocked - and
 * both are typed by a person who may be talking to us rather than to them.
 * Matched on the phrasing those generators use, not on a flag, because the
 * text may have been pasted anywhere by hand.
 */
export function internalRemark(text: string): boolean {
  return /google sheet|sheet sync|sheet-sync|not on (the )?sheet|parity|\[internal\]|\(internal\)/i.test(text ?? "");
}

/** "Waiting on a roughing pump" -> "roughing pump", for the one-line recap. */
function shorten(subject: string, max = 42): string {
  const s = subject.trim().replace(/^waiting (on|for) (a|an|the)?\s*/i, "").replace(/\.$/, "");
  const one = s.charAt(0).toLowerCase() + s.slice(1);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}...` : one;
}

/**
 * A blocked reason arrives as one sentence with the detail hung off a dash:
 * "Waiting on a roughing pump - the Edwards RV5 is on T-001 until Tuesday".
 * The head is the ask; the tail is why it matters and belongs on the muted
 * line, where it does not compete with the twenty other headlines.
 */
export function splitReason(reason: string): [string, string] {
  // Either dash, because the reason was typed by a person: \u2013 is what an
  // editor's autocorrect leaves behind when somebody types a hyphen.
  const at = reason.search(/\s+[-\u2013]\s+/);
  if (at < 0) return [reason.trim(), ""];
  return [reason.slice(0, at).trim(), reason.slice(at).replace(/^\s*[-\u2013]\s*/, "").trim()];
}

/** Two subjects read as a pair; more read as a count. */
const joinSubjects = (subjects: string[]): string =>
  subjects.length <= 2 ? subjects.join(" and ") : `${subjects.slice(0, 2).join(", ")} and ${subjects.length - 2} more`;

/**
 * The imperative a client acts on, per cause. An ask worded as a status
 * ("No tracking yet for X") tells somebody a fact; worded as an instruction it
 * tells them what to do, which is the only reason this email exists.
 */
function askFor(cause: PendingCause, subjects: string[]): string {
  const what = joinSubjects(subjects);
  switch (cause) {
    case "part-tracking": return `Tracking numbers for ${what}`;
    case "part-order": return `Order the part: ${what}`;
    case "part-backorder": return `Chase the backorder: ${what}`;
    case "workorder": return `Reply on: ${what}`;
    case "blocked": return what.charAt(0).toUpperCase() + what.slice(1);
    case "ship": return "Confirm the shipping details";
    case "task": return `Blocked: ${what}`;
    case "part-transit": return `${what} in transit`;
  }
}

/** The recap that appears beside a system further down, ending "(above)". */
function recap(cause: PendingCause, court: Court, subjects: string[]): string {
  if (court === "partner") {
    switch (cause) {
      case "part-tracking": return "waiting on your tracking numbers";
      case "part-order": return "waiting on your part order";
      case "part-backorder": return "waiting on your backordered part";
      case "workorder": return "waiting on your reply";
      default: return "needs you";
    }
  }
  if (cause === "ship") return "ready to ship";
  return `with us, ${shorten(subjects[0] ?? "", 28)}`;
}

type MergedAsk = {
  systemId: number; externalId: string; court: Court; cause: PendingCause;
  subjects: string[]; who: string; days: number | null; eta: string;
};

/**
 * Items that share a system AND a cause are one ask: a system missing tracking
 * for two parts is one phone call, and listing it twice makes a two-item list
 * look like a two-problem morning.
 */
export function mergeAsks(items: PendingItem[]): MergedAsk[] {
  const out: MergedAsk[] = [];
  const at = new Map<string, MergedAsk>();
  for (const x of items) {
    const key = `${x.systemId}|${x.cause}`;
    const found = at.get(key);
    if (found) {
      if (x.subject && !found.subjects.includes(x.subject)) found.subjects.push(x.subject);
      // The oldest wait is the one worth quoting.
      if (x.days !== null && (found.days === null || x.days > found.days)) found.days = x.days;
      if (!found.eta && x.eta) found.eta = x.eta;
      continue;
    }
    const made: MergedAsk = {
      systemId: x.systemId, externalId: x.externalId, court: x.court, cause: x.cause,
      subjects: x.subject ? [x.subject] : [], who: x.who, days: x.days, eta: x.eta ?? "",
    };
    at.set(key, made);
    out.push(made);
  }
  return out;
}

/**
 * Build the client's view of one engagement.
 *
 * `labelOf` names a system (the board carries it), `stageHex` resolves a stage
 * to that tenant's own colours, and `gasBlocking` decides whether a gas is
 * worth a client's attention - all injected so this stays free of the database
 * and of lib/stages' import weight.
 */
export function partnerView(opts: {
  section: {
    name: string;
    board: {
      externalId: string; label: string; stages: string[];
      gases: { gas: string; status: string }[]; openParts: number; lead: string;
    }[];
    pending: PendingItem[];
    handoffs: { externalId: string; label: string; holder: string; reason: string; days: number }[];
  };
  operatorName: string;
  dateLabel: string;
  portalUrl: string;
  blockedStage: string;
  stageHex: (stage: string) => { bg: string; fg: string };
  gasBlocking: (status: string) => boolean;
}): PartnerDigestView {
  const { section, operatorName } = opts;
  const clientName = section.name;
  const merged = mergeAsks(section.pending);
  const labelOf = new Map(section.board.map((b) => [b.externalId, b.label]));

  const why = (m: MergedAsk, detail = ""): string => {
    const label = labelOf.get(m.externalId) ?? "";
    const bits = [label, detail];
    if (m.court === "partner" && m.days !== null) bits.push(`ordered by ${m.who} ${age(m.days)} ago`);
    if (m.eta) bits.push(`ETA ${m.eta}`);
    if (m.court !== "partner" && m.days !== null) bits.push(age(m.days));
    if (m.cause === "part-tracking" && m.court === "partner") bits.push("we cannot book the work until they land");
    if (m.cause === "part-order" && m.court === "partner") bits.push("the repair waits on this part");
    return bits.filter(Boolean).join(" · ");
  };
  const asks = (list: MergedAsk[]): PartnerAsk[] =>
    list.map((m) => {
      const [head, detail] = m.cause === "blocked" ? splitReason(m.subjects[0] ?? "") : ["", ""];
      return {
        externalId: m.externalId,
        ask: head || askFor(m.cause, m.subjects),
        why: why(m, detail),
      };
    });

  const sayable = merged.filter((m) => !m.subjects.some(internalRemark));
  const needs = asks(sayable.filter((m) => m.court === "partner"));
  // A supplier wait is still, from the client's chair, a wait on us: we placed
  // the order and we are the ones chasing it. The second line names the date.
  const blocked = asks(sayable.filter((m) => m.court !== "partner"));

  // "Handed back" means back to THEM. A system parked with a third party is
  // not handed back to this client and is not advertised as though it were.
  const handedBackAll = section.handoffs.filter((h) => h.holder === clientName);
  const handedBack: PartnerHandback[] = handedBackAll.slice(0, MAX_HANDED_BACK).map((h) => ({
    externalId: h.externalId, label: h.label,
    what: internalRemark(h.reason) ? "" : h.reason,
    age: age(h.days),
  }));

  const above = new Map<string, string>();
  for (const m of sayable) {
    const subjects = m.cause === "blocked" ? [splitReason(m.subjects[0] ?? "")[0]] : m.subjects;
    if (!above.has(m.externalId)) above.set(m.externalId, `${recap(m.cause, m.court, subjects)} (above)`);
  }

  const inWork: PartnerSystem[] = section.board.slice(0, MAX_IN_WORK).map((b) => {
    // One pill, never a stack: blocked outranks everything, otherwise the
    // first stage the record carries.
    const stage = b.stages.includes(opts.blockedStage) ? opts.blockedStage : (b.stages[0] ?? "");
    const hex = stage ? opts.stageHex(stage) : { bg: "", fg: "" };
    const needsGas = b.gases.filter((g) => opts.gasBlocking(g.status))
      .map((g) => GAS_SHORT[g.gas] ?? g.gas);
    const lead = firstName(b.lead);
    const recapLine = above.get(b.externalId) ?? "";
    return {
      externalId: b.externalId, label: b.label,
      stage, stageBg: hex.bg, stageFg: hex.fg,
      status: recapLine || (!stage && !lead ? "not yet started" : lead ? "" : "not yet assigned"),
      gasNeed: needsGas.length ? `needs ${needsGas.join(" + ")}` : "",
      openParts: b.openParts,
      lead,
    };
  });

  return {
    operatorName, clientName, dateLabel: opts.dateLabel, portalUrl: opts.portalUrl,
    needs, blocked, handedBack, inWork,
    moreHandedBack: Math.max(0, handedBackAll.length - handedBack.length),
    moreInWork: Math.max(0, section.board.length - inWork.length),
  };
}

/** The inbox line: the counts, in the order the sections come. */
export function partnerPreheader(v: PartnerDigestView): string {
  const parts = [
    `${v.needs.length} thing${v.needs.length === 1 ? " needs" : "s need"} ${v.clientName}`,
    `${v.blocked.length} blocked with us`,
    `${v.handedBack.length + v.moreHandedBack} handed back`,
    `${v.inWork.length + v.moreInWork} in work`,
  ];
  return parts.join(" · ");
}
