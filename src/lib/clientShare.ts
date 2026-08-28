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
export type SharePayload = {
  version: number;
  client: { name: string; kind: string };
  sites: SharedSite[];
  systems: SharedSystem[];
  /** Who sent it and when, frozen into the copy itself. */
  from: { operator: string; by: string; on: string };
  note: string;
};

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
