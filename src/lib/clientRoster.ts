// Who the shop works for, as a list an engineer reads.
//
// Kept pure so the shaping and the searching are testable without a database -
// same posture as lib/stock. The queries live in app/clients/page.tsx; what is
// here is which facts make a row and what a search matches.
//
// Deliberately NOT the same question as Settings > Clients & orgs. That room is
// configuration - who may sign in, what has been shared with them, where their
// reports go - and it is the owner's. This is the roster: who they are and what
// of theirs we look after, which is what somebody asks before driving out to a
// site. Different columns, different readers; the one thing they share is the
// verb, and both call the same addOrg.

/** An organization, as the orgs table holds it. */
export type RosterOrg = { id: number; name: string; kind: string; themeColor: string };

/** What we look after for one of them. */
export type RosterCounts = {
  /** Systems whose owner is this organization. */
  systems: number;
  /** Their buildings - where an engineer actually drives. */
  sites: number;
  /** Work orders still going: open, active or waiting. */
  openWork: number;
};

export type ClientRow = RosterOrg & RosterCounts;

/**
 * The roster, counted.
 *
 * Counts come in as flat id lists rather than as maps because that is the shape
 * a `select` gives back, and building the map here means the page cannot build
 * a different one.
 */
export function clientRoster(
  orgs: RosterOrg[],
  systems: { ownerOrgId: number | null }[],
  sites: { orgId: number }[],
  openWork: { orgId: number | null }[],
): ClientRow[] {
  const tally = (rows: { orgId?: number | null; ownerOrgId?: number | null }[], key: "orgId" | "ownerOrgId") => {
    const out = new Map<number, number>();
    for (const r of rows) {
      const id = r[key];
      if (typeof id !== "number") continue;
      out.set(id, (out.get(id) ?? 0) + 1);
    }
    return out;
  };
  const bySystem = tally(systems, "ownerOrgId");
  const bySite = tally(sites, "orgId");
  const byWork = tally(openWork, "orgId");
  return orgs.map((o) => ({
    ...o,
    systems: bySystem.get(o.id) ?? 0,
    sites: bySite.get(o.id) ?? 0,
    openWork: byWork.get(o.id) ?? 0,
  }));
}

/**
 * The list as one reader asked for it: this kind, matching this text.
 *
 * An empty kind means every kind rather than none - a facet nobody has picked
 * is not a filter that matches nothing, which is the bug every filtered list
 * gets exactly once.
 */
export function filterRoster(rows: ClientRow[], opts: { q?: string; kind?: string }): ClientRow[] {
  const needle = (opts.q ?? "").trim().toLowerCase();
  const kind = (opts.kind ?? "").trim();
  return rows.filter((r) =>
    (!kind || r.kind === kind) && (!needle || r.name.toLowerCase().includes(needle)));
}

/**
 * What a client row says about itself in one line.
 *
 * Written here rather than in the component so the empty case is decided once:
 * a client with nothing of ours yet reads as exactly that, instead of as
 * "0 systems · 0 sites · 0 open" - three zeros nobody needs to parse to learn
 * that the answer is nothing.
 */
export function rosterSummary(row: RosterCounts): string {
  const bits = [
    row.systems ? `${row.systems} system${row.systems === 1 ? "" : "s"}` : "",
    row.sites ? `${row.sites} site${row.sites === 1 ? "" : "s"}` : "",
    row.openWork ? `${row.openWork} open` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "nothing of ours yet";
}
