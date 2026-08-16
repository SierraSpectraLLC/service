// Which names the Client picker offers.
//
// The bug this exists to fix: the picker was built from the distinct `client`
// strings already typed onto systems, and from nothing else. So an organization
// created as a client did not appear in it until somebody typed its name onto a
// system by hand - and a typo while doing that created a second "client" that
// was not an organization at all, just a different string. The list on screen
// and the list of companies in the workspace drifted apart from day one.
//
// The organizations are the record. The strings in use are history, and they
// stay on the list, because dropping them would silently orphan every system
// labelled with a company that predates the orgs table or was never created as
// one. So: both, merged, with the organization's spelling winning where the two
// disagree about capitals - "GMI" and "gmi" are one company and the one with a
// record is the one spelled right.

/**
 * The picker's options, alphabetical and case-blind-deduplicated.
 *
 * `orgNames` are organizations tagged as clients that this viewer may see.
 * `inUse` are the `client` values already on their systems. First spelling wins
 * within each list; between lists, the organization does.
 */
export function clientOptions(orgNames: string[], inUse: string[]): string[] {
  const out = new Map<string, string>();
  for (const name of [...orgNames, ...inUse]) {
    const n = name.trim();
    if (!n) continue;
    const key = n.toLowerCase();
    if (!out.has(key)) out.set(key, n);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// Resolving one of these names back to an organization is lib/owner's
// orgNamed() - the same case-blind name match the Owner control already uses,
// and deliberately not a second copy of it here.
