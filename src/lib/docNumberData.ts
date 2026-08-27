// The one place a document number is minted.
//
// lib/docNumber holds the rules and knows nothing about a database; this
// fetches the two things they need - the workspace's scheme, and the numbers
// already in use - and is the only door the actions call. Before it, twelve
// places built a number, four of them with the prefix hardcoded in the
// expression, and the invoice prefix was a single instance-wide setting that
// every tenant on the instance shared.

import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invoices, orgs, purchaseOrders, quotes, workOrders } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import {
  DEFAULT_SCHEME, DOC_KINDS, jobScoped, nextJob, nextNumber, parse, parseScheme,
  type DocKind, type Scheme,
} from "@/lib/docNumber";

/**
 * A workspace's numbering scheme.
 *
 * cache() because a render that raises one invoice reads this once, and a page
 * that lists a hundred reads it once too. Never throws: a workspace whose
 * column has not been migrated yet numbers documents the way it always did
 * rather than failing to name one.
 */
export const schemeFor = cache(async (tenantOrgId: number | null): Promise<Scheme> => {
  if (tenantOrgId === null) return DEFAULT_SCHEME;
  try {
    const [row] = await db.select({ docScheme: orgs.docScheme })
      .from(orgs).where(eq(orgs.id, tenantOrgId));
    return parseScheme(row?.docScheme ?? "");
  } catch {
    return DEFAULT_SCHEME;
  }
});

/**
 * Every number already used for one kind.
 *
 * Per workspace, EXCEPT purchase orders: po_number_unique is a constraint over
 * the whole table rather than per tenant, so scanning one workspace would let
 * two of them climb their own series independently until they met - and the
 * meeting is an unhandled constraint violation on somebody's screen. The scan
 * reveals only the highest number in use, never a row. Making the constraint
 * per-tenant is the real fix and is a migration, not a predicate.
 */
async function used(kind: DocKind, tenantOrgId: number | null): Promise<string[]> {
  if (kind === "purchase_order") {
    // Deliberately naked, and written as a naked read rather than as
    // forTenant(col, null) so that tests/tenantReadScoping can SEE it. A null
    // scope emits no predicate but leaves a .where() on the page, which the
    // static guard reads as scoped - the exception would go quiet instead of
    // staying on the allowlist with its reason attached.
    const rows = await db.select({ number: purchaseOrders.number }).from(purchaseOrders);
    return rows.map((r) => r.number);
  }
  const scope = tenantOrgId;
  const rows = kind === "invoice"
    ? await db.select({ number: invoices.number }).from(invoices)
        .where(forTenant(invoices.tenantOrgId, scope))
    : kind === "quote"
      ? await db.select({ number: quotes.number }).from(quotes)
          .where(forTenant(quotes.tenantOrgId, scope))
      : await db.select({ number: workOrders.number }).from(workOrders)
          .where(forTenant(workOrders.tenantOrgId, scope));
  return rows.map((r) => r.number);
}

/**
 * The next number for a document about to be created.
 *
 * `job` is how a document joins an existing thread: an invoice raised against
 * work order 030212 passes 030212 and becomes 030212_INV1. Pass null - or
 * nothing - and a job-scoped scheme allocates a NEW job, which is right for a
 * quote nobody has opened a job for yet and for the work order that starts one.
 *
 * On a scheme with no job thread the argument is ignored entirely, so no
 * caller has to know which shape the workspace uses.
 */
export async function nextDocNumber(
  kind: DocKind,
  tenantOrgId: number | null,
  opts: { job?: number | null } = {},
): Promise<string> {
  const scheme = await schemeFor(tenantOrgId);
  const template = scheme.templates[kind];
  const inUse = await used(kind, tenantOrgId);
  if (!jobScoped(template)) return nextNumber(template, inUse);

  const job = opts.job ?? await allocateJob(scheme, tenantOrgId);
  return nextNumber(template, inUse, { job });
}

/**
 * The next job number, read off every job-scoped document in the workspace.
 *
 * Every kind, not just the one being created: the thread is shared, so a job
 * whose only paper so far is a quote must not be handed out again to a work
 * order. That is also why this is not a stored counter - the documents are the
 * record, and a counter is one more thing to be wrong after a restore.
 */
export async function allocateJob(scheme: Scheme, tenantOrgId: number | null): Promise<number> {
  const lists: Partial<Record<DocKind, string[]>> = {};
  for (const kind of DOC_KINDS) {
    if (jobScoped(scheme.templates[kind])) lists[kind] = await used(kind, tenantOrgId);
  }
  return nextJob(scheme, lists);
}

/**
 * The job a source document belongs to, so a derived one joins its thread.
 *
 * Returns null on a scheme with no thread, and null for a number that was
 * typed by hand into some other shape - in which case the derived document
 * starts a thread of its own rather than inventing one from a partial match.
 */
export async function jobFrom(
  kind: DocKind, number: string, tenantOrgId: number | null,
): Promise<number | null> {
  const scheme = await schemeFor(tenantOrgId);
  const template = scheme.templates[kind];
  if (!jobScoped(template)) return null;
  return parse(template, number)?.job ?? null;
}
