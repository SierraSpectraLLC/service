// The chain that makes a history hard to edit quietly.
//
// A service record is worth what it can be trusted for. Anybody can type a PM
// into any system; what a buyer needs is evidence that the line was written
// when it says it was and has not been rewritten since. Each event carries the
// hash of the one before it, so changing a single date somewhere in 2027
// invalidates every hash after it - which is not proof of honesty, but it does
// turn a quiet edit into a visible one, and that is the whole ask.
//
// ONLY PROVENANCE-SIDE FIELDS ARE HASHED. `private` is excluded on purpose: it
// is the half that gets withheld, redacted and eventually revoked, and a chain
// that broke when a shop redacted a customer's site address would force a
// choice between an honest record and a verifiable one. Grades are excluded for
// the same reason - Phase 6's countersign upgrades a grade on an event years
// after the fact, and the chain must survive it.

import { createHash } from "node:crypto";
import type { ProcedureKeyEntry } from "@/lib/custody/types";

/**
 * The hashable half of an event. Anything not in here can change without
 * breaking the chain, which is a promise, not an oversight.
 */
export type HashInput = {
  kind: string;
  occurredAt: Date;
  authorOrgId: number | null;
  procedureKeys: ProcedureKeyEntry[];
  provenance: Record<string, unknown>;
};

/**
 * JSON with every object's keys sorted and no whitespace.
 *
 * Two servers must produce the same bytes for the same event, and V8's object
 * key order is insertion order - so a row read back from Postgres with columns
 * in a different order than the one that wrote it would hash differently and
 * break a chain nobody touched. Dates go out as ISO strings; undefined is
 * dropped the way JSON.stringify drops it, so an optional field left unset and
 * one never mentioned are the same event.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value);
}

/** '' is the genesis link, never null: a NULL does not collide in a unique index. */
export const GENESIS = "";

export function eventHash(prevHash: string, input: HashInput): string {
  const body = canonical({
    prev: prevHash,
    kind: input.kind,
    occurredAt: input.occurredAt,
    authorOrgId: input.authorOrgId,
    procedureKeys: input.procedureKeys,
    provenance: input.provenance,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export const hashOfEvent = (
  prevHash: string,
  e: Pick<ChainLink, "kind" | "occurredAt" | "authorOrgId" | "procedureKeys" | "provenance">,
): string =>
  eventHash(prevHash, {
    kind: e.kind, occurredAt: e.occurredAt, authorOrgId: e.authorOrgId,
    procedureKeys: e.procedureKeys, provenance: e.provenance,
  });

/**
 * A link as it comes back OUT of the database, where `kind` is text and the
 * jsonb columns are unknown. Deliberately looser than SystemEvent: a chain has
 * to be verifiable even when it carries a kind this build has never heard of,
 * which is exactly the row somebody would use to smuggle an edit past a
 * verifier that refused to parse it.
 */
export type ChainLink = {
  id: number;
  kind: string;
  occurredAt: Date;
  authorOrgId: number | null;
  procedureKeys: ProcedureKeyEntry[];
  provenance: Record<string, unknown>;
  prevHash: string | null;
  hash: string | null;
};

/**
 * Re-walk a chain and say where it first stops adding up.
 *
 * Names the FIRST bad link rather than counting them: everything after a broken
 * link is broken by arithmetic, so a count would report one edit as forty and
 * bury the one row somebody should look at.
 */
export function verifyChain(events: ChainLink[]): { ok: true } | { ok: false; at: number; why: string } {
  let prev = GENESIS;
  for (const e of events) {
    if ((e.prevHash ?? GENESIS) !== prev) {
      return { ok: false, at: e.id, why: `expected prevHash ${prev || "(genesis)"}, found ${e.prevHash || "(genesis)"}` };
    }
    const want = hashOfEvent(prev, e);
    if (e.hash !== want) return { ok: false, at: e.id, why: "content does not match its hash" };
    prev = want;
  }
  return { ok: true };
}
