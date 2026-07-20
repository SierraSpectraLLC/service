import { db } from "@/db";
import { instruments, sheetDiffs } from "@/db/schema";
import { audit } from "@/lib/audit";
import { STAGES } from "@/lib/stages";

/**
 * Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/newlines).
 * The client's sheet is small; no need for a dependency.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((c) => c.trim() !== "")) rows.push(row); }
  return rows;
}

/** Map the sheet's comma-listed "System Process" onto our stage vocabulary. */
export function normalizeStages(processCell: string): string[] {
  const found: string[] = [];
  const lc = processCell.toLowerCase();
  const aliases: Record<string, string> = {
    intake: "Intake",
    refurbishment: "Refurbishment",
    "system setup": "System setup",
    checkout: "Checkout",
    applications: "Applications",
    "sign off": "Sign-off",
    "sign-off": "Sign-off",
    shipped: "Shipped",
  };
  for (const [alias, stage] of Object.entries(aliases)) {
    if (lc.includes(alias) && !found.includes(stage)) found.push(stage);
  }
  // Keep only known stages, in canonical order.
  return STAGES.filter((s) => found.includes(s));
}

type SheetRow = { externalId: string; client: string; model: string; priority: number; stages: string[]; notes: string };

/** Parse the "Refurbishment Tracker" tab shape into normalized rows. */
export function parseTrackerRows(rows: string[][]): SheetRow[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.includes(name));
  const iPriority = col("priority");
  const iClient = col("location");
  const iId = col("id");
  const iModel = col("equipment");
  const iProcess = col("process");
  const iNotes = col("notes");
  const out: SheetRow[] = [];
  for (const r of rows.slice(1)) {
    const externalId = (r[iId] || "").trim();
    if (!externalId) continue;
    out.push({
      externalId,
      client: (r[iClient] || "").replace(/^_/, "").trim(),
      model: (r[iModel] || "").trim(),
      priority: Math.round(parseFloat(r[iPriority] || "99")) || 99,
      stages: normalizeStages(r[iProcess] || ""),
      notes: (r[iNotes] || "").trim(),
    });
  }
  return out;
}

/**
 * Fetch the published CSV, diff against the DB, and insert diff rows for
 * anything that doesn't match. Never writes to instrument data itself -
 * humans resolve diffs in the parity view.
 */
export async function runSheetSync(): Promise<{ checked: number; diffs: number }> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) throw new Error("SHEET_CSV_URL is not set");
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  const sheetRows = parseTrackerRows(parseCsv(csv));

  const dbRows = await db.select().from(instruments);
  const byId = new Map(dbRows.map((r) => [r.externalId, r]));
  let diffCount = 0;

  const record = async (externalId: string, field: string, sheetValue: string, dbValue: string) => {
    await db.insert(sheetDiffs).values({ externalId, field, sheetValue, dbValue });
    diffCount++;
  };

  for (const s of sheetRows) {
    const d = byId.get(s.externalId);
    if (!d) {
      await record(s.externalId, "Row", `${s.model} (${s.client})`, "(missing from our records)");
      continue;
    }
    byId.delete(s.externalId);
    const sheetStages = s.stages.join(", ");
    const dbStages = (d.stages || []).filter((x) => s.stages.includes(x) || true).join(", ");
    // Stage comparison ignores our extra internal-only stages the sheet can't express.
    const dbComparable = (d.stages || []).filter((x) => !["Waiting / blocked", "Waiting to ship"].includes(x)).join(", ");
    if (sheetStages && sheetStages !== dbComparable) {
      await record(s.externalId, "Stage", sheetStages, dbStages);
    }
    if (s.notes && s.notes !== d.notes) {
      await record(s.externalId, "Notes", s.notes, d.notes);
    }
    if (s.priority !== d.priority) {
      await record(s.externalId, "Priority", String(s.priority), String(d.priority));
    }
  }
  // Instruments we track that the sheet dropped (the original sin).
  for (const [externalId, d] of byId) {
    if ((d.stages || []).includes("Shipped")) continue; // shipped systems fall off the sheet, that's fine
    await record(externalId, "Row", "(missing from sheet)", `${d.model} (${d.client})`);
  }

  await audit({
    actor: "sheet-sync",
    entityType: "sheet_sync",
    action: `poll complete: ${sheetRows.length} sheet rows checked, ${diffCount} diffs recorded`,
  });
  return { checked: sheetRows.length, diffs: diffCount };
}
