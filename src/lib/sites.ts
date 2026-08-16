// Where a company is, and where its instruments actually are.
//
// Two different facts, and conflating them is what makes a service business
// print the wrong thing on paper. The billing address is one per company - it is
// where the invoice goes, and a company has one accounts-payable department. The
// lab is not one per company: a client can have three sites, and a system lives
// at exactly one of them.
//
// So the billing address sits on the organization and the sites are their own
// rows, and a system points at the site it is installed in.
//
// The third thing a site carries is the part nobody writes down anywhere and
// everybody needs at 7am: use the parking garage on Cedar, it's $30 a day, dock
// is round the back, ask for Rita. That belongs to the BUILDING, not to the
// customer - on the company it would be noise on the invoice screen, and it
// would be wrong the moment they open a second lab.

/** A postal address as typed, kept as one block of text rather than five fields. */
export type AddressLike = string;

/**
 * One line, for a table row or a chip.
 *
 * Addresses are entered as several lines because that is how people write them.
 * Everywhere they are shown next to something else they have to be one line, and
 * doing that with CSS alone loses the line breaks entirely - "123 Cedar StSuite
 * 4Reno NV" - so the joining happens here where it can put the commas in.
 */
export function addressLine(address: AddressLike): string {
  return address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", ");
}

/** Enough of an address to recognize it, for a picker that also shows a name. */
export function addressHint(address: AddressLike, max = 48): string {
  const line = addressLine(address);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export type SiteLike = {
  id: number;
  orgId: number;
  name: string;
  address: string;
  accessNotes: string;
  archived: boolean;
};

/**
 * What to call a site in a list.
 *
 * The name is what somebody typed ("Building 4 lab", "Reno"); the address is the
 * fallback for a site nobody bothered to name, because "Site 12" helps nobody.
 */
export const siteLabel = (s: Pick<SiteLike, "name" | "address">): string =>
  s.name.trim() || addressHint(s.address) || "Unnamed site";

/**
 * The sites a system may be assigned to.
 *
 * Only the owning organization's, and only live ones - plus whichever site the
 * system is already at, even if that one has since been archived. Dropping the
 * current value out of its own picker is how an unrelated edit silently clears
 * a field, and a closed lab is still where that instrument was.
 */
export function sitesFor<T extends SiteLike>(
  sites: T[], ownerOrgId: number | null, currentSiteId: number | null,
): T[] {
  if (ownerOrgId === null) return sites.filter((s) => s.id === currentSiteId);
  return sites.filter((s) =>
    s.orgId === ownerOrgId && (!s.archived || s.id === currentSiteId));
}

/**
 * Everything a tech needs before driving there, in the order they need it.
 *
 * Returns null when there is nothing to say, so a caller can leave the block out
 * entirely rather than rendering an empty heading - which is the commonest way a
 * page ends up looking broken to somebody whose data is simply not filled in.
 */
export function visitBrief(site: Pick<SiteLike, "name" | "address" | "accessNotes"> | null): string | null {
  if (!site) return null;
  const bits = [site.name.trim(), addressLine(site.address), site.accessNotes.trim()].filter(Boolean);
  return bits.length ? bits.join("\n") : null;
}
