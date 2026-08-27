import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { forTenant, tenantOfOrg } from "@/lib/tenancy";
import { instruments, sheetDiffs, appSettings, systemShares } from "@/db/schema";
import { audit } from "@/lib/audit";
import { STAGES, SHEET_STAGES } from "@/lib/stages";


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
 * Fetch the tracker rows via the Google Sheets API using a service account.
 * The sheet stays private; the client just shares it (Viewer) with the
 * service account's email. Falls back to SHEET_CSV_URL if the service
 * account env vars aren't set.
 */
function sheetsJwt() {
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const saKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.SHEET_ID;
  if (!saEmail || !saKey || !sheetId) return null;
  return { saEmail, saKey, sheetId };
}

async function makeJwtClient(saEmail: string, saKey: string) {
  const { JWT } = await import("google-auth-library");
  return new JWT({
    email: saEmail,
    // Vercel env vars store the key with literal \n sequences; restore them.
    key: saKey.replace(/\\n/g, "\n"),
    // Write scope (includes read) - the write-back feature updates cells.
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const sheetRange = () => process.env.SHEET_RANGE || "'Refurbishment Tracker'!A:H";

async function fetchSheetRows(): Promise<string[][]> {
  const sa = sheetsJwt();
  if (sa) {
    const jwt = await makeJwtClient(sa.saEmail, sa.saKey);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sa.sheetId}/values/${encodeURIComponent(sheetRange())}`;
    const res = await jwt.request<{ values?: string[][] }>({ url });
    return res.data.values ?? [];
  }

  // Fallback: published-CSV mode.
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    throw new Error(
      "Sheet access not configured: set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY + SHEET_ID, or SHEET_CSV_URL"
    );
  }
  const res = await fetch(csvUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  return parseCsv(await res.text());
}

/** Fetch + parse the tracker in one call - used by resolveDiff to import a missing row. */
export async function fetchTrackerRows(): Promise<SheetRow[]> {
  return parseTrackerRows(await fetchSheetRows());
}

/**
 * Locate the cell for a diff field on a system's row. Pure so it's testable:
 * rows are the raw sheet values (header first), field is a diff field name.
 */
export function locateSheetCell(rows: string[][], externalId: string, field: string): { rowIndex: number; colIndex: number } | null {
  if (!rows.length) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.includes(name));
  const fieldCol: Record<string, number> = {
    Priority: col("priority"),
    Notes: col("notes"),
    Stage: col("process"),
  };
  const colIndex = fieldCol[field] ?? -1;
  const idCol = col("id");
  if (colIndex < 0 || idCol < 0) return null;
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[idCol] || "").trim() === externalId);
  if (rowIndex < 0) return null;
  return { rowIndex, colIndex };
}

export type PushableInstrument = {
  externalId: string; client: string; model: string; priority: number; stages: string[]; notes: string;
};

/**
 * Lay an instrument out across the sheet's own column order, so a new row
 * lands in the right columns whatever their arrangement. Pure/testable.
 * Returns null when the sheet has no recognizable ID column.
 */
export function buildSheetRow(header: string[], inst: PushableInstrument): string[] | null {
  const h = header.map((x) => x.trim().toLowerCase());
  const col = (name: string) => h.findIndex((x) => x.includes(name));
  const idCol = col("id");
  if (idCol < 0) return null;
  const row: string[] = new Array(Math.max(header.length, idCol + 1)).fill("");
  const set = (i: number, v: string) => { if (i >= 0) row[i] = v; };
  set(idCol, inst.externalId);
  set(col("location"), inst.client);
  set(col("equipment"), inst.model);
  set(col("priority"), String(inst.priority));
  // Only stages the sheet's vocabulary can express - internal-only and custom stages stay ours.
  set(col("process"), inst.stages.filter((s) => (SHEET_STAGES as readonly string[]).includes(s)).join(", "));
  set(col("notes"), inst.notes);
  return row;
}

/**
 * Append a system to the client's sheet as a new row. Requires the service
 * account to have Editor access. Refuses when the ID is already on the sheet,
 * so it's safe to retry.
 */
export async function appendInstrumentToSheet(inst: PushableInstrument): Promise<void> {
  const sa = sheetsJwt();
  if (!sa) throw new Error("Adding rows needs the service account (GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY/SHEET_ID); the CSV fallback is read-only");
  const rows = await fetchSheetRows();
  if (!rows.length) throw new Error("The sheet looks empty - check SHEET_RANGE");
  const header = rows[0];
  const idCol = header.map((x) => x.trim().toLowerCase()).findIndex((x) => x.includes("id"));
  if (idCol < 0) throw new Error("Could not find an ID column in the sheet header");
  if (rows.some((r, i) => i > 0 && (r[idCol] || "").trim() === inst.externalId)) {
    throw new Error(`${inst.externalId} is already on the sheet`);
  }
  const row = buildSheetRow(header, inst);
  if (!row) throw new Error("Could not map the system onto the sheet's columns");
  const jwt = await makeJwtClient(sa.saEmail, sa.saKey);
  await jwt.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sa.sheetId}/values/${encodeURIComponent(sheetRange())}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    method: "POST",
    data: { values: [row] },
  });
}

/** 0-based column index -> A1 letters (0 -> A, 26 -> AA). */
function colLetter(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/**
 * Write one of our values into the client's sheet. Requires the service
 * account to have Editor access on the sheet. The documented SHEET_RANGE
 * starts at A1, so row/col indexes map directly to A1 notation.
 */
export async function pushValueToSheet(externalId: string, field: string, value: string): Promise<void> {
  const sa = sheetsJwt();
  if (!sa) throw new Error("Sheet write-back needs the service account (GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY/SHEET_ID); the CSV fallback is read-only");
  const rows = await fetchSheetRows();
  const cell = locateSheetCell(rows, externalId, field);
  if (!cell) throw new Error(`Could not find ${field} cell for ${externalId} in the sheet`);
  const sheetName = sheetRange().split("!")[0];
  const a1 = `${sheetName}!${colLetter(cell.colIndex)}${cell.rowIndex + 1}`;
  const jwt = await makeJwtClient(sa.saEmail, sa.saKey);
  await jwt.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sa.sheetId}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`,
    method: "PUT",
    data: { range: a1, values: [[value]] },
  });
}

/**
 * Diff the sheet against the DB and insert diff rows for anything that
 * doesn't match. Never writes to instrument data itself - humans resolve
 * diffs in the parity view.
 */
export async function runSheetSync(): Promise<{ checked: number; diffs: number; updated: number; skipped: number; cleared: number }> {
  const sheetRows = parseTrackerRows(await fetchSheetRows());

  // One sheet belongs to one organization; comparing every system against it
   // would report another client's systems as "missing from the sheet".
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  const sheetOrgId = settings?.sheetOrgId ?? null;
  const sharedIds = sheetOrgId === null ? null : new Set(
    (await db.select({ instrumentId: systemShares.instrumentId }).from(systemShares)
      .where(eq(systemShares.orgId, sheetOrgId))).map((r) => r.instrumentId)
  );
  // The workspace that owns the SHEET. app_settings already records which
  // organization it belongs to (sheetOrgId, read above), so its tenant is the
  // right scope - and unlike operator_org_id it keeps meaning the same thing
  // once the company running the instance is not also the one servicing these
  // systems. Comparing another workspace's fleet against this sheet reports
  // every one of their systems as "missing from the sheet" and prints their
  // external ids into a diff list that is not theirs.
  const sheetTenant = await tenantOfOrg(sheetOrgId);
  const allRows = await db.select().from(instruments)
    .where(forTenant(instruments.tenantOrgId, sheetTenant));
  const dbRows = sharedIds === null ? allRows : allRows.filter((r) => sharedIds.has(r.id));
  const byId = new Map(dbRows.map((r) => [r.externalId, r]));

  // Memory of prior runs: at most one open diff per (system, field), and the
  // most recent resolved decision. A resolved diff suppresses re-flagging for
  // as long as the sheet still says the same thing - Joe already ruled on it.
  const existing = await db.select().from(sheetDiffs).orderBy(asc(sheetDiffs.id));
  const key = (externalId: string, field: string) => `${externalId}|${field}`;
  const open = new Map<string, typeof existing[number]>();
  const lastResolved = new Map<string, typeof existing[number]>();
  for (const d of existing) {
    if (d.resolved) lastResolved.set(key(d.externalId, d.field), d);
    else open.set(key(d.externalId, d.field), d);
  }

  let diffCount = 0, updated = 0, skipped = 0, cleared = 0;
  const flaggedKeys = new Set<string>();

  const record = async (externalId: string, field: string, sheetValue: string, dbValue: string) => {
    const k = key(externalId, field);
    flaggedKeys.add(k);
    const o = open.get(k);
    if (o) {
      if (o.sheetValue === sheetValue && o.dbValue === dbValue) { skipped++; return; } // already flagged as-is
      await db.update(sheetDiffs).set({ sheetValue, dbValue, runAt: new Date() }).where(eq(sheetDiffs.id, o.id));
      updated++;
      return;
    }
    const r = lastResolved.get(k);
    if (r && r.sheetValue === sheetValue) { skipped++; return; } // same sheet value we already ruled on
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
    const dbStages = (d.stages || []).join(", ");
    // Stage comparison covers only stages the sheet can express - internal-only
    // built-ins and custom stages added in Settings never generate diffs.
    const dbComparable = (d.stages || []).filter((x) => (SHEET_STAGES as readonly string[]).includes(x)).join(", ");
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
    if (d.archived) continue;                           // archived systems are off the active fleet
    if ((d.stages || []).includes("Shipped")) continue; // shipped systems fall off the sheet, that's fine
    await record(externalId, "Row", "(missing from sheet)", `${d.model} (${d.client})`);
  }

  // Mismatches that disappeared (sheet edited to match us, or we accepted the
  // sheet value) leave a stale open diff behind - close it out.
  for (const [k, o] of open) {
    if (flaggedKeys.has(k)) continue;
    await db.update(sheetDiffs)
      .set({ resolved: true, resolvedBy: "sheet-sync", resolution: "auto_cleared" })
      .where(eq(sheetDiffs.id, o.id));
    cleared++;
  }

  await audit({
    actor: "sheet-sync",
    entityType: "sheet_sync",
    action: `poll complete: ${sheetRows.length} sheet rows checked, ${diffCount} new diffs, ${updated} refreshed, ${skipped} already known, ${cleared} auto-cleared`,
  });
  return { checked: sheetRows.length, diffs: diffCount, updated, skipped, cleared };
}
