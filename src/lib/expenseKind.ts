// The expense vocabulary, as the database half of lib/expenseCategories.
//
// Shared by the two action modules that log expenses (app/actions and
// app/money/actions) so that a kind is cleaned one way everywhere.

import { asc } from "drizzle-orm";
import { db } from "@/db";
import { expenseCategories } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { EXPENSE_KINDS } from "@/lib/billing";
import { categoryKey } from "@/lib/expenseCategories";

/** This workspace's expense vocabulary, in picker order. */
export async function tenantCategories(tenant: number | null) {
  return db.select().from(expenseCategories)
    .where(forTenant(expenseCategories.tenantOrgId, tenant))
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id));
}

/**
 * A kind fit to store: one of this workspace's own category names, or one of
 * the canonical slugs the app itself writes (the travel strip logs
 * "per_diem"), else "other". Free text never lands in the column - a
 * vocabulary that grows by typo is not a vocabulary.
 */
export async function cleanExpenseKind(kind: string, tenant: number | null): Promise<string> {
  if ((EXPENSE_KINDS as readonly string[]).includes(kind)) return kind;
  const match = (await tenantCategories(tenant)).find((c) => categoryKey(c.name) === categoryKey(kind));
  return match ? match.name : "other";
}
