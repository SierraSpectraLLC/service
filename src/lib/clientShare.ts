// Handing a client to another service company.
//
// Not the fleet brief. That is a DESCRIPTION - a page a peer reads to answer
// "can you cover this" - and it goes to anybody with the link. This is a
// HANDOVER: the other shop ends up with the client in their own workspace,
// their own systems, their own records, and works it. So the recipient has to
// agree, and what arrives has to be enough to service.
//
// THE SNAPSHOT IS FROZEN AT THE OFFER. What the other shop approves is exactly
// what they get, however long they take to answer, and accepting is therefore
// deterministic - no "we sent you twelve and eleven arrived because somebody
// retired one on Tuesday". The cost is that a stale offer is stale; the answer
// to that is to withdraw and re-send, which is one button and is honest.
//
// AND IT IS A COPY, NOT A SYNC. Two records of one client in two workspaces
// start diverging the moment either shop edits one, and nothing here pretends
// otherwise. What the copy carries instead is its provenance: where it came
// from, when, and each machine's tag in the OTHER shop, so a phone call can
// establish that your EP-001 is their NW-114. Keeping two workspaces in step
// is a different and much harder feature, and building half of it by accident
// is how you get two records that are each confidently wrong.
//
// Pure. Callers hand in the rows.

export const SHARE_VERSION = 1;

/** One module inside a system: what it is, what model, what serial. */
export type SharedModule = {
  kind: string; model: string; serial: string; manufacturer: string;
};

export type SharedSystem = {
  /** OUR tag for it. Becomes their source_ref, never their external id. */
  sourceRef: string;
  model: string;
  category: string;
  /** Which site, by NAME - the payload carries sites separately. */
  siteName: string;
  location: string;
  modules: SharedModule[];
};

export type SharedSite = {
  name: string;
  address: string;
  /** How to get in. Included because the other shop has to physically get in. */
  accessNotes: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

/**
 * Everything that crosses.
 *
 * What is NOT here is the design, and the list is deliberate. No agreements,
 * no rates, no invoices, no quotes, no allowances - what a client pays us is
 * ours and theirs, and putting it in another company's database is the single
 * worst thing this feature could do. No internal notes, no discussion, no work
 * order history: the story of what went wrong on a machine is the client's,
 * and the other shop should hear it from the client. No people or logins - the
 * recipient invites whoever they invite.
 *
 * What IS here is what a shop needs to walk in on Monday and work: who the
 * client is, where their buildings are and how to get into them, what machines
 * are there and what is inside each one.
 */
/** A maintenance rhythm: what, how often, and when it is next owed. */
export type SharedPm = {
  sourceRef: string;   // which system, by the SENDER's tag
  /**
   * Which MODULE of that system, by its position in the system's module list -
   * a pump oil change belongs to the pump, not to the LC-MS around it.
   *
   * A position rather than a serial, because the serial is the one field
   * blinding removes, and a reference that survives redaction is one this can
   * never leak through. Both sides walk the same list in the same order:
   * materialize writes modules in payload order, so index 1 here is the second
   * module it inserted. Absent or null = the schedule is on the system itself.
   */
  moduleIndex?: number | null;
  title: string;
  everyDays: number;
  nextDue: string;     // YYYY-MM-DD
  lastDone: string;
};

/**
 * A part that went into this fleet.
 *
 * What it is and when, never what it cost. A parts history is the most useful
 * thing a shop taking over an account can have - it says what this lab burns
 * through and how often - and none of that requires a price.
 */
export type SharedPart = {
  sourceRef: string;
  name: string;
  partNumber: string;
  qty: string;
  installedAt: string;
};

/** A manual or a field note, filed on a model rather than on a machine. */
export type SharedRef = {
  assetType: string;
  model: string;
  kind: string;        // link | note
  title: string;
  url: string;
  body: string;
};

/**
 * WHAT THE ACCOUNT HAS BEEN WORTH, and the one thing here that is money.
 *
 * Everything else in this payload is equipment: facts about machines, which
 * belong to whoever services them next. This does not. It is what one company
 * charged another, and it moves only because an account SALE is a different
 * act from a referral - a shop buying a book of business cannot price the work
 * without knowing what the client is used to paying, and withholding it does
 * not protect anybody, it just makes the first quote wrong.
 *
 * So it is OPTIONAL and off unless the sender turns it on, it is a summary
 * rather than the invoices (per-year totals and the rates that were charged -
 * never a document, never what they paid late, never their credit standing),
 * and it is stripped from every blind view. A stranger reading an offer learns
 * that billing history EXISTS and over how long; the figures arrive only with
 * acceptance.
 */
export type SharedPricing = {
  /** Whole years, newest first: { year, billedCents, visits }. */
  years: { year: string; billedCents: number; visits: number }[];
  /** What an hour and a visit were charged at, when the record says. */
  laborRateCents: number;
  note: string;
};

export type SharePayload = {
  version: number;
  client: { name: string; kind: string };
  sites: SharedSite[];
  systems: SharedSystem[];
  /**
   * The rest of the record, and the reason a hand-off is worth taking: the
   * maintenance rhythm, what the fleet consumes, and the paper behind it.
   * Optional so a payload written before they existed still parses.
   */
  pms?: SharedPm[];
  parts?: SharedPart[];
  refs?: SharedRef[];
  /** Only when the sender chose to include it. See SharedPricing. */
  pricing?: SharedPricing;
  /** Who sent it and when, frozen into the copy itself. */
  from: { operator: string; by: string; on: string };
  note: string;
};

/**
 * What is in this record, as the counts that make an offer worth opening.
 *
 * Deliberately counts rather than contents: it is what a blind page may say
 * about a client whose name it must not print, and it is the honest inventory
 * of what actually crosses on acceptance - so nothing here can promise
 * something materialize does not deliver.
 */
export type ShareInventory = {
  systems: number;
  sites: number;
  modules: number;
  pms: number;
  parts: number;
  refs: number;
  /** Years of billing history, or 0 when the sender did not include any. */
  pricingYears: number;
};

export function inventoryOf(p: SharePayload): ShareInventory {
  return {
    systems: p.systems.length,
    sites: p.sites.length,
    modules: p.systems.reduce((n, s) => n + s.modules.length, 0),
    pms: p.pms?.length ?? 0,
    parts: p.parts?.length ?? 0,
    refs: p.refs?.length ?? 0,
    pricingYears: p.pricing?.years.length ?? 0,
  };
}

/**
 * The inventory as a list somebody reads down before deciding.
 *
 * Zeroes are dropped rather than printed. "0 maintenance schedules" is an
 * argument against taking the offer, and printing it next to four real numbers
 * makes the whole list read as a form somebody half-filled.
 */
const countLine = (v: number, one: string, many: string) =>
  v > 0 ? `${v} ${v === 1 ? one : many}` : "";

/**
 * The half of the inventory that is not equipment - the RECORD.
 *
 * Split out because the equipment is usually already on the screen beside it
 * (summarize says how many systems, and a list of them is often right there),
 * and repeating it turns a summary into a stutter. This is the half people do
 * not expect to get, which makes it the half worth naming.
 */
export function recordLines(inv: ShareInventory): string[] {
  return [
    countLine(inv.pms, "maintenance schedule", "maintenance schedules"),
    countLine(inv.parts, "part on the history", "parts on the history"),
    countLine(inv.refs, "manual and field note", "manuals and field notes"),
    inv.pricingYears > 0
      ? `${inv.pricingYears} year${inv.pricingYears === 1 ? "" : "s"} of what they have been charged`
      : "",
  ].filter(Boolean);
}

export function inventoryLines(inv: ShareInventory): string[] {
  return [
    countLine(inv.systems, "system", "systems"),
    countLine(inv.modules, "module on them", "modules on them"),
    ...recordLines(inv),
  ].filter(Boolean);
}

/**
 * The state an address is in, and nothing finer.
 *
 * "2000 Sample Way, Hayward CA 94544" is a street somebody can drive to and a
 * company somebody can look up. "CA" is enough for a shop to know whether the
 * work is theirs to want. Matched off the ZIP because that is the one part of a
 * US address whose shape is reliable; anything it cannot read comes back blank
 * rather than guessed, and blank is shown as "region not stated".
 */
export function stateOf(address: string): string {
  const line = address.trim().split(/\n/).pop() ?? "";
  const zip = /\b([A-Za-z]{2})[.,]?\s+\d{5}(?:-\d{4})?\s*$/.exec(line);
  if (zip) return zip[1].toUpperCase();
  const bare = /,\s*([A-Za-z]{2})\.?\s*$/.exec(line);
  return bare ? bare[1].toUpperCase() : "";
}

/**
 * The same offer with the client's identity taken out of it.
 *
 * A referral is worth something because the other shop cannot go round you, and
 * the unredacted list hands them everything they need to: the company name, the
 * street, the person to ask for, and serials a manufacturer will match to an
 * owner. So a BLIND offer says what the work IS and never who it is for -
 * enough to decide whether you want it, not enough to take it.
 *
 * What survives: how many systems, of what category and model, at how many
 * sites, in which state, and what somebody already has a contract on. What goes:
 * the client's name, site names, addresses, every contact, every serial, and
 * the asset tags - which look innocuous and are not, because a tag on a photo
 * or a service report identifies the machine and the machine identifies the lab.
 *
 * Applied at the LAST MOMENT, on the way to a screen, never on the way into the
 * database. The full snapshot is what they get when they accept - they cannot
 * service a lab whose address they do not have - so redacting at rest would
 * mean storing the offer twice and one of them being wrong.
 */
export function redactPayload(p: SharePayload): SharePayload {
  const states = [...new Set(p.sites.map((s) => stateOf(s.address)).filter(Boolean))];
  return {
    ...p,
    /*
     * The figures never cross before acceptance. What survives is the SHAPE -
     * how many years there are - because "this account has three years of
     * billing behind it" is the thing worth knowing when deciding whether to
     * take it on, and the rates are the thing worth paying for. Same rule the
     * rest of this function follows: enough to decide, not enough to act.
     */
    pricing: p.pricing
      ? {
        years: p.pricing.years.map((y) => ({ year: y.year, billedCents: 0, visits: 0 })),
        laborRateCents: 0,
        note: "",
      }
      : undefined,
    // A parts history names the machines it went into by the sender's own tag,
    // and those tags are minted per system below - so they are renumbered here
    // for the same reason the systems are.
    parts: (p.parts ?? []).map((x) => ({ ...x, sourceRef: "" })),
    pms: (p.pms ?? []).map((x) => ({ ...x, sourceRef: "" })),
    /*
     * References keep their labels and lose their contents. The line this
     * draws is free prose against structured labels: "Annual PM" and "Pump
     * rebuild" are equipment vocabulary and give nothing away, whereas the
     * BODY of a field note is somebody typing, and somebody typing eventually
     * types the customer's name. The url goes for a second reason - it is a
     * live link to the sender's own material, and a stranger who has agreed to
     * nothing should not be able to fetch it.
     */
    refs: (p.refs ?? []).map((x) => ({ ...x, url: "", body: "" })),
    client: { ...p.client, name: "A client" },
    sites: p.sites.map((_, i) => ({
      name: states.length === 1 ? `Site ${i + 1}, ${states[0]}` : `Site ${i + 1}`,
      address: "", accessNotes: "", contactName: "", contactPhone: "", contactEmail: "",
    })),
    systems: p.systems.map((x, i) => ({
      ...x,
      sourceRef: `System ${i + 1}`,
      siteName: "",
      location: "",
      modules: x.modules.map((m) => ({ ...m, serial: "" })),
    })),
  };
}

/**
 * The shortest string worth matching a note against.
 *
 * Below this it is initials and street numbers, and every offer would trip on
 * a site called "Lab 2" or a contact called "Al". A warning that fires on
 * everything is a warning people learn to click through.
 */
export const MIN_IDENTIFYING = 4;

/**
 * The strings a blind offer takes out, so a note can be checked against them.
 *
 * Not the redacted payload's inverse - a list of the actual identifying VALUES,
 * which is what a covering note would have to contain to give the game away.
 */
export function identifyingBits(p: SharePayload): string[] {
  const bits = [
    p.client.name,
    ...p.sites.flatMap((s) => [
      s.name, s.contactName, s.contactEmail, s.contactPhone,
      // The first line of an address is the door. The rest is town and ZIP,
      // and the state is published anyway.
      s.address.split(/[\n,]/)[0] ?? "",
    ]),
    ...p.systems.flatMap((x) => [x.sourceRef, ...x.modules.map((m) => m.serial)]),
  ];
  return [...new Set(bits.map((b) => b.trim()).filter((b) => b.length >= MIN_IDENTIFYING))];
}

/**
 * What a covering note gives away that the offer itself withholds.
 *
 * THE HOLE THIS CLOSES. Redaction reached the payload and stopped there, and
 * the note travelled beside it untouched - onto the recipient's screen and
 * into the notification email. A sender who ticked nothing (blind is the
 * default wherever there is a fee) and wrote "Emery Pharma want the Alameda
 * GCs covered" was told the name would be held back, and it was not.
 *
 * The note still has to go: it is the reason anybody says yes. So it is
 * checked rather than stripped, and the sender is told which words to change -
 * or can turn blinding off, which is a decision rather than an accident.
 */
export function noteLeaks(note: string, p: SharePayload): string[] {
  const hay = note.toLowerCase();
  return identifyingBits(p).filter((b) => hay.includes(b.toLowerCase()));
}

/** "12 systems across 2 sites in CA" - the headline of a blind offer. */
export function blindSummary(p: SharePayload): string {
  const states = [...new Set(p.sites.map((s) => stateOf(s.address)).filter(Boolean))];
  const where = states.length ? ` in ${states.join(", ")}` : " - region not stated";
  return `${summarize(p)}${where}`;
}

export const SHARE_STATES = ["pending", "countered", "accepted", "declined", "withdrawn"] as const;
export type ShareState = (typeof SHARE_STATES)[number];

export const SHARE_LABEL: Record<ShareState, string> = {
  pending: "Waiting on them",
  countered: "They countered",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/** The same states, from the receiving end - "waiting on them" is us. */
export const SHARE_LABEL_IN: Record<ShareState, string> = {
  pending: "Needs a decision",
  countered: "Waiting on them",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn by the sender",
};

/** Still live - nobody has settled it either way. */
export const isOpen = (status: string): boolean =>
  status === "pending" || status === "countered";

/**
 * Only the recipient decides, and not while their own counter is outstanding.
 *
 * A recipient who could accept the original terms while their counter sat
 * unanswered would be able to take the client at whichever price the sender
 * had not yet replied to. One offer on the table at a time.
 */
export const mayDecide = (status: string): boolean => status === "pending";

/** Only the sender withdraws, and a countered offer is still withdrawable. */
export const mayWithdraw = (status: string): boolean => isOpen(status);

/** The recipient proposes different terms. Only against a live, unanswered offer. */
export const mayCounter = (status: string): boolean => status === "pending";

/** The sender answers a counter. Theirs alone, and only while one is outstanding. */
export const mayAnswerCounter = (status: string): boolean => status === "countered";

/** "12 systems across 2 sites". The line a person decides on. */
export function summarize(p: SharePayload): string {
  const n = p.systems.length;
  const s = p.sites.length;
  if (n === 0) return "No systems";
  const sites = s > 1 ? ` across ${s} sites` : s === 1 ? ` at ${p.sites[0].name || "one site"}` : "";
  return `${n} system${n === 1 ? "" : "s"}${sites}`;
}

/** Everything wrong with an offer. Empty means it can go. */
export function shareProblems(input: {
  payload: SharePayload; toOrgId: number; fromTenantOrgId: number | null;
}): string[] {
  const out: string[] = [];
  if (!input.payload.client.name.trim()) out.push("That client has no name");
  if (input.payload.systems.length === 0) {
    out.push("There are no systems on this client yet - there would be nothing to hand over");
  }
  if (input.fromTenantOrgId === null) {
    out.push("Your workspace could not be resolved, so nothing can be shared out of it");
  }
  if (input.toOrgId === input.fromTenantOrgId) out.push("That is your own workspace");
  return out;
}

/**
 * A tag the destination workspace can actually use.
 *
 * Their equipment carries their labels. The sender's tag is recorded as a
 * cross-reference (instruments.source_ref) and never imposed: copying my
 * "EP-001" onto their shelf is putting my sticker on their machine, and it
 * collides the moment they already have one.
 *
 * Preferred first, because a shop with no clash has no reason to be given an
 * odd number; then the same tag with a short suffix, so a person can still see
 * where it came from.
 */
export function freeTag(preferred: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()));
  const base = preferred.trim() || "SYS";
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 200; i++) {
    const next = `${base}-${i}`;
    if (!used.has(next.toLowerCase())) return next;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

/** Tolerant parse. A payload that has gone bad is refused, never half-applied. */
/** Anything that is not a list is an empty one. Same posture as the rest of the parse. */
const arr = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> =>
    typeof x === "object" && x !== null) : []);

export function parsePayload(raw: string): SharePayload | null {
  if (!raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<SharePayload>;
    if (!v || typeof v !== "object") return null;
    const systems = Array.isArray(v.systems) ? v.systems : [];
    const sites = Array.isArray(v.sites) ? v.sites : [];
    return {
      version: Number(v.version) || SHARE_VERSION,
      client: {
        name: String(v.client?.name ?? "").trim(),
        kind: String(v.client?.kind ?? "client"),
      },
      sites: sites.map((s) => ({
        name: String(s?.name ?? ""), address: String(s?.address ?? ""),
        accessNotes: String(s?.accessNotes ?? ""), contactName: String(s?.contactName ?? ""),
        contactPhone: String(s?.contactPhone ?? ""), contactEmail: String(s?.contactEmail ?? ""),
      })),
      systems: systems.map((x) => ({
        sourceRef: String(x?.sourceRef ?? ""), model: String(x?.model ?? ""),
        category: String(x?.category ?? ""), siteName: String(x?.siteName ?? ""),
        location: String(x?.location ?? ""),
        modules: Array.isArray(x?.modules) ? x.modules.map((m) => ({
          kind: String(m?.kind ?? ""), model: String(m?.model ?? ""),
          serial: String(m?.serial ?? ""), manufacturer: String(m?.manufacturer ?? ""),
        })) : [],
      })),
      /* Bounded on the way in, like every other list here: a payload is a
         string somebody else's database handed us, and the parse is the only
         place that knows how big is too big. */
      pms: arr(v.pms).slice(0, 500).map((x) => ({
        sourceRef: String(x?.sourceRef ?? ""), title: String(x?.title ?? ""),
        // A module position only counts if it is a whole number at or above
        // zero. Anything else is a schedule on the system.
        moduleIndex: Number.isInteger(x?.moduleIndex) && (x.moduleIndex as number) >= 0
          ? (x.moduleIndex as number) : null,
        everyDays: Math.max(0, Math.round(Number(x?.everyDays) || 0)),
        nextDue: String(x?.nextDue ?? ""), lastDone: String(x?.lastDone ?? ""),
      })),
      parts: arr(v.parts).slice(0, 2000).map((x) => ({
        sourceRef: String(x?.sourceRef ?? ""), name: String(x?.name ?? ""),
        partNumber: String(x?.partNumber ?? ""), qty: String(x?.qty ?? ""),
        installedAt: String(x?.installedAt ?? ""),
      })),
      refs: arr(v.refs).slice(0, 500).map((x) => ({
        assetType: String(x?.assetType ?? ""), model: String(x?.model ?? ""),
        kind: String(x?.kind ?? "link"), title: String(x?.title ?? ""),
        url: String(x?.url ?? ""), body: String(x?.body ?? ""),
      })),
      // Absent unless the sender chose to send it - see SharedPricing.
      pricing: v.pricing && Array.isArray(v.pricing.years)
        ? {
          years: v.pricing.years.slice(0, 20).map((y) => ({
            year: String(y?.year ?? ""),
            billedCents: Math.max(0, Math.round(Number(y?.billedCents) || 0)),
            visits: Math.max(0, Math.round(Number(y?.visits) || 0)),
          })),
          laborRateCents: Math.max(0, Math.round(Number(v.pricing.laborRateCents) || 0)),
          note: String(v.pricing.note ?? ""),
        }
        : undefined,
      from: {
        operator: String(v.from?.operator ?? ""), by: String(v.from?.by ?? ""),
        on: String(v.from?.on ?? ""),
      },
      note: String(v.note ?? ""),
    };
  } catch {
    return null;
  }
}

/** The sentence on the copy itself, so nobody wonders later where it came from. */
export function provenanceLine(p: SharePayload): string {
  const who = p.from.operator || "another service company";
  return `Shared by ${who}${p.from.on ? ` on ${p.from.on}` : ""}`
    + `${p.from.by ? ` (${p.from.by})` : ""}. A copy taken then - it does not update.`;
}
