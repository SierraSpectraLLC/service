/**
 * The platform's vocabulary for pieces of work. Idempotent - safe to re-run,
 * and re-running is how a new type reaches an instance:
 *   DATABASE_URL=... npx tsx scripts/seed-procedure-types.ts
 *
 * Labels are updated on a re-run; KEYS ARE NEVER CHANGED. A key is written into
 * system_events that have already travelled to other organizations, so renaming
 * one orphans somebody else's history silently. Retiring a type means adding
 * its successor and leaving the old key in place forever.
 *
 * Deliberately coarse, and deliberately not a shop's own procedure list. What
 * this buys is that "when was the ion source last cleaned" can be asked of a
 * machine whose last three holders each wrote the answer in their own words.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { procedureTypes } from "../src/db/schema";

type Seed = { key: string; label: string; family: string; assetTypes?: string[] };

const TYPES: Seed[] = [
  // ── Consumables ──────────────────────────────────────────────────────────
  { key: "replace-lamp", label: "Replace lamp", family: "Consumables", assetTypes: ["Detector"] },
  { key: "replace-ion-source-consumables", label: "Replace ion source consumables", family: "Consumables", assetTypes: ["Mass spectrometer"] },
  { key: "replace-filament", label: "Replace filament", family: "Consumables", assetTypes: ["Mass spectrometer"] },
  { key: "replace-electron-multiplier", label: "Replace electron multiplier", family: "Consumables", assetTypes: ["Mass spectrometer"] },
  { key: "replace-inlet-liner", label: "Replace inlet liner", family: "Consumables", assetTypes: ["GC"] },
  { key: "replace-septum", label: "Replace septum", family: "Consumables", assetTypes: ["GC"] },
  { key: "replace-ferrules", label: "Replace ferrules", family: "Consumables", assetTypes: ["GC"] },
  { key: "replace-gold-seal", label: "Replace gold seal", family: "Consumables", assetTypes: ["GC"] },
  { key: "replace-column", label: "Replace column", family: "Consumables" },
  { key: "replace-guard-column", label: "Replace guard column", family: "Consumables", assetTypes: ["HPLC", "Column oven"] },
  { key: "replace-plunger-seals", label: "Replace plunger seals", family: "Consumables", assetTypes: ["Pump"] },
  { key: "replace-pump-check-valves", label: "Replace pump check valves", family: "Consumables", assetTypes: ["Pump"] },
  { key: "replace-rotor-seal", label: "Replace rotor seal", family: "Consumables", assetTypes: ["Autosampler", "Valve"] },
  { key: "replace-needle-seat", label: "Replace needle and seat", family: "Consumables", assetTypes: ["Autosampler"] },
  { key: "replace-sample-loop", label: "Replace sample loop", family: "Consumables", assetTypes: ["Autosampler"] },
  { key: "replace-inline-filter", label: "Replace inline filter", family: "Consumables" },
  { key: "replace-solvent-frits", label: "Replace solvent inlet frits", family: "Consumables", assetTypes: ["Pump"] },
  { key: "replace-tubing", label: "Replace tubing", family: "Consumables" },
  { key: "replace-syringe", label: "Replace syringe", family: "Consumables", assetTypes: ["Autosampler"] },
  { key: "replace-vial-trays", label: "Replace vial trays or caps", family: "Consumables", assetTypes: ["Autosampler"] },
  { key: "replace-gas-filter", label: "Replace gas trap or filter", family: "Consumables", assetTypes: ["GC", "Gas generator"] },
  { key: "replace-air-filter", label: "Replace air filter", family: "Consumables" },
  { key: "replace-desiccant", label: "Replace desiccant", family: "Consumables" },

  // ── Cleaning ─────────────────────────────────────────────────────────────
  { key: "clean-ion-source", label: "Clean ion source", family: "Cleaning", assetTypes: ["Mass spectrometer"] },
  { key: "clean-ion-optics", label: "Clean ion optics", family: "Cleaning", assetTypes: ["Mass spectrometer"] },
  { key: "clean-quadrupole", label: "Clean quadrupole", family: "Cleaning", assetTypes: ["Mass spectrometer"] },
  { key: "clean-spray-shield", label: "Clean spray shield or curtain plate", family: "Cleaning", assetTypes: ["Mass spectrometer"] },
  { key: "clean-capillary", label: "Clean transfer capillary", family: "Cleaning", assetTypes: ["Mass spectrometer"] },
  { key: "clean-detector-cell", label: "Clean detector flow cell", family: "Cleaning", assetTypes: ["Detector"] },
  { key: "clean-injector", label: "Clean injector", family: "Cleaning" },
  { key: "clean-exterior", label: "Clean exterior and work area", family: "Cleaning" },
  { key: "flush-fluidics", label: "Flush fluidic path", family: "Cleaning", assetTypes: ["HPLC", "Pump", "Autosampler"] },
  { key: "bakeout", label: "Bake out", family: "Cleaning", assetTypes: ["Mass spectrometer", "GC"] },

  // ── Vacuum and gas ───────────────────────────────────────────────────────
  { key: "change-rough-pump-oil", label: "Change roughing pump oil", family: "Vacuum", assetTypes: ["Vacuum pump"] },
  { key: "service-turbo-pump", label: "Service turbomolecular pump", family: "Vacuum", assetTypes: ["Vacuum pump"] },
  { key: "replace-vacuum-seals", label: "Replace vacuum seals", family: "Vacuum", assetTypes: ["Mass spectrometer", "Vacuum pump"] },
  { key: "leak-check", label: "Leak check", family: "Vacuum" },
  { key: "vacuum-performance-check", label: "Vacuum performance check", family: "Vacuum", assetTypes: ["Mass spectrometer"] },
  { key: "check-gas-supply", label: "Check gas supply and pressures", family: "Gas" },
  { key: "service-gas-generator", label: "Service gas generator", family: "Gas", assetTypes: ["Gas generator"] },
  { key: "purge-gas-lines", label: "Purge gas lines", family: "Gas" },

  // ── Calibration and tuning ───────────────────────────────────────────────
  { key: "mass-axis-calibration", label: "Mass axis calibration", family: "Calibration", assetTypes: ["Mass spectrometer"] },
  { key: "autotune", label: "Autotune", family: "Calibration", assetTypes: ["Mass spectrometer"] },
  { key: "manual-tune", label: "Manual tune", family: "Calibration", assetTypes: ["Mass spectrometer"] },
  { key: "detector-gain-calibration", label: "Detector gain calibration", family: "Calibration", assetTypes: ["Mass spectrometer", "Detector"] },
  { key: "wavelength-calibration", label: "Wavelength calibration", family: "Calibration", assetTypes: ["Detector"] },
  { key: "flow-rate-calibration", label: "Flow rate calibration", family: "Calibration", assetTypes: ["Pump"] },
  { key: "pressure-calibration", label: "Pressure sensor calibration", family: "Calibration" },
  { key: "temperature-calibration", label: "Temperature calibration", family: "Calibration", assetTypes: ["Column oven", "GC"] },
  { key: "injection-volume-calibration", label: "Injection volume calibration", family: "Calibration", assetTypes: ["Autosampler"] },
  { key: "autosampler-alignment", label: "Autosampler alignment", family: "Calibration", assetTypes: ["Autosampler"] },
  { key: "balance-calibration", label: "Balance calibration", family: "Calibration", assetTypes: ["Balance"] },

  // ── Verification and inspection ──────────────────────────────────────────
  { key: "sensitivity-check", label: "Sensitivity check", family: "Verification", assetTypes: ["Mass spectrometer", "Detector"] },
  { key: "resolution-check", label: "Resolution check", family: "Verification", assetTypes: ["Mass spectrometer"] },
  { key: "carryover-check", label: "Carryover check", family: "Verification", assetTypes: ["Autosampler"] },
  { key: "baseline-noise-check", label: "Baseline and noise check", family: "Verification", assetTypes: ["Detector"] },
  { key: "precision-check", label: "Injection precision check", family: "Verification" },
  { key: "pressure-hold-test", label: "Pressure hold test", family: "Verification", assetTypes: ["Pump", "HPLC"] },
  { key: "gradient-performance-test", label: "Gradient performance test", family: "Verification", assetTypes: ["Pump", "HPLC"] },
  { key: "system-suitability", label: "System suitability", family: "Verification" },
  { key: "visual-inspection", label: "Visual inspection", family: "Inspection" },
  { key: "check-for-leaks", label: "Check for leaks", family: "Inspection" },
  { key: "inspect-waste-lines", label: "Inspect waste and drain lines", family: "Inspection" },
  { key: "check-error-logs", label: "Review instrument error logs", family: "Inspection" },

  // ── Mechanical and electrical ────────────────────────────────────────────
  { key: "lubricate-moving-parts", label: "Lubricate moving parts", family: "Mechanical" },
  { key: "replace-fan", label: "Replace cooling fan", family: "Mechanical" },
  { key: "replace-power-supply", label: "Replace power supply", family: "Electrical" },
  { key: "replace-board", label: "Replace electronics board", family: "Electrical" },
  { key: "check-grounding", label: "Check grounding and earthing", family: "Electrical" },
  { key: "replace-battery", label: "Replace backup battery", family: "Electrical" },
  { key: "replace-chiller-coolant", label: "Replace chiller coolant", family: "Mechanical", assetTypes: ["Chiller"] },

  // ── Software and data ────────────────────────────────────────────────────
  { key: "firmware-update", label: "Firmware update", family: "Software" },
  { key: "software-update", label: "Software update", family: "Software", assetTypes: ["Control PC"] },
  { key: "backup-instrument-pc", label: "Back up the instrument PC", family: "Software", assetTypes: ["Control PC"] },
  { key: "restore-method-library", label: "Restore method library", family: "Software", assetTypes: ["Control PC"] },

  // ── Lifecycle ────────────────────────────────────────────────────────────
  { key: "installation-qualification", label: "Installation qualification (IQ)", family: "Qualification" },
  { key: "operational-qualification", label: "Operational qualification (OQ)", family: "Qualification" },
  { key: "performance-qualification", label: "Performance qualification (PQ)", family: "Qualification" },
  { key: "decommission", label: "Decommission", family: "Lifecycle" },
  { key: "relocate", label: "Relocate or reinstall", family: "Lifecycle" },
  { key: "intake-inspection", label: "Intake inspection", family: "Lifecycle" },
  { key: "data-wipe", label: "Data wipe", family: "Lifecycle", assetTypes: ["Control PC"] },
];

async function main() {
  const keys = new Set<string>();
  for (const t of TYPES) {
    if (keys.has(t.key)) throw new Error(`[procedure-types] duplicate key in the seed list: ${t.key}`);
    keys.add(t.key);
  }

  let n = 0;
  for (const [i, t] of TYPES.entries()) {
    await db.insert(procedureTypes)
      .values({ key: t.key, label: t.label, family: t.family, assetTypes: t.assetTypes ?? [], sortOrder: i })
      // Label, family and order may be corrected; the key never is.
      .onConflictDoUpdate({
        target: procedureTypes.key,
        set: { label: t.label, family: t.family, assetTypes: t.assetTypes ?? [], sortOrder: i },
      });
    n++;
  }

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(procedureTypes);
  console.log(`[procedure-types] seeded ${n} type(s); ${total} on file`);
  if (total > TYPES.length) {
    console.log(`[procedure-types] ${total - TYPES.length} extra row(s) not in this list - retired keys are kept on purpose`);
  }
}

main().catch((e) => { console.error("[procedure-types] failed:", e); process.exit(1); });
