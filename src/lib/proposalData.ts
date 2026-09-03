// Reading a proposal: the document's rows, in one place.
//
// The split every other module here follows - pure rules in lib/proposal,
// fetching here - so the builder page, the print view and the actions all load
// the same shape and the assembler never learns what a database is.

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { proposals, proposalSections, proposalSystems, proposalTiers } from "@/db/schema";
import type { Section, SystemRow, Tier } from "@/lib/proposal";

export type FullProposal = {
  row: typeof proposals.$inferSelect;
  systems: (typeof proposalSystems.$inferSelect)[];
  tiers: (typeof proposalTiers.$inferSelect)[];
  sections: (typeof proposalSections.$inferSelect)[];
};

async function hydrate(row: typeof proposals.$inferSelect | undefined): Promise<FullProposal | null> {
  if (!row) return null;
  const [systems, tiers, sections] = await Promise.all([
    db.select().from(proposalSystems).where(eq(proposalSystems.proposalId, row.id))
      .orderBy(asc(proposalSystems.position), asc(proposalSystems.id)),
    db.select().from(proposalTiers).where(eq(proposalTiers.proposalId, row.id))
      .orderBy(asc(proposalTiers.position), asc(proposalTiers.id)),
    db.select().from(proposalSections).where(eq(proposalSections.proposalId, row.id))
      .orderBy(asc(proposalSections.position), asc(proposalSections.id)),
  ]);
  return { row, systems, tiers, sections };
}

/** The proposal for one quote, or null where nobody has written one. */
export async function proposalForQuote(quoteId: number): Promise<FullProposal | null> {
  const [row] = await db.select().from(proposals).where(eq(proposals.quoteId, quoteId));
  return hydrate(row);
}

export async function proposalById(id: number): Promise<FullProposal | null> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
  return hydrate(row);
}

/** The rows as lib/proposal wants them - stored shape in, document shape out. */
export const systemRows = (f: FullProposal): SystemRow[] =>
  f.systems.map((s) => ({ name: s.name, model: s.model, note: s.note }));

export const tierRows = (f: FullProposal): Tier[] =>
  f.tiers.map((t) => ({
    key: t.key, name: t.name, annualCents: t.annualCents, bestFor: t.bestFor,
    includes: t.includes, notIncluded: t.notIncluded, features: t.features,
  }));

export const sectionRows = (f: FullProposal): Section[] =>
  f.sections.map((s) => ({ kind: s.kind, heading: s.heading, body: s.body }));
