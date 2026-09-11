// The systems registry: every system on record, as a flat list. Pure - the
// page queries, this decides what a row IS and which rows a filter keeps, so
// the rules can be pinned as a table.
//
// This is the RECORD, deliberately not the working fleet. The board, the
// metrics and the maintenance calendar hold a prospect's and a former
// client's machines back (lib/fleetHold), because those rooms answer "what is
// the shop looking after this week". A registry answers "what do we know of",
// and the honest answer includes the machines we quoted and the ones we used
// to look after - marked as such, so nobody mistakes a prospect's LC-MS for a
// job.
import { stageOf } from "@/lib/orgStage";

export type SystemState = "active" | "prospect" | "former" | "archived";

/** The facets, in the order the strip shows them. */
export const SYSTEM_STATES: { key: SystemState; label: string }[] = [
  { key: "active", label: "In the fleet" },
  { key: "prospect", label: "Prospect" },
  { key: "former", label: "Former client" },
  { key: "archived", label: "Archived" },
];

/**
 * Where a system stands: archived first, because an archived system is
 * archived whoever owns it; then by its owner's stage. A system nobody owns
 * is the shop's own and is in the fleet.
 */
export function systemState(row: { archived: boolean }, ownerStage: unknown): SystemState {
  if (row.archived) return "archived";
  const s = stageOf(ownerStage);
  return s === "client" ? "active" : s;
}

export type RegistryRow = {
  externalId: string; label: string; client: string; model: string; serial: string;
  location: string; lead: string; category: string; state: SystemState;
};

/**
 * Which rows a reading keeps. No state named means everything on record but
 * the archive - what a person means by "all systems" is the machines that
 * still exist to them, and the archive is its own facet a click away. The
 * search is one needle over every word a person might remember a system by.
 */
export function filterSystems<T extends RegistryRow>(rows: T[], f: { q?: string; state?: string }): T[] {
  const needle = (f.q ?? "").trim().toLowerCase();
  const state = f.state ?? "";
  return rows.filter((r) => {
    if (state ? r.state !== state : r.state === "archived") return false;
    if (!needle) return true;
    return [r.externalId, r.label, r.client, r.model, r.serial, r.location, r.lead, r.category]
      .join(" ").toLowerCase().includes(needle);
  });
}
