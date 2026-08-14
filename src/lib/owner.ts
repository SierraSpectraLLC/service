// Who owns a machine, said once.
//
// Every system and unit carries ownership twice. There is a LINK - instruments
// .owner_org_id / assets.owner_org_id - which is the load-bearing one: it decides
// who can see the record, who sees its costs, and whose storage quota its files
// count against. And there is a NAME - instruments.client / assets.owner - which
// is what the registry column, the CSV export, the sign-off packet and the
// listing all print.
//
// The name predates organizations. When orgs arrived the link was added beside
// it and both were left editable, in two different places on the same page: a
// free-text box in the edit form and a dropdown in the ownership section. So a
// unit could say "LabZen" in one and "Unassigned" in the other, and be telling
// the truth twice - the label said LabZen and LabZen genuinely could not see it.
//
// One control now. The link is chosen; the name follows from it and cannot
// disagree. Free text survives for the case that is actually free text: a
// company that is not on the platform at all, which is a name and nothing else.

export type OrgLite = { id: number; name: string };

export type Ownership = {
  /** The organization that owns it, or null for nobody on the platform. */
  orgId: number | null;
  /** What to print. The org's name when there is one, else whatever was typed. */
  name: string;
};

/**
 * The two columns, from one choice.
 *
 * An organization's own name always wins - that is what makes the pair unable to
 * drift. Picking an org that does not exist resolves to unowned rather than to a
 * dangling id: a link to nothing grants nothing, and should not claim to.
 */
export function ownerFields(orgId: number | null, typed: string, orgs: OrgLite[]): Ownership {
  const name = typed.trim().slice(0, 120);
  if (orgId === null) return { orgId: null, name };
  const org = orgs.find((o) => o.id === orgId);
  return org ? { orgId: org.id, name: org.name } : { orgId: null, name };
}

/** What a record says about its owner, for a page that only reads. */
export const ownerLabel = (o: Ownership): string => o.name || "Unassigned";

/**
 * Do the stored two disagree, and what should the name have been?
 *
 * Returns "" when they agree or when there is nothing to compare. Every row
 * written before there was one control can be checked with this, which is how
 * the ones that already drifted get found rather than waited for.
 */
export function ownerMismatch(orgId: number | null, name: string, orgs: OrgLite[]): string {
  if (orgId === null) return "";
  const org = orgs.find((o) => o.id === orgId);
  if (!org) return "";
  return org.name.trim().toLowerCase() === name.trim().toLowerCase() ? "" : org.name;
}

/**
 * An organization whose name is exactly what somebody typed, if there is one.
 *
 * Deliberately NOT applied automatically. Linking a record to an organization
 * grants that organization sight of it, and a permissions change made by a
 * string comparison is a permissions change nobody decided. This exists so the
 * page can offer the link as one click, with the consequence named.
 */
export function orgNamed(typed: string, orgs: OrgLite[]): OrgLite | null {
  const n = typed.trim().toLowerCase();
  if (!n) return null;
  return orgs.find((o) => o.name.trim().toLowerCase() === n) ?? null;
}
