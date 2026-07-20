/**
 * Seed the database from the client's sheet as of Jul 2026, plus the task
 * detail worked out in the design sessions. Run once after db:push:
 *   DATABASE_URL=... npm run db:seed
 * Idempotent-ish: skips if any instruments already exist.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import {
  instruments, tasks, checklistItems, itemNotes, taskNotes, parts, appSettings, auditLog,
} from "../src/db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function main() {
  const existing = await db.select({ id: instruments.id }).from(instruments).limit(1);
  if (existing.length) {
    console.log("Instruments already present; skipping seed.");
    return;
  }

  const instSeed: { externalId: string; client: string; model: string; priority: number; stages: string[]; notes: string }[] = [
    { externalId: "T-003", client: "Testen", model: "Thermo Trace 1310 GC + ISQ MS + Headspace", priority: 1, stages: ["Checkout", "Applications"], notes: "" },
    { externalId: "T-004", client: "Testen", model: "Thermo Trace 1310 GC + ISQ MS + CombiPal", priority: 1, stages: ["Checkout"], notes: "Repeller replacement in progress." },
    { externalId: "G-010", client: "GMI", model: "Shimadzu LCMS-8060 + Shimadzu HPLC", priority: 2, stages: ["Checkout", "Sign-off"], notes: "Reserpine test & tune. Awaiting GMI sign-off." },
    { externalId: "CASA-001", client: "Casablanca", model: "Agilent Ultivo 6465A LCMS", priority: 3, stages: ["System setup", "Waiting / blocked"], notes: "HED fault - replacement supply on order." },
    { externalId: "U-001", client: "Utah", model: "Shimadzu LCMS-8050 + LC-40", priority: 3, stages: ["System setup"], notes: "No signal on source." },
    { externalId: "U-004", client: "Utah", model: "Shimadzu GCMS-QP2010 w/ liquid injection", priority: 4, stages: ["Refurbishment", "System setup"], notes: "Comms issues between system and autosampler?" },
    { externalId: "U-005", client: "Utah", model: "Agilent 7700 ICP-MS", priority: 5, stages: ["System setup"], notes: "TBD - arrived disassembled, in disarray." },
    { externalId: "T-001", client: "Testen", model: "Thermo Altis LC-MS/MS", priority: 6, stages: ["Refurbishment", "System setup"], notes: "Turbo problems." },
    { externalId: "T-002", client: "Testen", model: "Thermo TSQ 8000 (GC)", priority: 7, stages: ["Refurbishment", "System setup"], notes: "" },
    { externalId: "U-003", client: "Utah", model: "Shimadzu GCMS-QP2010 w/ headspace", priority: 9, stages: ["Refurbishment", "System setup"], notes: "" },
    { externalId: "G-011", client: "GMI", model: "Thermo Altis LC-MS w/ LX-4 HPLC", priority: 10, stages: ["Intake"], notes: "" },
  ];
  const instRows = await db.insert(instruments).values(instSeed).returning();
  const byExt = new Map(instRows.map((r) => [r.externalId, r.id]));
  const iid = (ext: string) => byExt.get(ext)!;

  // Tasks
  const [reserpine] = await db.insert(tasks).values({
    instrumentId: iid("G-010"), title: "Perform Reserpine tests", assignee: "Bill", state: "In progress",
    body: "Bill to test/compile Reserpine for GMI, submit to Pradeep.",
  }).returning();
  const [repeller] = await db.insert(tasks).values({
    instrumentId: iid("T-004"), title: "Replace repeller", assignee: "Bill", state: "In progress",
    body: "Repeller delivered 6/25. Install and verify source performance.",
  }).returning();
  const [hed] = await db.insert(tasks).values({
    instrumentId: iid("CASA-001"), title: "Replace 10kV HED supply", assignee: "Joe", state: "Blocked",
    body: "HED fault confirmed. Agilent PN G6303-80060 / Applied Kilovolts MS1065 on order.",
  }).returning();
  await db.insert(tasks).values({
    instrumentId: iid("CASA-001"), title: "Tune system", assignee: "Bill", state: "Open",
    body: "After HED swap. Let system stabilize overnight before autotune.",
  });
  await db.insert(tasks).values({
    instrumentId: iid("U-001"), title: "Diagnose no-signal on source", assignee: "Joe", state: "In progress",
    body: "No signal at source on LCMS-8050. Work through voltages, cabling, and ion optics.",
  });
  const [roughPump] = await db.insert(tasks).values({
    instrumentId: iid("CASA-001"), title: "Connect + confirm rough pump", assignee: "Bill", state: "Done",
    body: "Connect rough pump, confirm operation, clean tubing and exhaust routing.",
    completedAt: new Date("2026-07-15T11:30:00-07:00"),
  }).returning();

  // Checklists + item note threads
  const [compile] = await db.insert(checklistItems).values({ taskId: reserpine.id, text: "Compile Reserpine", done: true }).returning();
  await db.insert(checklistItems).values([
    { taskId: reserpine.id, text: "Run replicate injections, verify %RSD", done: false, sortOrder: 1 },
    { taskId: reserpine.id, text: "Submit results to Pradeep", done: false, sortOrder: 2 },
  ]);
  await db.insert(itemNotes).values({ itemId: compile.id, author: "Bill", text: "Passed at 101% of spec." });
  await db.insert(taskNotes).values({ taskId: reserpine.id, author: "Bill", text: "Passed at 101% of spec" });

  await db.insert(checklistItems).values([
    { taskId: repeller.id, text: "Receive repeller", done: true },
    { taskId: repeller.id, text: "Install in source", done: false, sortOrder: 1 },
    { taskId: repeller.id, text: "Vent, swap, pump down, verify", done: false, sortOrder: 2 },
  ]);

  const hedItems = await db.insert(checklistItems).values([
    { taskId: hed.id, text: "Confirm HED fault", done: true },
    { taskId: hed.id, text: "Order replacement supply", done: true, sortOrder: 1 },
    { taskId: hed.id, text: "Install and verify", done: false, sortOrder: 2 },
  ]).returning();
  await db.insert(itemNotes).values({ itemId: hedItems[1].id, author: "Joe", text: "In transit, ETA Jul 23." });
  await db.insert(taskNotes).values({ taskId: hed.id, author: "Joe", text: "Ordered from Applied Kilovolts, cheaper than Agilent direct." });

  const pumpItems = await db.insert(checklistItems).values([
    { taskId: roughPump.id, text: "Connect rough pump", done: true },
    { taskId: roughPump.id, text: "Confirm pump pulling vacuum", done: true, sortOrder: 1 },
    { taskId: roughPump.id, text: "Clean tubing / exhaust", done: true, sortOrder: 2 },
  ]).returning();
  await db.insert(itemNotes).values({ itemId: pumpItems[1].id, author: "Bill", text: "Held spec." });
  await db.insert(taskNotes).values({ taskId: roughPump.id, author: "Bill", text: "All good. Ready for HED swap when the part lands." });

  // Parts
  await db.insert(parts).values([
    {
      instrumentId: iid("T-004"), name: "Repeller", partNumber: "", vendor: "eBay / surplus",
      po: "", cost: "85", carrier: "UPS", tracking: "1Z9999W99999999999",
      orderedAt: "Jun 18", eta: "Jun 25", receivedAt: "Jun 25", status: "Received",
    },
    {
      instrumentId: iid("CASA-001"), name: "10kV HED supply", partNumber: "G6303-80060 / AK MS1065", vendor: "Applied Kilovolts",
      po: "SS-1042", cost: "1,240", carrier: "UPS", tracking: "1Z999AA10123456784",
      orderedAt: "Jul 18", eta: "Jul 23", receivedAt: "", status: "In transit",
    },
  ]);

  // Settings singleton
  await db.insert(appSettings).values({ id: 1, clientAccessEnabled: false, clientCanEdit: false }).onConflictDoNothing();

  await db.insert(auditLog).values({
    actor: "seed", entityType: "system", entityId: "", action: "database seeded from client sheet snapshot (Jul 2026)",
  });

  console.log(`Seeded ${instRows.length} instruments with tasks, checklists, notes, and parts.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
