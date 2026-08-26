/**
 * A whole service company, invented: the demo workspace you hand to a buyer.
 *
 *   DATABASE_URL=... npx tsx scripts/seed-demo.ts
 *   DATABASE_URL=... npx tsx scripts/seed-demo.ts --reset      # rebuild it
 *   DATABASE_URL=... npx tsx scripts/seed-demo.ts --wipe       # remove it
 *
 * WHAT IT MAKES. One operator organization - a second tenant on this instance,
 * beside whoever already runs it - with its own staff, its own clients, and a
 * year of work behind it: systems at every stage, jobs in every state, parts
 * in every lane, quotes and invoices in every status, contracts drawing down,
 * a collections ladder mid-climb, files people can actually open. Every client
 * SHAPE the product knows is represented, because "does it handle a reseller"
 * is the question a buyer asks on the second click:
 *
 *   Ellison BioLabs      a regulated lab under full-service contract - multi
 *                        site, GxP paperwork, its own stockroom, remote access
 *   North Harbor Diag.   time-and-materials, paying late, on the dunning ladder
 *   Meridian Instr. Exch. a RESELLER: units are stock, the landing is a pipeline
 *   Vantage Scientific   a PROVIDER: another service outfit sharing one system
 *   Keystone Bio         a client with nothing of theirs on the bench at all
 *
 * WHAT IT WILL NOT TOUCH. Everything it writes is stamped with the demo
 * tenant, hangs off a row that is, or is keyed to a demo email address; it
 * never edits another tenant's rows. `--wipe` takes it all back out again, and
 * does so explicitly rather than by cascade - see wipe() for why the cascade
 * alone would leave litter.
 *
 * INSTANCE SETTINGS. A few things are one row for the whole instance, and the
 * demo cannot show a client portal, an EOD report or a remote session without
 * them, so any that are OFF get turned on and the script PRINTS WHAT IT
 * CHANGED; `--no-modules` leaves app_settings exactly as found. Two numbers -
 * the travel policy and the loaded labor rate - are filled in only when
 * nothing is there at all, since an instance that set its own keeps them.
 * Google-sheet sync stays off either way: it polls somebody's real spreadsheet
 * on a cron, and its diff queue has no tenant column, so a demo diff would
 * appear in a real workspace's parity view.
 *
 * MAIL. Nothing here is wired to send. Digest and EOD recipient lists are left
 * blank and automatic dunning is off on every demo client, so a buyer clicking
 * through cannot mail a stranger; Preview renders the real thing and sends
 * nothing. `--mail-to=you@example.com` wires the lists up if you want live
 * sends.
 *
 * FILES. With BLOB_READ_WRITE_TOKEN set, the reports, certificates, photos and
 * spreadsheets are generated here and uploaded for real, so every download in
 * the demo opens. Without it the rows are still made and the script says which
 * ones will not resolve.
 */
import { eq, inArray, sql as raw } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import * as schema from "../src/db/schema";
import {
  agreements, appSettings, assetEvents, assets, assetShares, attachments, auditLog,
  catalogRefs, checklistItems, clientAllowlist, cloudConnections, creditOverrides, custodyEvents,
  discussionPosts, disputes, driveCache, dropLinks, dunningEvents, emailOutbox, engagementRecords,
  eodUpdates, expenseCategories, expenseReports, expenses, folders, houseMembers,
  instrumentGases, instruments, invoiceFees, invoiceLines, invoices, itemNotes,
  loginEvents, messages, messageThreads, notificationPrefs, notifications, orgSites,
  orgs, partCatalog, partKitLines, partNumbers, partPhotos, partPrices, parts,
  payments, payroll, pmSchedules, poLines, procedures, promises, purchaseOrders,
  quoteLines, quotes, queueEvents, accessRequests, rateCards, remoteDevices,
  people, serviceVisits, shareLinkFiles, shareLinks, signoffs, stageDefs, stageEvents,
  stockItems, stockMoves, stockroomShares, stockrooms, systemShares, taskNotes,
  taskResults, tasks, threadMembers, timeEntries, trailEvents, uiLayouts, users,
  validationDocs, validationSignatures, vocabTerms, workOrderNotes, workOrders,
} from "../src/db/schema";
import { hashPassword, passwordProblem } from "../src/lib/password";
import { STARTER_CATEGORIES } from "../src/lib/expenseCategories";
import { makeTempPassword } from "../src/lib/tempPassword";
import { NOTIFY_KINDS } from "../src/lib/inbox";

type Db = NeonHttpDatabase<typeof schema>;

// ── Options ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, fallback = ""): string => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : fallback;
};

const OWNER = (opt("owner") || process.env.DEMO_OWNER_EMAIL || "demo@ridgelinefield.com").trim().toLowerCase();
const ORG_NAME = opt("name") || process.env.DEMO_ORG_NAME || "Cascade Instrument Service";
const RESET = has("reset");
const DRY = has("dry-run");
const WIPE = has("wipe");
const MODULES = !has("no-modules");
const DEFAULTS = has("defaults");
const MAIL_TO = opt("mail-to").trim().toLowerCase();
const STRIPE_ACCOUNT = opt("stripe-account").trim();

/** Every invented address sits on a reserved TLD, so nothing can be delivered anywhere real. */
const CIS = "cascadeinstrument.example";
const staffEmail = (who: string) => `${who}@${CIS}`;

// ── Clock ──────────────────────────────────────────────────────────────────
// Every date is relative to the run, so a demo opened six months from now still
// reads as a shop that was busy yesterday.
const TZ = process.env.SHOP_TZ || "America/Los_Angeles";
const NOW = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD in shop time. Negative is the past. */
const day = (offset: number): string =>
  new Date(NOW.getTime() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
/**
 * A timestamp on the shop day `offset` days from today, at `hour` UTC
 * (17 ≈ mid-morning Pacific).
 *
 * Never later than the moment the seed runs: today's rows are written at shop
 * hours - an engineer's note at four in the afternoon - and a seed run at
 * breakfast would otherwise stamp them hours into the future, which reads as
 * broken wherever the app says how long ago something happened.
 */
const at = (offset: number, hour = 17, minute = 0): Date => {
  const d = new Date(`${day(offset)}T${pad(hour)}:${pad(minute)}:00.000Z`);
  return d > NOW ? NOW : d;
};
const monthStart = (offset = 0): string => {
  const d = new Date(`${day(0)}T12:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
};

// ── Secrets ────────────────────────────────────────────────────────────────
/**
 * The tokens in share, drop and listing URLs are the WHOLE credential - there
 * is no session behind them, which is the point of handing one to somebody who
 * has no account. So they are random here rather than readable.
 *
 * The one that actually matters is a drop link: /api/drop/[token] mints a Blob
 * upload token for an anonymous caller against nothing but the token in the
 * path, so a guessable one is a stranger writing 100MB at a time into the
 * operator's real Blob store until the quota fills. Named rather than inlined
 * so the same token can be referenced twice - once written, once looked up.
 */
const TOKENS = new Map<string, string>();
const token = (name: string): string => {
  const hit = TOKENS.get(name);
  if (hit) return hit;
  const made = `demo-${randomBytes(16).toString("hex")}`;
  TOKENS.set(name, made);
  return made;
};

// ── Output ─────────────────────────────────────────────────────────────────
const notes: string[] = [];
let step = 0;
const say = (msg: string) => console.log(`  ${msg}`);
const section = (name: string) => console.log(`\n[${++step}] ${name}`);
const warn = (msg: string) => { notes.push(msg); console.log(`  ! ${msg}`); };

// ── Database ───────────────────────────────────────────────────────────────
/**
 * Neon in the ordinary case; the throwaway PGlite of `npm run dev:local` when
 * that harness is what you are pointing at. Same client API either way - the
 * cast is the one src/db/index.ts already makes for the same reason.
 */
async function connect(): Promise<Db> {
  if (process.env.LOCAL_DB === "1" && process.env.PGLITE_DIR) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    return drizzle(new PGlite(process.env.PGLITE_DIR), { schema }) as unknown as Db;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Point it at the instance you want the demo tenant on.");
  }
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  return drizzle(neon(process.env.DATABASE_URL), { schema });
}

// ── Files ──────────────────────────────────────────────────────────────────
// A demo whose "Download" buttons 404 is a demo about broken software, so the
// paperwork is real: generated here, uploaded to the same Blob store the app
// writes to, and recorded at the URL it came back with.

type Stored = { url: string; size: number };
let blobUp = 0;
let blobDown = false;

/** Upload bytes, or fall back to an inline copy when there is no Blob store. */
async function store(name: string, type: string, bytes: Uint8Array): Promise<Stored> {
  const size = bytes.byteLength;
  if (process.env.BLOB_READ_WRITE_TOKEN && !blobDown) {
    try {
      const { put } = await import("@vercel/blob");
      const res = await put(`demo/${ORG_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${name}`, Buffer.from(bytes), {
        access: "public", contentType: type, addRandomSuffix: true,
      });
      blobUp++;
      return { url: res.url, size };
    } catch (e) {
      // One failure is enough to know the store is not reachable; do not spend
      // forty more round trips discovering it again.
      blobDown = true;
      warn(`Blob upload failed (${(e as Error).message}) - the rest of the files are inline copies.`);
    }
  }
  return { url: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`, size };
}

/**
 * A page of the operator's paperwork. Not a facsimile of the app's own PDF
 * exports - those are generated live from the record and always will be - just
 * a real, openable document behind every attachment row.
 */
async function paper(title: string, subtitle: string, body: string[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer(ORG_NAME);
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.11, 0.16, 0.27);
  const faint = rgb(0.42, 0.47, 0.55);

  page.drawRectangle({ x: 0, y: 762, width: 612, height: 30, color: rgb(0.11, 0.16, 0.27) });
  page.drawText(ORG_NAME, { x: 48, y: 772, size: 12, font: bold, color: rgb(1, 1, 1) });
  page.drawText(title, { x: 48, y: 706, size: 20, font: bold, color: ink });
  page.drawText(subtitle, { x: 48, y: 686, size: 10, font: plain, color: faint });
  page.drawLine({ start: { x: 48, y: 672 }, end: { x: 564, y: 672 }, thickness: 0.75, color: faint });

  let y = 646;
  for (const line of body) {
    if (y < 70) break;
    const heading = line.startsWith("## ");
    const text = heading ? line.slice(3) : line;
    page.drawText(text.slice(0, 96), {
      x: 48, y, size: heading ? 11 : 9.5,
      font: heading ? bold : plain, color: heading ? ink : faint,
    });
    y -= heading ? 24 : 15;
  }
  page.drawText(`Generated for demonstration - ${day(0)}`, { x: 48, y: 48, size: 8, font: plain, color: faint });
  return doc.save();
}

/** A labelled rectangle standing in for a bench photo. Real SVG, renders anywhere. */
const photo = (label: string, sub: string, bg: string, fg: string): Uint8Array =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">`
    + `<rect width="960" height="640" fill="${bg}"/>`
    + `<rect x="40" y="40" width="880" height="560" fill="none" stroke="${fg}" stroke-opacity="0.25" stroke-width="3"/>`
    + `<text x="480" y="316" font-family="Helvetica,Arial,sans-serif" font-size="42" font-weight="700"`
    + ` fill="${fg}" text-anchor="middle">${label}</text>`
    + `<text x="480" y="360" font-family="Helvetica,Arial,sans-serif" font-size="20"`
    + ` fill="${fg}" fill-opacity="0.7" text-anchor="middle">${sub}</text>`
    + `</svg>`,
  );

const csv = (rows: string[][]): Uint8Array =>
  Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n"));

// ── Removal ────────────────────────────────────────────────────────────────
/**
 * Take the whole workspace back out.
 *
 * The tempting version of this function is one line - delete the operator
 * organization and let the cascades do the rest - and it is wrong, quietly, in
 * a way that only shows up as litter in somebody else's production database.
 * `drizzle/schema-sync.sql` is an additive, hand-mirrored DDL, and it does not
 * carry a foreign key for every relation `src/db/schema.ts` declares: five
 * stamped tables (discussion_posts, expenses, message_threads, rate_cards,
 * validation_docs) have `tenant_org_id` with nothing behind it, `audit_log`'s
 * is ON DELETE SET NULL, and several child tables - stock items and moves,
 * custody and queue events among them - hang off their parent with no
 * constraint at all. Every one of those survives a cascade, pointing at an id
 * that no longer exists.
 *
 * So nothing here is left to the cascade. The ids are collected first, the
 * children are deleted by them, then the stamped tables by tenant, then the
 * rows keyed to a person by address, and the organizations last. Where a
 * cascade DOES exist the delete that follows it is a harmless no-op, which is
 * the point: this is correct whatever FK actions the target instance carries.
 *
 * The audit log is the deliberate exception to the app's own rule. Nothing in
 * the running product deletes an audit row and nothing should; a synthetic
 * tenant being removed by the script that invented it is not that product, and
 * leaving a few hundred ownerless lines in the trail would be worse.
 */
async function wipe(db: Db, orgId: number, emails: string[]): Promise<void> {
  const pick = <R extends { id: number }>(rows: R[]) => rows.map((r) => r.id);
  /** `inArray` of nothing is not valid SQL, so an empty parent list is a no-op. */
  const some = async (list: number[], run: () => Promise<unknown>) => { if (list.length) await run(); };

  // Every organization in the workspace: the operator and the clients under it.
  const orgIds = [orgId, ...pick(await db.select({ id: orgs.id }).from(orgs)
    .where(eq(orgs.parentOrgId, orgId)))];

  const systemIds = pick(await db.select({ id: instruments.id }).from(instruments)
    .where(eq(instruments.tenantOrgId, orgId)));
  const assetIds = pick(await db.select({ id: assets.id }).from(assets)
    .where(eq(assets.tenantOrgId, orgId)));
  const taskIds = pick(await db.select({ id: tasks.id }).from(tasks)
    .where(eq(tasks.tenantOrgId, orgId)));
  const woIds = pick(await db.select({ id: workOrders.id }).from(workOrders)
    .where(eq(workOrders.tenantOrgId, orgId)));
  const roomIds = pick(await db.select({ id: stockrooms.id }).from(stockrooms)
    .where(eq(stockrooms.tenantOrgId, orgId)));
  const poIds = pick(await db.select({ id: purchaseOrders.id }).from(purchaseOrders)
    .where(eq(purchaseOrders.tenantOrgId, orgId)));
  const catalogIds = pick(await db.select({ id: partCatalog.id }).from(partCatalog)
    .where(eq(partCatalog.tenantOrgId, orgId)));
  const invoiceIds = pick(await db.select({ id: invoices.id }).from(invoices)
    .where(eq(invoices.tenantOrgId, orgId)));
  const quoteIds = pick(await db.select({ id: quotes.id }).from(quotes)
    .where(eq(quotes.tenantOrgId, orgId)));
  const shareIds = pick(await db.select({ id: shareLinks.id }).from(shareLinks)
    .where(eq(shareLinks.tenantOrgId, orgId)));
  const threadIds = pick(await db.select({ id: messageThreads.id }).from(messageThreads)
    .where(eq(messageThreads.tenantOrgId, orgId)));
  const docIds = pick(await db.select({ id: validationDocs.id }).from(validationDocs)
    .where(eq(validationDocs.tenantOrgId, orgId)));
  const itemIds: number[] = [];
  await some(taskIds, async () => itemIds.push(...pick(await db.select({ id: checklistItems.id })
    .from(checklistItems).where(inArray(checklistItems.taskId, taskIds)))));

  // Children first, deepest first: an item note hangs off a checklist item,
  // which hangs off a task.
  await some(itemIds, () => db.delete(itemNotes).where(inArray(itemNotes.itemId, itemIds)));
  await some(taskIds, () => db.delete(checklistItems).where(inArray(checklistItems.taskId, taskIds)));
  await some(taskIds, () => db.delete(taskNotes).where(inArray(taskNotes.taskId, taskIds)));
  await some(taskIds, () => db.delete(taskResults).where(inArray(taskResults.taskId, taskIds)));
  await some(woIds, () => db.delete(workOrderNotes).where(inArray(workOrderNotes.workOrderId, woIds)));
  await some(invoiceIds, () => db.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds)));
  await some(quoteIds, () => db.delete(quoteLines).where(inArray(quoteLines.quoteId, quoteIds)));
  await some(poIds, () => db.delete(poLines).where(inArray(poLines.poId, poIds)));
  await some(shareIds, () => db.delete(shareLinkFiles).where(inArray(shareLinkFiles.shareId, shareIds)));
  await some(docIds, () => db.delete(validationSignatures).where(inArray(validationSignatures.docId, docIds)));
  await some(threadIds, () => db.delete(messages).where(inArray(messages.threadId, threadIds)));
  await some(threadIds, () => db.delete(threadMembers).where(inArray(threadMembers.threadId, threadIds)));
  await some(catalogIds, () => db.delete(partNumbers).where(inArray(partNumbers.catalogId, catalogIds)));
  await some(catalogIds, () => db.delete(partPhotos).where(inArray(partPhotos.catalogId, catalogIds)));
  await some(catalogIds, () => db.delete(partKitLines).where(inArray(partKitLines.kitId, catalogIds)));
  await some(roomIds, () => db.delete(stockItems).where(inArray(stockItems.stockroomId, roomIds)));
  await some(roomIds, () => db.delete(stockMoves).where(inArray(stockMoves.stockroomId, roomIds)));
  await some(roomIds, () => db.delete(stockroomShares).where(inArray(stockroomShares.stockroomId, roomIds)));
  await some(systemIds, () => db.delete(parts).where(inArray(parts.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(instrumentGases).where(inArray(instrumentGases.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(stageEvents).where(inArray(stageEvents.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(queueEvents).where(inArray(queueEvents.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(accessRequests).where(inArray(accessRequests.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(systemShares).where(inArray(systemShares.instrumentId, systemIds)));
  await some(systemIds, () => db.delete(custodyEvents).where(inArray(custodyEvents.instrumentId, systemIds)));
  await some(assetIds, () => db.delete(custodyEvents).where(inArray(custodyEvents.assetId, assetIds)));
  await some(systemIds, () => db.delete(signoffs).where(inArray(signoffs.instrumentId, systemIds)));
  await some(assetIds, () => db.delete(signoffs).where(inArray(signoffs.assetId, assetIds)));
  await some(assetIds, () => db.delete(assetEvents).where(inArray(assetEvents.assetId, assetIds)));
  await some(assetIds, () => db.delete(assetShares).where(inArray(assetShares.assetId, assetIds)));
  await some(orgIds, () => db.delete(engagementRecords).where(inArray(engagementRecords.orgId, orgIds)));
  // A system's photo points at an attachment that is about to go, and the
  // attachment column carries no constraint - clear it rather than dangle it.
  await some(systemIds, () => db.update(instruments).set({ photoAttachmentId: null })
    .where(inArray(instruments.id, systemIds)));

  // Then every table that carries the stamp, by tenant.
  const stamped = [
    auditLog, validationDocs, shareLinks, dropLinks, attachments, folders,
    dunningEvents, disputes, promises, invoiceFees, payments, invoices, quotes,
    creditOverrides, expenses, expenseReports, rateCards, payroll,
    messageThreads, discussionPosts, eodUpdates, timeEntries, serviceVisits,
    tasks, pmSchedules, workOrders, purchaseOrders, stockrooms,
    partPrices, partCatalog, catalogRefs, procedures, vocabTerms, people,
    remoteDevices, cloudConnections, agreements, assets, instruments, orgSites,
    expenseCategories, stageDefs,
  ] as const;
  for (const table of stamped) await db.delete(table).where(eq(table.tenantOrgId, orgId));

  // Then what is keyed to a person rather than to a company.
  if (emails.length) {
    await db.delete(notifications).where(inArray(notifications.email, emails));
    await db.delete(notificationPrefs).where(inArray(notificationPrefs.email, emails));
    await db.delete(uiLayouts).where(inArray(uiLayouts.email, emails));
    await db.delete(emailOutbox).where(inArray(emailOutbox.email, emails));
    await db.delete(driveCache).where(inArray(driveCache.memberEmail, emails));
    await db.delete(loginEvents).where(inArray(loginEvents.email, emails));
    await db.delete(trailEvents).where(inArray(trailEvents.email, emails));
    await db.delete(clientAllowlist).where(inArray(clientAllowlist.entry, emails));
    await db.delete(houseMembers).where(inArray(houseMembers.email, emails));
    // Sessions and accounts cascade from users; the Auth.js tables know nothing
    // about organizations, so the address is the only handle on them.
    await db.delete(users).where(inArray(users.email, emails));
  }

  // The organizations last, clients before the operator that owns them.
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
}

/** Every address this seed invents, so a wipe can find them again. */
function demoEmails(): string[] {
  return [
    OWNER,
    ...["tess", "owen", "priya", "dana"].map(staffEmail),
    "rita@ellisonbio.example", "marcus@ellisonbio.example", "qa@ellisonbio.example",
    "ap@ellisonbio.example",
    "sam@northharbor.example", "k.osei@northharbor.example", "controller@northharbor.example",
    "jules@meridianexchange.example",
    "dispatch@vantagesci.example",
    "nadia@keystonebio.example",
  ];
}

// ── The people who work here ───────────────────────────────────────────────
// Named once, used everywhere: assignee fields, note authors, invoice lines and
// the payroll table all have to agree about who Tess Nakamura is.
const HOUSE = {
  owner: { email: OWNER, name: "Alex Rainier", title: "Owner / service manager", role: "owner" as const },
  tess: { email: staffEmail("tess"), name: "Tess Nakamura", title: "Senior field service engineer", role: "staff" as const },
  owen: { email: staffEmail("owen"), name: "Owen Brandt", title: "Bench technician", role: "staff" as const },
  priya: { email: staffEmail("priya"), name: "Priya Raman", title: "Applications scientist", role: "staff" as const },
  dana: { email: staffEmail("dana"), name: "Dana Whitfield", title: "Office manager", role: "staff" as const },
};

async function main(): Promise<void> {
  const db = await connect();
  console.log(`\nDemo workspace: "${ORG_NAME}"  ·  owner ${OWNER}`);

  // ── Preflight ────────────────────────────────────────────────────────────
  section("Checking the instance");
  let [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  if (!settings && !DRY) {
    await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
    say("app_settings had no row; created one.");
    [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  }
  const [existing] = await db.select().from(orgs).where(eq(orgs.name, ORG_NAME));

  if (WIPE) {
    if (!existing) { console.log(`\nNothing to remove - no organization named "${ORG_NAME}".\n`); return; }
    await wipe(db, existing.id, demoEmails());
    console.log(`\nRemoved "${ORG_NAME}" and everything that hung off it.`);
    console.log("  app_settings is left as it is: the module flags the seed turned on may now be");
    console.log("  load-bearing for another workspace, and this script cannot know which were.\n");
    return;
  }
  if (existing && !RESET) {
    console.log(
      `\n"${ORG_NAME}" already exists (org ${existing.id}).\n`
      + "  Re-run with --reset to rebuild it from scratch, or --wipe to remove it.\n",
    );
    return;
  }
  if (existing) {
    say(`Rebuilding: removing the previous "${ORG_NAME}" first.`);
    await wipe(db, existing.id, demoEmails());
  }

  // A borrowed name or address is a failure the database would report three
  // hundred inserts from now, so ask first and say which one it was.
  const clientNames = ["Ellison BioLabs", "North Harbor Diagnostics", "Meridian Instrument Exchange",
    "Vantage Scientific", "Keystone Bio"];
  const clash = await db.select({ name: orgs.name }).from(orgs).where(inArray(orgs.name, clientNames));
  if (clash.length) {
    throw new Error(
      `These organization names are already on this instance: ${clash.map((c) => c.name).join(", ")}.\n`
      + "  Organization names are unique instance-wide. Rename them, or seed the demo elsewhere.",
    );
  }
  const [staffTaken] = await db.select({ email: houseMembers.email }).from(houseMembers)
    .where(eq(houseMembers.email, OWNER));
  if (staffTaken) {
    throw new Error(`${OWNER} is already staff somewhere on this instance. One person is staff of one company.`);
  }
  const idClash = await db.select({ externalId: instruments.externalId }).from(instruments)
    .where(raw`${instruments.externalId} LIKE 'CIS-1%'`);
  if (idClash.length) {
    throw new Error(`System ids CIS-1xxx are already taken (${idClash.length} of them). Wipe the old demo first.`);
  }

  // ── Dry run ──────────────────────────────────────────────────────────────
  // Read-only, and the only honest answer to "what will this do to MY instance".
  // Everything above this line is a SELECT; everything below it writes. So a
  // dry run stops here, having already proved the names are free, and reports
  // the instance-wide changes - which are the only ones anybody else can see.
  if (DRY) {
    const [otherOps] = await db.select({ n: raw<number>`count(*)::int` }).from(orgs)
      .where(eq(orgs.isOperator, true));
    console.log("\n  Nothing was written. This is what a real run would change.\n");
    console.log(`  Workspace name "${ORG_NAME}" is free, and so are the five client names.`);
    console.log(`  ${OWNER} is not staff anywhere on this instance.`);
    console.log(`  This instance currently has ${otherOps?.n ?? 0} operator workspace(s); the demo would be one more.\n`);

    const flags = {
      clientAccessEnabled: "client sign-in - lets client accounts on the allowlist sign in at all",
      eodEnabled: "the EOD report page and its nav entry",
      digestEnabled: "the daily digest. READ THIS ONE TWICE: the cron is gated on this single "
        + "instance-wide flag, so turning it on restarts YOUR OWN workspace's morning digest - the "
        + "internal edition to your staff, and a partner edition to every client of yours that has "
        + "recipients configured. If it has been off for a while, real customers get mail tomorrow",
      remoteEnabled: "remote support pages",
      publicCatalogEnabled: "the public, unauthenticated equipment catalog",
    } as const;
    const off = (Object.keys(flags) as (keyof typeof flags)[]).filter((k) => settings && !settings[k]);
    if (!settings) {
      console.log("  app_settings has NO ROW on this instance - a real run would create it.\n");
    } else if (off.length) {
      console.log("  INSTANCE-WIDE, would be turned ON (every workspace here sees these):");
      for (const k of off) console.log(`    - ${k}: ${flags[k]}`);
      console.log("    Pass --no-modules to leave every one of them alone.\n");
    } else {
      console.log("  Instance modules are all on already - a real run would change none of them.\n");
    }
    const unset = settings
      ? [settings.expensePolicy === null ? "expense_policy" : "", settings.loadedLaborCents === 0 ? "loaded_labor_cents" : ""].filter(Boolean)
      : [];
    if (unset.length) {
      console.log(`  NOT touched unless you ask: ${unset.join(", ")} (currently unset here).`);
      console.log("    Without them the demo's travel strip is blank and its job costing shows no");
      console.log("    margin. Pass --defaults to fill them in - but note they are instance-wide,");
      console.log("    so YOUR real jobs would start showing margins computed from an invented rate.\n");
    }
    console.log("  Everything else it writes is stamped with the demo tenant and invisible to yours.");
    console.log("  Google-sheet sync is never touched. No mail is wired up. Run without --dry-run to do it.\n");
    return;
  }

  // ── Instance settings ────────────────────────────────────────────────────
  // Client sign-in and the optional modules are one row for the whole instance.
  // The demo cannot show a client portal, an EOD report or a remote session
  // without them, so turn on what is off - and say so, because it is not only
  // the demo tenant that will see the difference.
  if (MODULES) {
    const want = {
      clientAccessEnabled: "client sign-in",
      eodEnabled: "EOD report",
      digestEnabled: "daily digest",
      remoteEnabled: "remote support",
      publicCatalogEnabled: "public equipment catalog",
    } as const;
    const turnedOn = (Object.keys(want) as (keyof typeof want)[]).filter((k) => settings && !settings[k]);
    if (turnedOn.length) {
      await db.update(appSettings)
        .set(Object.fromEntries(turnedOn.map((k) => [k, true])))
        .where(eq(appSettings.id, 1));
      warn(`Turned ON instance-wide: ${turnedOn.join(", ")}. This affects every workspace here.`);
      // The app writes an audit line whenever somebody flips these in Settings
      // (actions.updateSettings), and a change made by a script is no less worth
      // finding later - more so, since nobody was watching. tenantOrgId stays
      // null because the change belongs to the INSTANCE rather than to the demo,
      // which is also why --wipe leaves these lines behind: removing the
      // workspace does not un-turn-on what was turned on for everybody.
      await db.insert(auditLog).values(turnedOn.map((k) => ({
        tenantOrgId: null, actor: OWNER, entityType: "settings", entityId: k,
        action: `seed-demo turned on ${k} for the whole instance`,
        field: k, oldValue: "false", newValue: "true",
      })));
      if (turnedOn.includes("digestEnabled")) {
        warn("Because the digest was among them: the hourly cron is gated on that one flag for the "
          + "WHOLE instance, so your own workspace's morning digest starts again tomorrow - internal "
          + "edition to your staff, partner edition to any client of yours with recipients set. Turn "
          + "it back off in Settings > Configuration if that is not what you wanted.");
      }
    } else {
      say("Instance modules were already on; nothing changed.");
    }
    // Never: it polls a real spreadsheet on an hourly cron, and its diff queue
    // has no tenant column, so a demo diff would appear in somebody's real one.
    if (settings && !settings.sheetSyncEnabled) {
      say("Left Google-sheet sync off (it polls a real spreadsheet).");
    } else if (settings?.sheetSyncEnabled) {
      // "Left off" is no protection when it was already on. lib/sheetSync reads
      // `db.select().from(instruments)` with no tenant predicate, so the demo's
      // systems will be compared against whatever sheet this instance polls and
      // will surface as diffs in ITS parity view. Nothing here can fix that; the
      // honest thing is to say so before the rows exist.
      warn("Google-sheet sync is ALREADY ON here. Its diff engine reads every instrument on the "
        + "instance with no tenant filter, so the demo's 15 systems will appear as unresolved diffs "
        + "in your own Sheet parity view. Turn the module off first, or expect to dismiss them.");
    }

    // Two instance-wide numbers with no tenant column of their own, behind two
    // whole surfaces that read empty without them: the travel-stipend strip on
    // a work order, and the margin on the job-cost panel.
    //
    // OPT-IN, unlike the module flags above, and the difference is worth
    // stating. A nav entry appearing is a change somebody notices and ignores.
    // A loaded labor rate is a number the existing operator's own job-costing
    // screens compute margins FROM: fill it in unasked and their real jobs
    // start showing invented profit. That is not a demo touching a demo; it is
    // a script editing somebody's books. So --defaults, or not at all.
    if (DEFAULTS && settings && settings.expensePolicy === null) {
      await db.update(appSettings).set({
        expensePolicy: {
          radiusMiles: 80, dayPerDiemCents: 3000, overnightPerDiemCents: 6500,
          extendedAfterNights: 3, overnightExtendedCents: 8500, hotelNightCapCents: 18000,
        },
      }).where(eq(appSettings.id, 1));
      await db.insert(auditLog).values({
        tenantOrgId: null, actor: OWNER, entityType: "settings", entityId: "expensePolicy",
        action: "seed-demo set a starter travel/expense policy for the whole instance",
        field: "expensePolicy", oldValue: "", newValue: "starter",
      });
      warn("Instance had no travel/expense policy; set a starter one (80 mi radius, $30/day, $180/night cap).");
    }
    if (DEFAULTS && settings && settings.loadedLaborCents === 0) {
      await db.update(appSettings).set({ loadedLaborCents: 9500 }).where(eq(appSettings.id, 1));
      await db.insert(auditLog).values({
        tenantOrgId: null, actor: OWNER, entityType: "settings", entityId: "loadedLaborCents",
        action: "seed-demo set the loaded labor rate to $95.00/h for the whole instance",
        field: "loadedLaborCents", oldValue: "0", newValue: "9500",
      });
      warn("Instance had no loaded labor rate; set $95.00/h so job costing shows a margin.");
    }
  } else {
    say("--no-modules: leaving app_settings exactly as found.");
  }

  // ── The operator ─────────────────────────────────────────────────────────
  section("Opening the workspace");
  const [op] = await db.insert(orgs).values({
    name: ORG_NAME, kind: "provider", isOperator: true, parentOrgId: null,
    themeColor: "#1D4E63",
    termsDays: 30,
    // The internal edition does NOT read digestRecipients - runDailyDigest sends
    // it to houseEmails(tenantOrgId) (lib/digest sendEdition, orgId === null),
    // which here is five invented people on a reserved domain. Leaving the
    // recipient list blank therefore stops nothing, and the schema offers no
    // per-workspace off switch. digestDue's last test is `hourNow >= digestHour`
    // and shopHour only ever returns 0-23, so an hour that never arrives is the
    // switch: the cron composes nothing for this workspace, Preview and Send now
    // still work by hand, and --mail-to puts it back on a real schedule.
    digestHour: MAIL_TO ? 7 : 24, digestDays: "1,2,3,4,5",
    digestRecipients: MAIL_TO, eodRecipients: MAIL_TO,
    storageLimitMb: 25600,
    remoteAccessEnabled: true,
    billingAddress: "Cascade Instrument Service\n2140 Foundry Row, Suite 30\nPortland, OR 97210",
    apEmail: staffEmail("dana"),
    // No Stripe account unless one is given. A made-up id would render pay
    // buttons that fail the moment anybody presses them, which demonstrates
    // less than the supported alternative: the portal tells the client how to
    // send a check. Pass --stripe-account=acct_... (test mode) for the rest.
    stripeAccountId: STRIPE_ACCOUNT, stripeReady: STRIPE_ACCOUNT !== "",
    createdAt: at(-410),
  }).returning();
  const T = op.id;                       // the tenant stamp, on every row below
  say(`Operator org ${T}: ${ORG_NAME}`);

  // Its people. house_members is what makes them staff OF this company - the
  // role resolves at sign-in, so the row IS the access.
  await db.insert(houseMembers).values([
    { email: HOUSE.owner.email, orgId: T, role: "owner", name: HOUSE.owner.name, addedBy: "seed-demo",
      homeAddress: "1820 SE Ladd Ave, Portland, OR 97214", homeLat: 45.5054, homeLng: -122.6427, createdAt: at(-410) },
    { email: HOUSE.tess.email, orgId: T, role: "staff", name: HOUSE.tess.name, addedBy: OWNER,
      homeAddress: "3311 N Williams Ave, Portland, OR 97227", homeLat: 45.5476, homeLng: -122.6668, createdAt: at(-380) },
    { email: HOUSE.owen.email, orgId: T, role: "staff", name: HOUSE.owen.name, addedBy: OWNER,
      homeAddress: "9 SW Barbur Blvd, Portland, OR 97219", homeLat: 45.4611, homeLng: -122.7010, createdAt: at(-300) },
    { email: HOUSE.priya.email, orgId: T, role: "staff", name: HOUSE.priya.name, addedBy: OWNER,
      homeAddress: "700 Bellevue Way NE, Bellevue, WA 98004", homeLat: 47.6150, homeLng: -122.2015, createdAt: at(-210) },
    { email: HOUSE.dana.email, orgId: T, role: "staff", name: HOUSE.dana.name, addedBy: OWNER, createdAt: at(-360) },
  ]);

  // The accounts themselves. A user row is what a session attaches to; the
  // owner's carries a password so the keys can be handed over by phone rather
  // than by forwarding a six-digit code out of somebody's inbox.
  const chosen = opt("password") || process.env.DEMO_PASSWORD || "";
  let password = chosen;
  if (!password) {
    do { password = makeTempPassword((max) => randomBytes(4).readUInt32BE(0) % max); }
    while (passwordProblem(password, OWNER));
  }
  const bad = passwordProblem(password, OWNER);
  if (bad) throw new Error(`That password will not be accepted by the app: ${bad}`);
  const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
  const hash = await hashPassword(password, (p, s, k, o) => scrypt(p, s, k, o), randomBytes);

  await db.insert(users).values([
    { name: HOUSE.owner.name, email: OWNER, role: "owner", onboardedAt: at(-410), lastSeenAt: at(0, 15),
      firstName: "Alex", lastName: "Rainier", title: HOUSE.owner.title, phone: "(503) 555-0147",
      passwordHash: hash, passwordSetAt: NOW, passwordTempUntil: null, emailVerified: at(-410) },
    { name: HOUSE.tess.name, email: HOUSE.tess.email, role: "staff", onboardedAt: at(-380), lastSeenAt: at(0, 16),
      firstName: "Tess", lastName: "Nakamura", title: HOUSE.tess.title, emailVerified: at(-380) },
    { name: HOUSE.owen.name, email: HOUSE.owen.email, role: "staff", onboardedAt: at(-300), lastSeenAt: at(-1, 22),
      firstName: "Owen", lastName: "Brandt", title: HOUSE.owen.title, emailVerified: at(-300) },
    { name: HOUSE.priya.name, email: HOUSE.priya.email, role: "staff", onboardedAt: at(-210), lastSeenAt: at(-2, 18),
      firstName: "Priya", lastName: "Raman", title: HOUSE.priya.title, emailVerified: at(-210) },
    { name: HOUSE.dana.name, email: HOUSE.dana.email, role: "staff", onboardedAt: at(-360), lastSeenAt: at(-1, 17),
      firstName: "Dana", lastName: "Whitfield", title: HOUSE.dana.title, emailVerified: at(-360) },
  ]);

  // The expense vocabulary a workspace is born with - exactly what
  // actions.createOperator plants, so the demo eats what production cooks.
  await db.insert(expenseCategories).values(STARTER_CATEGORIES.map((name, i) => ({
    tenantOrgId: T, name, sortOrder: i + 1, createdBy: OWNER, createdAt: at(-410),
  })));

  // One stage of their own, beside the eleven built in.
  await db.insert(stageDefs).values({
    tenantOrgId: T, name: "Factory acceptance", bg: "#D8E6F5", fg: "#1C4587", sortOrder: 60, builtin: false,
  }).onConflictDoNothing();

  // ── The client roster ────────────────────────────────────────────────────
  // Five organizations, chosen so that every SHAPE of relationship the product
  // knows about is on screen at once - not five variations on "a lab".
  section("Clients, sites and logins");
  const mkOrg = async (v: typeof orgs.$inferInsert) => (await db.insert(orgs).values(v).returning())[0];

  const ellison = await mkOrg({
    name: "Ellison BioLabs", kind: "client", parentOrgId: T, createdAt: at(-395),
    themeColor: "#2E6B4F", termsDays: 30, apEmail: "ap@ellisonbio.example",
    poNumber: "PO-EBL-4471", poBalanceCents: 4_200_000,
    // Their own partner edition of the morning digest, weekday mornings.
    digestHour: 7, digestDays: "1,2,3,4,5", digestRecipients: MAIL_TO, eodRecipients: MAIL_TO,
    storageLimitMb: 25600, remoteAccessEnabled: true,
    billingAddress: "Ellison BioLabs, Inc.\nAttn: Accounts Payable\n4400 Genome Way\nHillsboro, OR 97124",
    billingPolicy: {
      graceDays: 10, feeType: "none", rateBpsMonthly: 0, flatCents: 0, appliesTo: "all",
      holdDays: 0, holdAmountCents: 0, dunningAuto: false, escalation: [],
      taxParts: true, partsMarkupBps: 2200, cardsEnabled: true,
      cardSurchargeBps: 0, cardSurchargeFlatCents: 0,
    },
  });
  const harbor = await mkOrg({
    name: "North Harbor Diagnostics", kind: "client", parentOrgId: T, createdAt: at(-330),
    themeColor: "#7A4B9C", termsDays: 15, apEmail: "ap@northharbor.example",
    poNumber: "", poBalanceCents: 0, storageLimitMb: 5120,
    billingAddress: "North Harbor Diagnostics\n88 Pier Road\nAstoria, OR 97103",
    // The strict end of the policy range: short grace, a flat late fee, a hold
    // that trips early, and a ladder that names a new person at each rung.
    billingPolicy: {
      graceDays: 3, feeType: "flat", rateBpsMonthly: 150, flatCents: 7500, appliesTo: "all",
      holdDays: 45, holdAmountCents: 750_000, dunningAuto: false,
      escalation: [
        { name: "K. Osei", role: "Lab manager", email: "k.osei@northharbor.example" },
        { name: "R. Beaumont", role: "Purchasing", email: "ap@northharbor.example" },
        { name: "M. Vance", role: "Controller", email: "controller@northharbor.example" },
      ],
      taxParts: false, partsMarkupBps: 3000, cardsEnabled: true,
      cardSurchargeBps: 290, cardSurchargeFlatCents: 30,
    },
  });
  // Every demo client carries dunningAuto:false EXPLICITLY, including the three
  // that need no other billing policy. An absent policy is not a neutral
  // absence - lib/billingPolicy resolves it to DEFAULT_POLICY, where dunningAuto
  // is true - so a demo invoice that later goes late would arm the hourly
  // collections cron against an invented address.
  const quiet = { dunningAuto: false } as const;
  const meridian = await mkOrg({
    name: "Meridian Instrument Exchange", kind: "client", parentOrgId: T, createdAt: at(-260),
    themeColor: "#B26B1F", termsDays: 45, apEmail: "jules@meridianexchange.example",
    billingPolicy: quiet,
    // The third shape of the client product: their units are stock heading for
    // a sale, so their landing is a pipeline and their nav grows Listings.
    resaleEnabled: true, storageLimitMb: 102400,
    billingAddress: "Meridian Instrument Exchange LLC\n1200 Warehouse Loop, Bay 6\nTacoma, WA 98421",
  });
  const vantage = await mkOrg({
    // Not a customer: another service company, invited onto one system because
    // the NMR magnet work is theirs. This is what `kind: provider` is for.
    name: "Vantage Scientific", kind: "provider", parentOrgId: T, createdAt: at(-150),
    themeColor: "#334155", termsDays: 30, storageLimitMb: 1024, billingPolicy: quiet,
  });
  const keystone = await mkOrg({
    // Nothing of theirs is ever on our bench. They exist to prove the product
    // can report a day whose only work was a phone call.
    name: "Keystone Bio", kind: "client", parentOrgId: T, createdAt: at(-95),
    themeColor: "#0F766E", termsDays: 30, apEmail: "nadia@keystonebio.example", storageLimitMb: 1024,
    billingPolicy: quiet,
  });
  say(`Clients: Ellison ${ellison.id}, North Harbor ${harbor.id}, Meridian ${meridian.id}, `
    + `Vantage ${vantage.id} (provider), Keystone ${keystone.id}`);

  // Somewhere to be. Coordinates are real, so the routed-miles path and the
  // travel-stipend radius both have something to measure without a network call.
  const sites = await db.insert(orgSites).values([
    { tenantOrgId: T, orgId: ellison.id, name: "Ellison - Hillsboro campus",
      address: "4400 Genome Way, Hillsboro, OR 97124", contactName: "Rita Alvarez",
      contactPhone: "(503) 555-0188", contactEmail: "rita@ellisonbio.example",
      accessNotes: "Badge at the north lobby. Loading dock D after 7am; ask for Marcus.",
      taxRateBps: 0, onewayMiles: 22, lat: 45.5301, lng: -122.9432, createdBy: OWNER, createdAt: at(-395) },
    { tenantOrgId: T, orgId: ellison.id, name: "Ellison - Bend annex",
      address: "63020 Corporate Pl, Bend, OR 97701", contactName: "Marcus Doyle",
      contactPhone: "(541) 555-0132", contactEmail: "marcus@ellisonbio.example",
      accessNotes: "Gate code changes quarterly - call ahead.",
      taxRateBps: 0, onewayMiles: 172, lat: 44.0763, lng: -121.3153, createdBy: OWNER, createdAt: at(-300) },
    { tenantOrgId: T, orgId: ellison.id, name: "Ellison - Suite 200 cleanroom",
      address: "4400 Genome Way, Suite 200, Hillsboro, OR 97124", contactName: "QA desk",
      contactEmail: "qa@ellisonbio.example",
      accessNotes: "Gowning required. Escort mandatory - GxP area, log every entry.",
      taxRateBps: 0, onewayMiles: 22, lat: 45.5301, lng: -122.9432, createdBy: OWNER, createdAt: at(-260) },
    { tenantOrgId: T, orgId: harbor.id, name: "North Harbor - Pier Road lab",
      address: "88 Pier Road, Astoria, OR 97103", contactName: "Sam Okafor",
      contactPhone: "(503) 555-0119", contactEmail: "sam@northharbor.example",
      taxRateBps: 0, onewayMiles: 98, lat: 46.1879, lng: -123.8313, createdBy: OWNER, createdAt: at(-330) },
    { tenantOrgId: T, orgId: meridian.id, name: "Meridian - Tacoma warehouse",
      address: "1200 Warehouse Loop, Bay 6, Tacoma, WA 98421", contactName: "Jules Ferrand",
      contactPhone: "(253) 555-0164", contactEmail: "jules@meridianexchange.example",
      accessNotes: "Bay 6 roll-up. Forklift on site, no appointment needed.",
      taxRateBps: 1030, onewayMiles: 148, lat: 47.2529, lng: -122.4187, createdBy: OWNER, createdAt: at(-260) },
    { tenantOrgId: T, orgId: keystone.id, name: "Keystone Bio - Eugene",
      address: "1755 Franklin Blvd, Eugene, OR 97403", contactName: "Nadia Brant",
      contactEmail: "nadia@keystonebio.example",
      taxRateBps: 0, onewayMiles: 112, lat: 44.0448, lng: -123.0726, createdBy: OWNER, createdAt: at(-95) },
  ]).returning();
  const site = (name: string) => sites.find((s) => s.name.includes(name))!.id;

  // Who may sign in, and what each of them may see. The four flags are four
  // separate questions, and a demo that answers them all the same way is not
  // showing the buyer the control they are being sold.
  await db.insert(clientAllowlist).values([
    // The lab manager: full editor, sees money and contracts.
    { entry: "rita@ellisonbio.example", orgId: ellison.id, canEdit: true, canSeeAgreements: true,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-393) },
    // Facilities: edits the work, never sees a price.
    { entry: "marcus@ellisonbio.example", orgId: ellison.id, canEdit: true, canSeeAgreements: false,
      canSeeMoney: false, canSeePayroll: false, addedBy: OWNER, createdAt: at(-250) },
    // QA: read-only, and reads the paperwork rather than the bench.
    { entry: "qa@ellisonbio.example", orgId: ellison.id, canEdit: false, canSeeAgreements: true,
      canSeeMoney: false, canSeePayroll: false, addedBy: OWNER, createdAt: at(-240) },
    // Accounts payable: money only.
    { entry: "ap@ellisonbio.example", orgId: ellison.id, canEdit: false, canSeeAgreements: true,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-200) },
    { entry: "sam@northharbor.example", orgId: harbor.id, canEdit: false, canSeeAgreements: false,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-328) },
    { entry: "k.osei@northharbor.example", orgId: harbor.id, canEdit: false, canSeeAgreements: false,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-300) },
    { entry: "jules@meridianexchange.example", orgId: meridian.id, canEdit: true, canSeeAgreements: true,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-259) },
    { entry: "dispatch@vantagesci.example", orgId: vantage.id, canEdit: true, canSeeAgreements: false,
      canSeeMoney: false, canSeePayroll: false, addedBy: OWNER, createdAt: at(-149) },
    { entry: "nadia@keystonebio.example", orgId: keystone.id, canEdit: false, canSeeAgreements: true,
      canSeeMoney: true, canSeePayroll: false, addedBy: OWNER, createdAt: at(-94) },
  ]);

  await db.insert(users).values([
    { name: "Rita Alvarez", email: "rita@ellisonbio.example", role: "client_editor", onboardedAt: at(-390),
      lastSeenAt: at(0, 14), firstName: "Rita", lastName: "Alvarez", title: "Lab operations manager",
      phone: "(503) 555-0188", siteId: site("Hillsboro"), emailVerified: at(-390) },
    { name: "Marcus Doyle", email: "marcus@ellisonbio.example", role: "client_editor", onboardedAt: at(-248),
      lastSeenAt: at(-3, 20), firstName: "Marcus", lastName: "Doyle", title: "Facilities lead",
      siteId: site("Bend"), emailVerified: at(-248) },
    { name: "Priya Iyer (QA)", email: "qa@ellisonbio.example", role: "client_viewer", onboardedAt: at(-238),
      lastSeenAt: at(-6, 19), firstName: "Priya", lastName: "Iyer", title: "QA specialist",
      siteId: site("cleanroom"), emailVerified: at(-238) },
    { name: "Ellison AP", email: "ap@ellisonbio.example", role: "client_viewer", onboardedAt: at(-198),
      lastSeenAt: at(-9, 18), title: "Accounts payable", emailVerified: at(-198) },
    { name: "Sam Okafor", email: "sam@northharbor.example", role: "client_viewer", onboardedAt: at(-325),
      lastSeenAt: at(-2, 21), firstName: "Sam", lastName: "Okafor", title: "Laboratory director",
      siteId: site("Pier Road"), emailVerified: at(-325) },
    { name: "K. Osei", email: "k.osei@northharbor.example", role: "client_viewer", onboardedAt: at(-290),
      lastSeenAt: at(-30, 17), firstName: "Kofi", lastName: "Osei", title: "Lab manager", emailVerified: at(-290) },
    { name: "Jules Ferrand", email: "jules@meridianexchange.example", role: "client_editor", onboardedAt: at(-255),
      lastSeenAt: at(0, 13), firstName: "Jules", lastName: "Ferrand", title: "Refurbishment lead",
      siteId: site("Tacoma"), emailVerified: at(-255) },
    { name: "Vantage dispatch", email: "dispatch@vantagesci.example", role: "client_editor", onboardedAt: at(-140),
      lastSeenAt: at(-1, 19), title: "Dispatch", emailVerified: at(-140) },
    { name: "Nadia Brant", email: "nadia@keystonebio.example", role: "client_viewer", onboardedAt: at(-90),
      lastSeenAt: at(-4, 16), firstName: "Nadia", lastName: "Brant", title: "Principal scientist",
      siteId: site("Eugene"), emailVerified: at(-90) },
  ]);

  // Nothing is written to `people`. It is the roster the product replaced - the
  // directory is assembled from house_members, client_allowlist and users
  // (lib/directory), and nothing in src/ reads the table any more - so a demo
  // row there would buy nothing and would take a name out of a globally unique
  // column on somebody else's instance.

  // ── The bench ────────────────────────────────────────────────────────────
  // Fourteen systems, laid out so that every stage in the vocabulary is on the
  // board at once and every posture the dashboard can take has a row: blocked
  // with a written reason, parked in a partner's queue, for sale, overdue for
  // maintenance, regulated, archived.
  section("Systems, modules and gases");
  const sysRows = await db.insert(instruments).values([
    { tenantOrgId: T, externalId: "CIS-1001", client: "Ellison BioLabs", category: "LC-MS",
      name: "Bioanalysis triple quad", model: "6495C LC-MS/MS", manufacturer: "Agilent", serial: "US24071104",
      location: "Hillsboro - Bay 1", ownerOrgId: ellison.id, siteId: site("Hillsboro"), priority: 1, gxp: true,
      lead: HOUSE.tess.name, stages: ["Checkout"], notes: "Reserpine tune and carryover study before release.",
      createdAt: at(-64), updatedAt: at(-1) },
    { tenantOrgId: T, externalId: "CIS-1002", client: "Ellison BioLabs", category: "GC-MS",
      name: "Volatiles GC-MS", model: "ISQ 7000 GC-MS", manufacturer: "Thermo", serial: "ISQ70-24118",
      location: "Shop - Bay 2", ownerOrgId: ellison.id, siteId: site("Hillsboro"), priority: 2,
      lead: HOUSE.owen.name, stages: ["Refurbishment", "System setup"],
      notes: "Turbo replaced under warranty; pumping down since Tuesday.", createdAt: at(-38), updatedAt: at(0) },
    { tenantOrgId: T, externalId: "CIS-1003", client: "Ellison BioLabs", category: "LC-MS",
      name: "Cleanroom LC-MS", model: "LCMS-8060NX", manufacturer: "Shimadzu", serial: "SH8060-2291",
      location: "Suite 200 cleanroom", ownerOrgId: ellison.id, siteId: site("cleanroom"), priority: 2, gxp: true,
      lead: HOUSE.priya.name, stages: ["Sign-off"], notes: "OQ executed. Packet with QA for counter-signature.",
      createdAt: at(-120), updatedAt: at(-2) },
    { tenantOrgId: T, externalId: "CIS-1004", client: "Ellison BioLabs", category: "LC",
      name: "QC UPLC", model: "ACQUITY UPLC H-Class", manufacturer: "Waters", serial: "WAT-H4-9931",
      location: "Hillsboro - QC lab", ownerOrgId: ellison.id, siteId: site("Hillsboro"), priority: 6,
      lead: HOUSE.tess.name, stages: ["In service"], notes: "", createdAt: at(-330), updatedAt: at(-12) },
    { tenantOrgId: T, externalId: "CIS-1005", client: "Ellison BioLabs", category: "GC",
      name: "Residual solvents GC", model: "7890B GC-FID", manufacturer: "Agilent", serial: "CN19422088",
      location: "Bend annex - Room 3", ownerOrgId: ellison.id, siteId: site("Bend"), priority: 4,
      lead: HOUSE.owen.name, stages: ["Maintenance due"], notes: "Annual PM is three weeks past due.",
      createdAt: at(-300), updatedAt: at(-5) },
    { tenantOrgId: T, externalId: "CIS-1006", client: "North Harbor Diagnostics", category: "ICP-OES",
      name: "Trace metals OES", model: "Optima 8300 ICP-OES", manufacturer: "PerkinElmer", serial: "PE8300-441",
      location: "Shop - Receiving", ownerOrgId: harbor.id, siteId: site("Pier Road"), priority: 3,
      lead: HOUSE.owen.name, stages: ["Intake"], notes: "Arrived on a pallet, no crate inventory. Photographing everything.",
      createdAt: at(-9), updatedAt: at(-1) },
    { tenantOrgId: T, externalId: "CIS-1007", client: "North Harbor Diagnostics", category: "ICP-MS",
      name: "Trace metals MS", model: "7700x ICP-MS", manufacturer: "Agilent", serial: "JP18310042",
      location: "Shop - Bay 4", ownerOrgId: harbor.id, siteId: site("Pier Road"), priority: 1,
      lead: HOUSE.tess.name, stages: ["Waiting / blocked"],
      blockedReason: "Waiting on the RF generator board from Agilent - backordered, no ETA since the 9th.",
      blockedSince: at(-12), blockedBy: HOUSE.tess.email, blockedOrgId: null,
      notes: "", createdAt: at(-52), updatedAt: at(-12) },
    { tenantOrgId: T, externalId: "CIS-1008", client: "North Harbor Diagnostics", category: "LC-MS",
      name: "High-res LC-MS", model: "Q Exactive Plus", manufacturer: "Thermo", serial: "QE-2019-773",
      location: "Pier Road lab", ownerOrgId: harbor.id, siteId: site("Pier Road"), priority: 2,
      lead: HOUSE.priya.name, stages: ["Applications"], notes: "Method transfer for the PFAS panel.",
      createdAt: at(-88), updatedAt: at(-3) },
    { tenantOrgId: T, externalId: "CIS-1009", client: "Meridian Instrument Exchange", category: "LC-MS",
      name: "Stock unit - Xevo", model: "Xevo TQ-S micro", manufacturer: "Waters", serial: "WX-TQS-4410",
      location: "Tacoma - Bay 6", ownerOrgId: meridian.id, siteId: site("Tacoma"), priority: 5,
      lead: HOUSE.owen.name, stages: ["Refurbishment"], pmPosture: "advisory",
      forSale: true, saleNote: "Fully refurbished, source rebuilt, sign-off packet included.",
      listingToken: token("lst-xevo-4410"), notes: "", createdAt: at(-70), updatedAt: at(-4) },
    { tenantOrgId: T, externalId: "CIS-1010", client: "Meridian Instrument Exchange", category: "GC-MS",
      name: "Stock unit - 5977B", model: "5977B GC-MSD", manufacturer: "Agilent", serial: "US16290331",
      location: "Tacoma - staged", ownerOrgId: meridian.id, siteId: site("Tacoma"), priority: 3,
      lead: HOUSE.owen.name, stages: ["Waiting to ship"], pmPosture: "advisory",
      forSale: true, saleNote: "Sold pending crate. Photos and checkout data attached.",
      listingToken: token("lst-5977-0331"), notes: "Crate booked for Thursday pickup.",
      createdAt: at(-140), updatedAt: at(-2) },
    { tenantOrgId: T, externalId: "CIS-1011", client: "Meridian Instrument Exchange", category: "LC-MS",
      name: "Stock unit - QTRAP", model: "QTRAP 6500+", manufacturer: "Sciex", serial: "AB6500-1182",
      location: "Tacoma - Bay 6", ownerOrgId: meridian.id, siteId: site("Tacoma"), priority: 8,
      lead: HOUSE.owen.name, stages: ["Waiting / blocked"], pmPosture: "advisory",
      blockedReason: "Curtain plate assembly discontinued. Two substitutes sourced, neither confirmed to fit.",
      blockedSince: at(-46), blockedBy: HOUSE.owen.email,
      notes: "", createdAt: at(-165), updatedAt: at(-46) },
    { tenantOrgId: T, externalId: "CIS-1012", client: "Ellison BioLabs", category: "NMR",
      name: "Structural NMR", model: "Avance NEO 400", manufacturer: "Bruker", serial: "BR-NEO-0219",
      location: "Hillsboro - Magnet room", ownerOrgId: ellison.id, siteId: site("Hillsboro"), priority: 7,
      lead: HOUSE.tess.name, stages: ["Factory acceptance", "System setup"],
      // The third axis: not ours to move next. Vantage has the magnet work.
      queueOrgId: vantage.id, queueSince: at(-6),
      queueReason: "Magnet shim and cryogen fill are Vantage's scope - they are booked for the 14th.",
      notes: "", createdAt: at(-45), updatedAt: at(-6) },
    { tenantOrgId: T, externalId: "CIS-1013", client: "North Harbor Diagnostics", category: "IC",
      name: "Anions IC", model: "930 Compact IC Flex", manufacturer: "Metrohm", serial: "MET930-8871",
      location: "Pier Road lab", ownerOrgId: harbor.id, siteId: site("Pier Road"), priority: 9,
      lead: HOUSE.owen.name, stages: ["In service"], notes: "", createdAt: at(-410), updatedAt: at(-40) },
    { tenantOrgId: T, externalId: "CIS-1014", client: "Ellison BioLabs", category: "LC",
      name: "Prep LC", model: "1260 Infinity II Prep LC", manufacturer: "Agilent", serial: "DEBB-1260-77",
      location: "Returned to client", ownerOrgId: ellison.id, siteId: site("Hillsboro"), priority: 11,
      lead: HOUSE.tess.name, stages: ["Shipped"], notes: "Delivered and installed; 30-day warranty running.",
      createdAt: at(-190), updatedAt: at(-16) },
    // Archived, so /archive is not an empty page and the dashboard's counts are
    // demonstrably counting live work only.
    { tenantOrgId: T, externalId: "CIS-1000", client: "Ellison BioLabs", category: "GC-MS",
      name: "Retired GC-MSD", model: "5975C GC-MSD", manufacturer: "Agilent", serial: "US83221909",
      location: "", ownerOrgId: ellison.id, priority: 99, lead: HOUSE.owen.name, stages: ["Shipped"],
      notes: "Decommissioned at the client's request; parts harvested.",
      archived: true, archivedAt: at(-58), archivedBy: OWNER, createdAt: at(-395), updatedAt: at(-58) },
  ]).returning();
  const sys = (ext: string) => sysRows.find((r) => r.externalId === ext)!;
  const sid = (ext: string) => sys(ext).id;
  say(`${sysRows.length} systems, stages ${[...new Set(sysRows.flatMap((r) => r.stages))].length} of 12 in play`);

  // How each system got where it is. The board reads ages off these.
  await db.insert(stageEvents).values([
    { instrumentId: sid("CIS-1001"), stage: "Intake", kind: "added", at: at(-64) },
    { instrumentId: sid("CIS-1001"), stage: "Intake", kind: "removed", at: at(-58) },
    { instrumentId: sid("CIS-1001"), stage: "Refurbishment", kind: "added", at: at(-58) },
    { instrumentId: sid("CIS-1001"), stage: "Refurbishment", kind: "removed", at: at(-21) },
    { instrumentId: sid("CIS-1001"), stage: "System setup", kind: "added", at: at(-21) },
    { instrumentId: sid("CIS-1001"), stage: "System setup", kind: "removed", at: at(-7) },
    { instrumentId: sid("CIS-1001"), stage: "Checkout", kind: "added", at: at(-7) },
    { instrumentId: sid("CIS-1002"), stage: "Refurbishment", kind: "added", at: at(-38) },
    { instrumentId: sid("CIS-1002"), stage: "System setup", kind: "added", at: at(-11) },
    { instrumentId: sid("CIS-1003"), stage: "Checkout", kind: "removed", at: at(-14) },
    { instrumentId: sid("CIS-1003"), stage: "Sign-off", kind: "added", at: at(-14) },
    { instrumentId: sid("CIS-1006"), stage: "Intake", kind: "added", at: at(-9) },
    { instrumentId: sid("CIS-1007"), stage: "Waiting / blocked", kind: "added", at: at(-12) },
    { instrumentId: sid("CIS-1011"), stage: "Waiting / blocked", kind: "added", at: at(-46) },
    { instrumentId: sid("CIS-1010"), stage: "Waiting to ship", kind: "added", at: at(-2) },
    { instrumentId: sid("CIS-1014"), stage: "Shipped", kind: "added", at: at(-16) },
    { instrumentId: sid("CIS-1005"), stage: "Maintenance due", kind: "added", at: at(-21) },
  ]);

  // Gases, covering every state the vocabulary has - including the two that are
  // problems and the one ("Not needed") that deliberately never is.
  await db.insert(instrumentGases).values([
    { instrumentId: sid("CIS-1001"), gas: "Nitrogen", status: "Connected", note: "House N2 generator, 95 psi", updatedAt: at(-7) },
    { instrumentId: sid("CIS-1001"), gas: "Argon", status: "Low", note: "Tank #A-441, 380 psi - swap before checkout", updatedAt: at(-1) },
    { instrumentId: sid("CIS-1001"), gas: "Helium", status: "Not needed", note: "", updatedAt: at(-60) },
    { instrumentId: sid("CIS-1002"), gas: "Helium", status: "Empty", note: "Tank #H-118 dry. Airgas delivery Thursday.", updatedAt: at(0, 15) },
    { instrumentId: sid("CIS-1002"), gas: "Nitrogen", status: "Connected", note: "", updatedAt: at(-30) },
    { instrumentId: sid("CIS-1005"), gas: "Hydrogen", status: "Connected", note: "Generator, service light on", updatedAt: at(-5) },
    { instrumentId: sid("CIS-1005"), gas: "Air", status: "Connected", note: "Shop compressor", updatedAt: at(-5) },
    { instrumentId: sid("CIS-1006"), gas: "Argon", status: "Not connected", note: "No regulator on site yet", updatedAt: at(-9) },
    { instrumentId: sid("CIS-1007"), gas: "Argon", status: "Connected", note: "Bulk dewar", updatedAt: at(-52) },
    { instrumentId: sid("CIS-1008"), gas: "Nitrogen", status: "Connected", note: "", updatedAt: at(-88) },
    { instrumentId: sid("CIS-1009"), gas: "Nitrogen", status: "Not connected", note: "Bench spare, nothing plumbed", updatedAt: at(-70) },
    { instrumentId: sid("CIS-1012"), gas: "Helium", status: "Low", note: "Cryogen fill booked with Vantage", updatedAt: at(-6) },
  ]);

  // Modules. Some bolted to a system, some sitting on a shelf, one serving
  // another asset rather than a system - which is how a nitrogen generator or
  // a chiller belongs to the thing it feeds.
  const assetRows = await db.insert(assets).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), kind: "Mass spec", model: "6495C", serial: "US24071104",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "In service", location: "Bay 1", sortOrder: 0,
      asFound: "Source contaminated, curtain plate pitted", createdAt: at(-64) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), kind: "Pump", model: "1290 Infinity II Flex", serial: "DEBA-2201",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "In service", location: "Bay 1", sortOrder: 1, createdAt: at(-64) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), kind: "Autosampler", model: "1290 Multisampler", serial: "DEAB-7741",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "In service", location: "Bay 1", sortOrder: 2, createdAt: at(-64) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), kind: "Column oven", model: "1290 MCT", serial: "DEAC-3390",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "In service", location: "Bay 1", sortOrder: 3, createdAt: at(-64) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), kind: "Mass spec", model: "ISQ 7000", serial: "ISQ70-24118",
      manufacturer: "Thermo", ownerOrgId: ellison.id, status: "Needs attention", location: "Bay 2", sortOrder: 0,
      asFound: "Turbo seized at 41k rpm", note: "New turbo fitted, recert pending", createdAt: at(-38) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), kind: "GC", model: "TRACE 1310", serial: "TR1310-9922",
      manufacturer: "Thermo", ownerOrgId: ellison.id, status: "In service", location: "Bay 2", sortOrder: 1, createdAt: at(-38) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), kind: "Autosampler", model: "TriPlus RSH", serial: "TP-RSH-4418",
      manufacturer: "Thermo", ownerOrgId: ellison.id, status: "In service", location: "Bay 2", sortOrder: 2, createdAt: at(-38) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), kind: "Mass spec", model: "LCMS-8060NX", serial: "SH8060-2291",
      manufacturer: "Shimadzu", ownerOrgId: ellison.id, status: "In service", location: "Cleanroom", sortOrder: 0, createdAt: at(-120) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), kind: "Pump", model: "Nexera LC-40D X3", serial: "SH40D-1177",
      manufacturer: "Shimadzu", ownerOrgId: ellison.id, status: "In service", location: "Cleanroom", sortOrder: 1, createdAt: at(-120) },
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), kind: "Detector", model: "ACQUITY TUV", serial: "WAT-TUV-2210",
      manufacturer: "Waters", ownerOrgId: ellison.id, status: "In service", location: "QC lab", sortOrder: 0, createdAt: at(-330) },
    { tenantOrgId: T, instrumentId: sid("CIS-1005"), kind: "GC", model: "7890B", serial: "CN19422088",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "Needs attention", location: "Bend - Room 3", sortOrder: 0,
      note: "FID jet partially blocked at last visit", createdAt: at(-300) },
    { tenantOrgId: T, instrumentId: sid("CIS-1005"), kind: "Injector", model: "7693A ALS", serial: "CN-ALS-6612",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "In service", location: "Bend - Room 3", sortOrder: 1, createdAt: at(-300) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), kind: "Other", model: "Optima 8300", serial: "PE8300-441",
      manufacturer: "PerkinElmer", ownerOrgId: harbor.id, status: "Needs attention", location: "Receiving", sortOrder: 0,
      asFound: "Arrived unpacked. Torch box empty, purge line cut.", createdAt: at(-9) },
    { tenantOrgId: T, instrumentId: sid("CIS-1007"), kind: "Mass spec", model: "7700x", serial: "JP18310042",
      manufacturer: "Agilent", ownerOrgId: harbor.id, status: "Down", location: "Bay 4", sortOrder: 0,
      note: "RF generator board failed - no plasma", createdAt: at(-52) },
    { tenantOrgId: T, instrumentId: sid("CIS-1008"), kind: "Mass spec", model: "Q Exactive Plus", serial: "QE-2019-773",
      manufacturer: "Thermo", ownerOrgId: harbor.id, status: "In service", location: "Pier Road", sortOrder: 0, createdAt: at(-88) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), kind: "Mass spec", model: "Xevo TQ-S micro", serial: "WX-TQS-4410",
      manufacturer: "Waters", ownerOrgId: meridian.id, status: "In service", location: "Bay 6", sortOrder: 0,
      forSale: true, saleNote: "Source rebuilt at intake", createdAt: at(-70) },
    { tenantOrgId: T, instrumentId: sid("CIS-1010"), kind: "Mass spec", model: "5977B MSD", serial: "US16290331",
      manufacturer: "Agilent", ownerOrgId: meridian.id, status: "In service", location: "Staged", sortOrder: 0, createdAt: at(-140) },
    { tenantOrgId: T, instrumentId: sid("CIS-1011"), kind: "Mass spec", model: "QTRAP 6500+", serial: "AB6500-1182",
      manufacturer: "Sciex", ownerOrgId: meridian.id, status: "Down", location: "Bay 6", sortOrder: 0,
      note: "Curtain plate assembly missing and discontinued", createdAt: at(-165) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), kind: "Other", model: "Avance NEO 400 console", serial: "BR-NEO-0219",
      manufacturer: "Bruker", ownerOrgId: ellison.id, status: "In service", location: "Magnet room", sortOrder: 0, createdAt: at(-45) },
    { tenantOrgId: T, instrumentId: sid("CIS-1013"), kind: "Other", model: "930 Compact IC Flex", serial: "MET930-8871",
      manufacturer: "Metrohm", ownerOrgId: harbor.id, status: "In service", location: "Pier Road", sortOrder: 0, createdAt: at(-410) },
    // Unattached: the shelf. A spare, a decommissioned donor, a loaner PC.
    { tenantOrgId: T, instrumentId: null, kind: "Vacuum pump", model: "nXDS15i", serial: "ED-NX-33112",
      manufacturer: "Edwards", status: "Spare", location: "Shelf C, shop", sortOrder: 0,
      note: "Rebuilt Mar - tip seals new", createdAt: at(-200) },
    { tenantOrgId: T, instrumentId: null, kind: "Computer", model: "Z2 Mini G9", serial: "HPZ2-99104",
      manufacturer: "HP", status: "Spare", location: "Shelf A, shop", sortOrder: 1,
      note: "Loaner - MassHunter imaged", createdAt: at(-150) },
    { tenantOrgId: T, instrumentId: null, kind: "Mass spec", model: "5975C MSD", serial: "US83221909",
      manufacturer: "Agilent", ownerOrgId: ellison.id, status: "Decommissioned", location: "Parts donor rack", sortOrder: 2,
      note: "Harvested from CIS-1000. Source and quads good.", createdAt: at(-58) },
    { tenantOrgId: T, instrumentId: null, kind: "Degasser", model: "1260 Degasser", serial: "DEG-1260-88",
      manufacturer: "Agilent", status: "Needs attention", location: "Shelf B, shop", sortOrder: 3,
      note: "Leaks under vacuum - triage before it goes back out", createdAt: at(-96) },
  ]).returning();
  const aid = (serial: string) => assetRows.find((a) => a.serial === serial)!.id;

  // A support unit that serves another unit rather than a system: the thing
  // ownership alone cannot express.
  const [n2gen] = await db.insert(assets).values({
    tenantOrgId: T, instrumentId: null, servesAssetId: aid("ISQ70-24118"), servesRole: "Carrier and collision gas",
    kind: "Other", model: "Genius XE 35", serial: "PK-XE35-2210", manufacturer: "Peak Scientific",
    ownerOrgId: ellison.id, status: "In service", location: "Bay 2 - under bench",
    note: "Filter due at 4,000 h", sortOrder: 4, createdAt: at(-38),
  }).returning();

  await db.insert(assetEvents).values([
    { assetId: aid("ISQ70-24118"), kind: "status", instrumentId: sid("CIS-1002"),
      detail: "In service -> Needs attention: turbo seized", actor: HOUSE.owen.email, at: at(-38) },
    { assetId: aid("ISQ70-24118"), kind: "note", instrumentId: sid("CIS-1002"),
      detail: "Replacement turbo fitted, backing pressure 2.1e-2 mbar and falling", actor: HOUSE.owen.email, at: at(-6) },
    { assetId: aid("US83221909"), kind: "removed", instrumentId: sid("CIS-1000"),
      detail: "Removed from CIS-1000 at decommissioning", actor: OWNER, at: at(-58) },
    { assetId: aid("US83221909"), kind: "status", detail: "In service -> Decommissioned", actor: OWNER, at: at(-58) },
    { assetId: aid("ED-NX-33112"), kind: "moved", detail: "Returned to Shelf C after the CIS-1004 loan", actor: HOUSE.tess.email, at: at(-40) },
    { assetId: n2gen.id, kind: "installed", instrumentId: sid("CIS-1002"),
      detail: "Plumbed to the ISQ as carrier and collision supply", actor: HOUSE.owen.email, at: at(-36) },
    { assetId: aid("JP18310042"), kind: "status", instrumentId: sid("CIS-1007"),
      detail: "In service -> Down: no plasma, RF board suspect", actor: HOUSE.tess.email, at: at(-52) },
  ]);

  // ── Who may look, who has it, whose move it is ───────────────────────────
  // Three different questions, three different tables. A client reads their
  // whole portal through the first one.
  await db.insert(systemShares).values(
    sysRows.filter((r) => r.ownerOrgId).map((r) => ({
      instrumentId: r.id, orgId: r.ownerOrgId!, access: "edit", addedBy: OWNER, createdAt: r.createdAt,
    })),
  ).onConflictDoNothing();
  // The provider's single window: one system, view only, because the magnet
  // work is theirs and nothing else on the instance is.
  await db.insert(systemShares).values({
    instrumentId: sid("CIS-1012"), orgId: vantage.id, access: "edit", addedBy: OWNER, createdAt: at(-8),
  }).onConflictDoNothing();
  await db.insert(assetShares).values({
    assetId: n2gen.id, orgId: ellison.id, access: "view", addedBy: OWNER, createdAt: at(-30),
  }).onConflictDoNothing();

  await db.insert(custodyEvents).values([
    { instrumentId: sid("CIS-1002"), kind: "transfer", fromOrgId: ellison.id, toOrgId: T,
      fromName: "Ellison BioLabs", toName: ORG_NAME, actor: HOUSE.owen.email, at: at(-38),
      note: "Collected from Hillsboro for bench work." },
    { instrumentId: sid("CIS-1014"), kind: "transfer", fromOrgId: T, toOrgId: ellison.id,
      fromName: ORG_NAME, toName: "Ellison BioLabs", actor: HOUSE.tess.email, at: at(-16),
      note: "Delivered, installed and demonstrated. Warranty starts today." },
    { assetId: aid("US83221909"), kind: "transfer", fromOrgId: ellison.id, toOrgId: T,
      fromName: "Ellison BioLabs", toName: ORG_NAME, actor: OWNER, at: at(-58),
      note: "Client released the retired MSD to us as a parts donor." },
  ]);

  await db.insert(queueEvents).values([
    { instrumentId: sid("CIS-1012"), fromOrgId: null, toOrgId: vantage.id, fromName: ORG_NAME,
      toName: "Vantage Scientific", reason: "Magnet shim and cryogen fill are their scope.",
      actor: HOUSE.tess.email, at: at(-6) },
    { instrumentId: sid("CIS-1003"), fromOrgId: null, toOrgId: ellison.id, fromName: ORG_NAME,
      toName: "Ellison BioLabs", reason: "OQ packet with QA for counter-signature.",
      actor: HOUSE.priya.email, at: at(-14) },
    { instrumentId: sid("CIS-1003"), fromOrgId: ellison.id, toOrgId: null, fromName: "Ellison BioLabs",
      toName: ORG_NAME, reason: "QA returned it with one comment on the pressure trace.",
      actor: "rita@ellisonbio.example", at: at(-4) },
  ]);
  // Ellison's queue entry has to match the events above.
  await db.update(instruments).set({
    queueOrgId: null, queueSince: at(-4),
    queueReason: "QA's comment on the pressure trace is ours to answer.",
  }).where(eq(instruments.id, sid("CIS-1003")));

  // Somebody asking to be let in, and somebody claiming a machine is theirs.
  await db.insert(accessRequests).values([
    { instrumentId: sid("CIS-1009"), orgId: harbor.id, kind: "access", requestedBy: "sam@northharbor.example",
      message: "We are looking at this Xevo. Can we see the checkout data before we commit?",
      status: "pending", createdAt: at(-2) },
    { instrumentId: sid("CIS-1013"), orgId: harbor.id, kind: "claim", requestedBy: "sam@northharbor.example",
      message: "This IC is ours - it came over with the Astoria acquisition.",
      status: "approved", decidedBy: OWNER, decidedAt: at(-38), createdAt: at(-40) },
  ]);

  // ── The procedure library ────────────────────────────────────────────────
  // What this shop knows how to do, by asset type. Tasks and tests, some that
  // run at intake, some on a clock, some scoped to one model - and the parts
  // and checklist each one carries onto every task it makes.
  section("Procedures, maintenance and work");
  const proc = await db.insert(procedures).values([
    { tenantOrgId: T, assetType: "system", kind: "task", name: "Incoming inspection and photographs",
      notes: "Every system, on arrival, before anything is unpacked further.", position: 0, runsAtIntake: true,
      required: true, checklist: "Photograph all six faces\nRecord serials from the plates\nNote shipping damage\nInventory the crate against the packing list",
      createdAt: at(-400) },
    { tenantOrgId: T, assetType: "system", kind: "test", name: "Leak check", notes: "", position: 1,
      runsAtIntake: true, required: true, needsReport: true, resultType: "measured", target: "2.0e-2 mbar",
      tolerancePct: "15", acceptance: "Backing pressure at or below target after 30 min", createdAt: at(-400) },
    { tenantOrgId: T, assetType: "system", kind: "test", name: "Electrical safety (PAT)", position: 2,
      runsAtIntake: true, resultType: "pass_fail", acceptance: "Earth bond < 0.1 ohm, insulation > 1 Mohm",
      required: true, needsReport: true, qualification: "IQ", createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Mass spec", kind: "task", name: "Quarterly source clean", position: 0,
      intervalDays: 90, requiresNote: true, consumesPart: true,
      parts: JSON.stringify([{ name: "Source cleaning kit", number: "G1946-80001" }]),
      checklist: "Vent and cool\nRemove source assembly\nBead blast the cone\nSonicate 15 min in 50:50 MeOH:water\nDry and reassemble\nPump down overnight",
      createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Mass spec", kind: "test", name: "Reserpine sensitivity", position: 1,
      resultType: "measured", target: "50000", tolerancePct: "20", needsReport: true, required: true,
      acceptance: "Peak area for 1 pg on column, MRM 609>195", qualification: "OQ", createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Mass spec", kind: "task", name: "Desolvation line replacement", position: 2,
      intervalDays: 365, modelScope: ["LCMS-8060NX"],
      parts: JSON.stringify([{ name: "Desolvation line", number: "221-48601", qty: 1 }]), createdAt: at(-395) },
    { tenantOrgId: T, assetType: "Pump", kind: "task", name: "Plunger seal replacement", position: 0,
      intervalDays: 180, consumesPart: true,
      parts: JSON.stringify([
        { name: "Seal kit, analytical", number: "5063-6589", qty: 2, models: ["1290 Infinity II Flex"] },
        { name: "Seal kit, LC-40", number: "228-45703-91", qty: 2, models: ["Nexera LC-40D X3"] },
      ]),
      checklist: "Purge to water\nRemove pump heads\nInspect plungers for scoring\nFit new seals\nRun in at 5 mL/min for 20 min\nPressure test to 600 bar",
      createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Pump", kind: "test", name: "Flow accuracy", position: 1, resultType: "measured",
      target: "1.000 mL/min", tolerancePct: "2", acceptance: "Gravimetric, 5 min collection", required: true,
      needsReport: true, qualification: "OQ", createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Autosampler", kind: "task", name: "Needle and seat inspection", position: 0,
      runsAtIntake: true, checklist: "Inspect needle tip\nCheck seat for scoring\nRe-teach positions\nCarryover blank", createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Autosampler", kind: "test", name: "Injection precision", position: 1,
      resultType: "measured", target: "0.5", tolerancePct: "50", acceptance: "%RSD over 6 injections, caffeine standard",
      needsReport: true, createdAt: at(-400) },
    { tenantOrgId: T, assetType: "GC", kind: "task", name: "Inlet maintenance", position: 0, intervalDays: 120,
      parts: JSON.stringify([{ name: "Inlet liner, split/splitless", number: "5190-2293" }, { name: "Septa, 11 mm", number: "5188-5365" }]),
      createdAt: at(-400) },
    { tenantOrgId: T, assetType: "Vacuum pump", kind: "task", name: "Tip seal service", position: 0,
      intervalDays: 365, usageEvery: 8000, usageUnit: "hours",
      parts: JSON.stringify([{ name: "nXDS tip seal kit", number: "ED-A72401" }]), createdAt: at(-398) },
    { tenantOrgId: T, assetType: "Column oven", kind: "test", name: "Temperature accuracy", position: 0,
      resultType: "measured", target: "40.0 C", tolerancePct: "2", needsReport: true, qualification: "OQ",
      createdAt: at(-398) },
    { tenantOrgId: T, assetType: "Detector", kind: "test", name: "Wavelength accuracy", position: 0,
      resultType: "reading", target: "656.1 nm", acceptance: "Deuterium emission line", needsReport: true,
      qualification: "OQ", createdAt: at(-398) },
    { tenantOrgId: T, assetType: "system", kind: "task", name: "Client familiarisation", position: 3,
      notes: "An hour at the bench with whoever will run it.", provenance: "Added after the Ellison install",
      createdAt: at(-180) },
  ]).returning();
  const pr = (name: string) => proc.find((p) => p.name === name)!.id;

  // Maintenance, in every state the queue can be in: overdue, due this week,
  // far off, paused, and one already booked with the client.
  const pms = await db.insert(pmSchedules).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1005"), title: "Annual PM - residual solvents GC",
      body: "Inlet, jet, and a full column-oven verification.", assignee: HOUSE.owen.name, everyDays: 365,
      nextDue: day(-21), lastDone: day(-386), procedureId: pr("Inlet maintenance"),
      partName: "Inlet liner, split/splitless", partNumber: "5190-2293",
      createdBy: OWNER, createdAt: at(-386) },
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), title: "Semi-annual seal service - QC UPLC",
      assignee: HOUSE.tess.name, everyDays: 180, nextDue: day(4), lastDone: day(-176),
      procedureId: pr("Plunger seal replacement"),
      parts: JSON.stringify([{ name: "Seal kit, analytical", number: "5063-6589", qty: 2 }]),
      bookedOn: day(4), bookedNote: "Per R. Alvarez - window 9 to 12, badge at the north lobby.",
      createdBy: OWNER, createdAt: at(-176) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), title: "Annual desolvation line swap",
      assignee: HOUSE.priya.name, everyDays: 365, nextDue: day(212), lastDone: day(-153),
      procedureId: pr("Desolvation line replacement"), partName: "Desolvation line", partNumber: "221-48601",
      createdBy: OWNER, createdAt: at(-153) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), title: "Quarterly source clean",
      assignee: HOUSE.tess.name, everyDays: 90, nextDue: day(11), lastDone: day(-79),
      procedureId: pr("Quarterly source clean"),
      checklist: "Vent and cool\nRemove source assembly\nBead blast the cone\nSonicate 15 min\nDry and reassemble",
      createdBy: OWNER, createdAt: at(-79) },
    { tenantOrgId: T, instrumentId: sid("CIS-1013"), title: "Suppressor and eluent service",
      assignee: HOUSE.owen.name, everyDays: 180, nextDue: day(58), lastDone: day(-122),
      createdBy: OWNER, createdAt: at(-300) },
    // Paused, with the reason in the title's neighbourhood: the unit is stock,
    // and a reseller's calendar is advisory (lib/pmPosture).
    { tenantOrgId: T, instrumentId: sid("CIS-1011"), title: "Annual source rebuild",
      assignee: "", everyDays: 365, nextDue: day(-96), lastDone: "", paused: true,
      createdBy: OWNER, createdAt: at(-165) },
    { tenantOrgId: T, assetId: aid("ED-NX-33112"), title: "Tip seal service - shelf spare",
      assignee: HOUSE.owen.name, everyDays: 365, nextDue: day(74), lastDone: day(-291),
      procedureId: pr("Tip seal service"), partName: "nXDS tip seal kit", partNumber: "ED-A72401",
      createdBy: OWNER, createdAt: at(-291) },
  ]).returning();
  const pm = (title: string) => pms.find((p) => p.title.startsWith(title))!.id;

  // ── Work orders ──────────────────────────────────────────────────────────
  // All six states and all four severities, so the board, the ageing rule and
  // the "what is late" colouring all have something to be right about.
  const wos = await db.insert(workOrders).values([
    { tenantOrgId: T, number: "WO-2041", instrumentId: sid("CIS-1007"), orgId: harbor.id,
      title: "No plasma - RF generator fault", body: "Ignition fails at 1200 W. No fault code, no RF forward power.",
      severity: "Down", state: "waiting", assignee: HOUSE.tess.name, openedOn: day(-52),
      requestedBy: "Sam Okafor", requestedByEmail: "sam@northharbor.example", origin: "client",
      createdAt: at(-52) },
    { tenantOrgId: T, number: "WO-2042", instrumentId: sid("CIS-1002"), orgId: ellison.id,
      title: "Replace turbo and recertify vacuum", body: "Turbo seized. Replace, leak check, and recertify before it goes back.",
      severity: "Down", state: "active", assignee: HOUSE.owen.name, openedOn: day(-38),
      requestedBy: "Rita Alvarez", requestedByEmail: "rita@ellisonbio.example", origin: "client",
      createdAt: at(-38) },
    { tenantOrgId: T, number: "WO-2043", instrumentId: sid("CIS-1001"), orgId: ellison.id,
      title: "Checkout and release - bioanalysis triple quad",
      body: "Full checkout to the OQ protocol, then release.", severity: "Planned",
      state: "open", assignee: HOUSE.tess.name, openedOn: day(-7), requestedBy: "Rita Alvarez",
      requestedByEmail: "rita@ellisonbio.example", origin: "internal", createdAt: at(-7) },
    { tenantOrgId: T, number: "WO-2044", instrumentId: sid("CIS-1005"), orgId: ellison.id,
      title: "Annual PM - Bend annex GC", body: "Inlet service, jet clean, oven verification.",
      severity: "Planned", state: "open", assignee: HOUSE.owen.name, openedOn: day(-21),
      requestedBy: "Marcus Doyle", requestedByEmail: "marcus@ellisonbio.example", origin: "pm",
      createdAt: at(-21) },
    { tenantOrgId: T, number: "WO-2045", instrumentId: sid("CIS-1008"), orgId: harbor.id,
      title: "PFAS panel - method transfer", body: "Transfer the client's PFAS method and demonstrate it on their column set.",
      severity: "Question", state: "resolved", assignee: HOUSE.priya.name, openedOn: day(-30),
      requestedBy: "Sam Okafor", requestedByEmail: "sam@northharbor.example", origin: "client",
      resolvedAt: at(-3), closeSummary: "Method running. Their chemist reproduced it unaided on the second attempt.",
      createdAt: at(-30) },
    { tenantOrgId: T, number: "WO-2046", instrumentId: sid("CIS-1014"), orgId: ellison.id,
      title: "Install and hand over prep LC", body: "", severity: "Planned", state: "closed",
      assignee: HOUSE.tess.name, openedOn: day(-24), requestedBy: "Rita Alvarez",
      requestedByEmail: "rita@ellisonbio.example", origin: "internal", closedBy: OWNER, closedAt: at(-16),
      resolvedAt: at(-16), closeSummary: "Installed, IQ signed, an hour of familiarisation with the QC team.",
      createdAt: at(-24) },
    { tenantOrgId: T, number: "WO-2047", instrumentId: sid("CIS-1004"), orgId: ellison.id,
      title: "Pressure ripple on channel B", body: "Ripple to 12 bar at 0.4 mL/min. Seals or check valves.",
      severity: "Degraded", state: "closed", assignee: HOUSE.tess.name, openedOn: day(-19),
      requestedBy: "Rita Alvarez", requestedByEmail: "rita@ellisonbio.example", origin: "client",
      closedBy: OWNER, closedAt: at(-12), resolvedAt: at(-13),
      closeSummary: "Outlet check valve replaced. Ripple under 1 bar across the range.", createdAt: at(-19) },
    { tenantOrgId: T, number: "WO-2048", instrumentId: sid("CIS-1006"), orgId: harbor.id,
      title: "Intake inspection and refurbishment quote", body: "", severity: "Planned", state: "waiting",
      assignee: HOUSE.owen.name, openedOn: day(-9), requestedBy: "Sam Okafor",
      requestedByEmail: "sam@northharbor.example", origin: "internal", createdAt: at(-9) },
    { tenantOrgId: T, number: "WO-2049", instrumentId: sid("CIS-1011"), orgId: meridian.id,
      title: "Source curtain plate - sourcing", body: "Assembly discontinued. Find a substitute or a good used one.",
      severity: "Degraded", state: "waiting", assignee: HOUSE.owen.name, openedOn: day(-46),
      requestedBy: "Jules Ferrand", requestedByEmail: "jules@meridianexchange.example", origin: "client",
      createdAt: at(-46) },
    { tenantOrgId: T, number: "WO-2050", instrumentId: sid("CIS-1009"), orgId: meridian.id,
      title: "Refurbish and checkout for resale", body: "", severity: "Planned", state: "active",
      assignee: HOUSE.owen.name, openedOn: day(-70), requestedBy: "Jules Ferrand",
      requestedByEmail: "jules@meridianexchange.example", origin: "client", createdAt: at(-70) },
    { tenantOrgId: T, number: "WO-2051", instrumentId: sid("CIS-1012"), orgId: ellison.id,
      title: "NMR bring-up - console and shim", body: "Console ours, magnet work with Vantage.",
      severity: "Planned", state: "waiting", assignee: HOUSE.tess.name, openedOn: day(-45),
      requestedBy: "Rita Alvarez", requestedByEmail: "rita@ellisonbio.example", origin: "internal",
      createdAt: at(-45) },
    // A job that was raised and then withdrawn - the sixth state, and the one
    // that has to be visible somewhere or nobody believes it exists.
    { tenantOrgId: T, number: "WO-2052", instrumentId: sid("CIS-1013"), orgId: harbor.id,
      title: "Suppressor replacement", body: "", severity: "Degraded", state: "cancelled",
      assignee: "", openedOn: day(-26), requestedBy: "Sam Okafor",
      requestedByEmail: "sam@northharbor.example", origin: "client", closedBy: OWNER, closedAt: at(-24),
      closeSummary: "Withdrawn - the baseline settled after a proper regeneration. Nothing was wrong.",
      createdAt: at(-26) },
    // Off-system: a job with no instrument behind it, which the phone-support
    // client is the whole reason for.
    { tenantOrgId: T, number: "WO-2053", instrumentId: null, orgId: keystone.id,
      title: "Method advice - headspace carryover", body: "Their chemist has carryover on a headspace method.",
      severity: "Question", state: "closed", assignee: HOUSE.priya.name, openedOn: day(-5),
      requestedBy: "Nadia Brant", requestedByEmail: "nadia@keystonebio.example", origin: "client",
      closedBy: HOUSE.priya.email, closedAt: at(-4), resolvedAt: at(-4),
      closeSummary: "Loop temperature was below the transfer line. Advised a 10 C step and a longer bake.",
      createdAt: at(-5) },
  ]).returning();
  const wo = (n: string) => wos.find((w) => w.number === n)!.id;

  await db.insert(workOrderNotes).values([
    { workOrderId: wo("WO-2041"), author: HOUSE.tess.name, authorEmail: HOUSE.tess.email,
      text: "Swapped the RF coil and re-seated the interface board. Still no forward power - the generator itself is the fault.", createdAt: at(-48) },
    { workOrderId: wo("WO-2041"), author: HOUSE.dana.name, authorEmail: HOUSE.dana.email,
      text: "Agilent have it on backorder. I have a weekly chase on the calendar.", createdAt: at(-12) },
    { workOrderId: wo("WO-2042"), author: HOUSE.owen.name, authorEmail: HOUSE.owen.email,
      text: "New turbo at speed. Backing 2.1e-2 mbar and falling; foreline joints all tight on the sniffer.", createdAt: at(-6) },
    { workOrderId: wo("WO-2042"), author: HOUSE.owen.name, authorEmail: HOUSE.owen.email,
      text: "Left it pumping overnight. Will tune on cal gas once base pressure holds.",
      editedAt: at(-5, 19), createdAt: at(-5) },
    { workOrderId: wo("WO-2047"), author: HOUSE.tess.name, authorEmail: HOUSE.tess.email,
      text: "Outlet check valve was the culprit - it looked fine and tested badly.", createdAt: at(-13) },
    { workOrderId: wo("WO-2050"), author: HOUSE.owen.name, authorEmail: HOUSE.owen.email,
      text: "Source rebuilt, ion block replaced. Sensitivity is inside spec on reserpine.", createdAt: at(-20) },
    { workOrderId: wo("WO-2053"), author: HOUSE.priya.name, authorEmail: HOUSE.priya.email,
      text: "Twenty minutes on the phone. Nothing of theirs is with us - logging it so the visit is on their report.", createdAt: at(-4) },
  ]);

  // ── Tasks ────────────────────────────────────────────────────────────────
  section("Tasks, checklists and recorded results");
  const tk = await db.insert(tasks).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), workOrderId: wo("WO-2043"), assetId: aid("US24071104"),
      title: "Reserpine sensitivity", body: "1 pg on column, MRM 609>195. Three replicates.", state: "Done",
      assignee: HOUSE.tess.name, dueDate: day(-2), origin: "procedure", procedureId: pr("Reserpine sensitivity"),
      resultType: "measured", sortOrder: 0, createdAt: at(-7), completedAt: at(-2, 21) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), workOrderId: wo("WO-2043"),
      title: "Carryover study", body: "Blank after the top standard, five times.", state: "In progress",
      assignee: HOUSE.tess.name, dueDate: day(1), origin: "internal", sortOrder: 1, createdAt: at(-6) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), workOrderId: wo("WO-2043"),
      title: "Client familiarisation", body: "An hour at the bench with whoever will run it.", state: "Open",
      assignee: HOUSE.priya.name, dueDate: day(6), origin: "procedure",
      procedureId: pr("Client familiarisation"), sortOrder: 2, createdAt: at(-6) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"), assetId: aid("ISQ70-24118"),
      title: "Fit replacement turbo", body: "", state: "Done", assignee: HOUSE.owen.name, dueDate: day(-7),
      origin: "internal", sortOrder: 0, createdAt: at(-38), completedAt: at(-6, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"),
      title: "Leak check", body: "30 minutes at base pressure.", state: "Done", assignee: HOUSE.owen.name,
      origin: "procedure", procedureId: pr("Leak check"), resultType: "measured", sortOrder: 1,
      createdAt: at(-38), completedAt: at(-5, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"),
      title: "Cal gas tune", body: "Once base pressure holds overnight.", state: "In progress",
      assignee: HOUSE.owen.name, dueDate: day(0), origin: "internal", sortOrder: 2, createdAt: at(-5) },
    { tenantOrgId: T, instrumentId: sid("CIS-1007"), workOrderId: wo("WO-2041"), assetId: aid("JP18310042"),
      title: "Replace RF generator board", body: "PN G3280-65010. Ordered, backordered.", state: "Blocked",
      assignee: HOUSE.tess.name, origin: "internal", sortOrder: 0, createdAt: at(-50) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), workOrderId: wo("WO-2048"),
      title: "Incoming inspection and photographs", body: "", state: "Done", assignee: HOUSE.owen.name,
      origin: "procedure", procedureId: pr("Incoming inspection and photographs"), sortOrder: 0,
      createdAt: at(-9), completedAt: at(-8, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), workOrderId: wo("WO-2048"),
      title: "Electrical safety (PAT)", body: "", state: "Done", assignee: HOUSE.owen.name,
      origin: "procedure", procedureId: pr("Electrical safety (PAT)"), resultType: "pass_fail",
      sortOrder: 1, createdAt: at(-9), completedAt: at(-8, 21) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), workOrderId: wo("WO-2048"),
      title: "Price the refurbishment", body: "Torch box, purge line, and whatever the plasma test finds.",
      state: "Open", assignee: OWNER, dueDate: day(2), origin: "internal", sortOrder: 2, createdAt: at(-8) },
    { tenantOrgId: T, instrumentId: sid("CIS-1005"), workOrderId: wo("WO-2044"), pmScheduleId: pm("Annual PM"),
      title: "Inlet maintenance", body: "Liner, septum, gold seal.", state: "Open", assignee: HOUSE.owen.name,
      dueDate: day(-21), origin: "pm", procedureId: pr("Inlet maintenance"), sortOrder: 0, createdAt: at(-21) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), title: "Answer QA on the pressure trace",
      body: "They want the 8 bar step at 14 minutes explained before they counter-sign.",
      state: "In progress", assignee: HOUSE.priya.name, dueDate: day(1), origin: "client",
      sortOrder: 0, createdAt: at(-4) },
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), workOrderId: wo("WO-2047"),
      title: "Flow accuracy", body: "", state: "Done", assignee: HOUSE.tess.name, origin: "procedure",
      procedureId: pr("Flow accuracy"), resultType: "measured", sortOrder: 0,
      createdAt: at(-19), completedAt: at(-13, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), workOrderId: wo("WO-2050"),
      title: "Source rebuild", body: "", state: "Done", assignee: HOUSE.owen.name, origin: "internal",
      sortOrder: 0, createdAt: at(-70), completedAt: at(-20, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), workOrderId: wo("WO-2050"),
      title: "Injection precision", body: "", state: "Done", assignee: HOUSE.owen.name, origin: "procedure",
      procedureId: pr("Injection precision"), resultType: "measured", sortOrder: 1,
      createdAt: at(-70), completedAt: at(-18, 19) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), workOrderId: wo("WO-2050"),
      title: "Photograph for the listing", body: "Six faces plus the source open.", state: "Open",
      assignee: HOUSE.owen.name, dueDate: day(3), origin: "internal", sortOrder: 2, createdAt: at(-12) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), workOrderId: wo("WO-2051"),
      title: "Console bring-up", body: "", state: "Done", assignee: HOUSE.tess.name, origin: "internal",
      sortOrder: 0, createdAt: at(-45), completedAt: at(-7, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), workOrderId: wo("WO-2051"),
      title: "Magnet shim and cryogen fill", body: "Vantage's scope - booked for the 14th.", state: "Blocked",
      assignee: "", origin: "internal", sortOrder: 1, createdAt: at(-7) },
    // Unassigned and undated, because half of any real list is.
    { tenantOrgId: T, instrumentId: sid("CIS-1011"), workOrderId: wo("WO-2049"),
      title: "Chase the curtain plate substitutes", body: "Two candidates. Neither vendor will confirm the fit.",
      state: "Blocked", assignee: "", origin: "internal", sortOrder: 0, createdAt: at(-46) },
  ]).returning();
  const task = (title: string, instr?: string) =>
    tk.find((t) => t.title === title && (!instr || t.instrumentId === sid(instr)))!;

  // Checklists, with a heading in one of them - the shape a fourteen-step
  // teardown actually has when somebody pastes it out of an SOP.
  const cl = await db.insert(checklistItems).values([
    { taskId: task("Fit replacement turbo").id, text: "Vent the manifold", done: true, sortOrder: 0 },
    { taskId: task("Fit replacement turbo").id, text: "Disconnect the foreline and controller", done: true, sortOrder: 1 },
    { taskId: task("Fit replacement turbo").id, text: "Fit the new turbo, torque to 8 Nm crosswise", done: true, sortOrder: 2 },
    { taskId: task("Fit replacement turbo").id, text: "New centring ring and clamp", done: true, sortOrder: 3 },
    { taskId: task("Fit replacement turbo").id, text: "Pump down and log the curve", done: true, sortOrder: 4 },
    { taskId: task("Carryover study").id, text: "Sample sequence", heading: true, done: false, sortOrder: 0 },
    { taskId: task("Carryover study").id, text: "Top standard, 1000 ng/mL", done: true, sortOrder: 1 },
    { taskId: task("Carryover study").id, text: "Blank x5 immediately after", done: true, sortOrder: 2 },
    { taskId: task("Carryover study").id, text: "Acceptance", heading: true, done: false, sortOrder: 3 },
    { taskId: task("Carryover study").id, text: "Blank 1 below 0.1% of the top standard", done: false, sortOrder: 4 },
    { taskId: task("Carryover study").id, text: "Blanks 2-5 below the LLOQ", done: false, sortOrder: 5 },
    { taskId: task("Inlet maintenance").id, text: "New liner and O-ring", done: false, sortOrder: 0 },
    { taskId: task("Inlet maintenance").id, text: "New septum", done: false, sortOrder: 1 },
    { taskId: task("Inlet maintenance").id, text: "Gold seal and washer", done: false, sortOrder: 2 },
    { taskId: task("Inlet maintenance").id, text: "Leak check the inlet to 25 psi", done: false, sortOrder: 3 },
    { taskId: task("Inlet maintenance").id, text: "Bake out 30 min at 300 C", done: false, sortOrder: 4 },
    { taskId: task("Incoming inspection and photographs").id, text: "Photograph all six faces", done: true, sortOrder: 0 },
    { taskId: task("Incoming inspection and photographs").id, text: "Record serials from the plates", done: true, sortOrder: 1 },
    { taskId: task("Incoming inspection and photographs").id, text: "Note shipping damage", done: true, sortOrder: 2 },
    { taskId: task("Incoming inspection and photographs").id, text: "Inventory the crate against the packing list", done: true, sortOrder: 3 },
    { taskId: task("Source rebuild").id, text: "Strip and bead-blast the cone", done: true, sortOrder: 0 },
    { taskId: task("Source rebuild").id, text: "Replace the ion block", done: true, sortOrder: 1 },
    { taskId: task("Source rebuild").id, text: "Reassemble with new seals", done: true, sortOrder: 2 },
  ]).returning();

  await db.insert(itemNotes).values([
    { itemId: cl.find((c) => c.text.startsWith("Note shipping damage"))!.id, author: HOUSE.owen.name,
      text: "Dent in the left side panel, about 40 mm. Photographed. Cosmetic - nothing behind it is touching.",
      createdAt: at(-8, 20) },
    { itemId: cl.find((c) => c.text.startsWith("Inventory the crate"))!.id, author: HOUSE.owen.name,
      text: "Torch box and purge line are not in the crate. Flagged to Sam; they are checking their shipper.",
      createdAt: at(-8, 21) },
    { itemId: cl.find((c) => c.text.startsWith("Pump down and log"))!.id, author: HOUSE.owen.name,
      text: "2.1e-2 mbar at 30 min, still falling. Curve saved with the job.", createdAt: at(-6, 22) },
  ]);

  await db.insert(taskNotes).values([
    { taskId: task("Replace RF generator board").id, author: HOUSE.tess.name,
      text: "Board ordered on the 12th. Agilent have no ETA - @dana is chasing weekly.", createdAt: at(-50) },
    { taskId: task("Replace RF generator board").id, author: HOUSE.dana.name,
      text: "Chased again today. Still nothing. Asked about a rebuilt exchange unit.", createdAt: at(-5) },
    { taskId: task("Carryover study").id, author: HOUSE.tess.name,
      text: "Blank 1 came in at 0.14% - over. Re-running with a longer needle wash.", createdAt: at(-1, 20) },
    { taskId: task("Answer QA on the pressure trace").id, author: HOUSE.priya.name,
      text: "The step is the column-switching valve at the gradient hold. Expected, documented in the method. Writing it up.",
      createdAt: at(-3) },
    { taskId: task("Chase the curtain plate substitutes").id, author: HOUSE.owen.name,
      text: "Vendor A will not confirm the fit without the assembly in hand. Vendor B has one used, no returns.",
      createdAt: at(-9) },
  ]);

  // Recorded results: every result type, and one deliberate failure so the
  // sign-off gate has something real to refuse.
  await db.insert(taskResults).values([
    { taskId: task("Reserpine sensitivity").id, resultType: "measured", value: "61,400 counts", passed: true,
      target: "50000", tolerancePct: "20", acceptance: "Peak area for 1 pg on column, MRM 609>195",
      note: "Mean of three. Best of the three sources we have tried on this instrument.",
      recordedBy: HOUSE.tess.email, recordedAt: at(-2, 21) },
    { taskId: task("Leak check", "CIS-1002").id, resultType: "measured", value: "2.1e-2 mbar", passed: true,
      target: "2.0e-2 mbar", tolerancePct: "15", acceptance: "At or below target after 30 min",
      note: "Still falling when the reading was taken.", recordedBy: HOUSE.owen.email, recordedAt: at(-5, 22) },
    { taskId: task("Electrical safety (PAT)").id, resultType: "pass_fail", value: "Pass", passed: true,
      acceptance: "Earth bond < 0.1 ohm, insulation > 1 Mohm", note: "0.04 ohm / >100 Mohm.",
      recordedBy: HOUSE.owen.email, recordedAt: at(-8, 21) },
    { taskId: task("Flow accuracy").id, resultType: "measured", value: "0.994 mL/min", passed: true,
      target: "1.000 mL/min", tolerancePct: "2", acceptance: "Gravimetric, 5 min collection",
      recordedBy: HOUSE.tess.email, recordedAt: at(-13, 20) },
    { taskId: task("Injection precision").id, resultType: "measured", value: "0.31 %RSD", passed: true,
      target: "0.5", tolerancePct: "50", acceptance: "Six injections, caffeine standard",
      recordedBy: HOUSE.owen.email, recordedAt: at(-18, 19) },
    { taskId: task("Console bring-up").id, resultType: "note",
      value: "Console boots, locks on the lock channel, RF amplifiers within spec.",
      note: "Nothing to measure yet - the magnet is not shimmed.", recordedBy: HOUSE.tess.email, recordedAt: at(-7, 20) },
  ]);

  // ── Hours and visits ─────────────────────────────────────────────────────
  await db.insert(serviceVisits).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), day: day(4), title: "Semi-annual seal service",
      namedBy: OWNER, createdAt: at(-6) },
    { tenantOrgId: T, instrumentId: sid("CIS-1005"), day: day(9), title: "Annual PM - Bend annex",
      namedBy: HOUSE.owen.email, createdAt: at(-3) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), day: day(14), title: "Vantage - magnet shim and fill",
      namedBy: HOUSE.tess.email, createdAt: at(-6) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), day: day(6), title: "Client familiarisation",
      namedBy: HOUSE.priya.email, createdAt: at(-6) },
    { tenantOrgId: T, instrumentId: sid("CIS-1014"), day: day(-16), title: "Install and hand over",
      namedBy: HOUSE.tess.email, createdAt: at(-24) },
  ]);

  await db.insert(timeEntries).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"), assetId: aid("ISQ70-24118"),
      person: HOUSE.owen.name, date: day(-7), minutes: 430, note: "Turbo replacement",
      loggedBy: HOUSE.owen.email, billable: true, category: "onsite", createdAt: at(-7, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"),
      person: HOUSE.owen.name, date: day(-6), minutes: 240, note: "Pump-down watch and leak check",
      loggedBy: HOUSE.owen.email, billable: true, category: "onsite", createdAt: at(-6, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"),
      person: HOUSE.owen.name, date: day(-5), minutes: 90, note: "Second pass on the tune - ours to absorb",
      loggedBy: HOUSE.owen.email, billable: false, category: "onsite", createdAt: at(-5, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), workOrderId: wo("WO-2047"),
      person: HOUSE.tess.name, date: day(-13), minutes: 195, note: "Diagnose and replace outlet check valve",
      loggedBy: HOUSE.tess.email, billable: true, category: "onsite", createdAt: at(-13, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1004"), workOrderId: wo("WO-2047"),
      person: HOUSE.tess.name, date: day(-13), minutes: 55, note: "Drive to Hillsboro and back",
      loggedBy: HOUSE.tess.email, billable: true, category: "travel", createdAt: at(-13, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1008"), workOrderId: wo("WO-2045"),
      person: HOUSE.priya.name, date: day(-6), minutes: 300, note: "PFAS method transfer, day one",
      loggedBy: HOUSE.priya.email, billable: true, category: "onsite", createdAt: at(-6, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1008"), workOrderId: wo("WO-2045"),
      person: HOUSE.priya.name, date: day(-3), minutes: 120, note: "Follow-up over screen share",
      loggedBy: HOUSE.priya.email, billable: true, category: "remote", createdAt: at(-3, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1014"), workOrderId: wo("WO-2046"),
      person: HOUSE.tess.name, date: day(-16), minutes: 480, note: "Install, IQ, familiarisation",
      loggedBy: HOUSE.tess.email, billable: true, category: "onsite", createdAt: at(-16, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), workOrderId: wo("WO-2050"),
      person: HOUSE.owen.name, date: day(-20), minutes: 510, note: "Source rebuild",
      loggedBy: HOUSE.owen.email, billable: true, category: "onsite", createdAt: at(-20, 23) },
    { tenantOrgId: T, instrumentId: null, workOrderId: wo("WO-2053"),
      person: HOUSE.priya.name, date: day(-5), minutes: 25, note: "Phone support - headspace carryover",
      loggedBy: HOUSE.priya.email, billable: true, category: "remote", createdAt: at(-5, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), workOrderId: wo("WO-2043"),
      person: HOUSE.tess.name, date: day(-2), minutes: 210, note: "Reserpine tune and verification",
      loggedBy: HOUSE.tess.email, billable: true, category: "onsite", createdAt: at(-2, 23) },
  ]);

  // ── The parts book ───────────────────────────────────────────────────────
  section("Parts catalog, prices, stock and purchasing");
  const cat = await db.insert(partCatalog).values([
    { tenantOrgId: T, partNumber: "5190-2293", name: "Inlet liner, split/splitless, ultra inert",
      manufacturer: "Agilent", mfrPartNumber: "5190-2293", kind: "consumable",
      assetTypes: ["GC", "Injector"], models: ["7890B", "TRACE 1310"], createdBy: OWNER, createdAt: at(-390) },
    { tenantOrgId: T, partNumber: "5188-5365", name: "Septa, 11 mm, advanced green, 50/pk",
      manufacturer: "Agilent", kind: "consumable", assetTypes: ["GC", "Injector"], models: ["7890B"],
      createdBy: OWNER, createdAt: at(-390) },
    { tenantOrgId: T, partNumber: "5063-6589", name: "Plunger seal kit, analytical head",
      manufacturer: "Agilent", kind: "kit", assetTypes: ["Pump"], models: ["1290 Infinity II Flex"],
      note: "Two per pump head. Run in at 5 mL/min before pressure testing.", createdBy: OWNER, createdAt: at(-390) },
    { tenantOrgId: T, partNumber: "221-48601", name: "Desolvation line, LCMS-8060",
      manufacturer: "Shimadzu", kind: "part", assetTypes: ["Mass spec"], models: ["LCMS-8060NX"],
      createdBy: OWNER, createdAt: at(-388) },
    { tenantOrgId: T, partNumber: "ED-A72401", name: "nXDS tip seal kit", manufacturer: "Edwards",
      kind: "kit", assetTypes: ["Vacuum pump"], models: ["nXDS15i"], createdBy: OWNER, createdAt: at(-388) },
    { tenantOrgId: T, partNumber: "G3280-65010", name: "RF generator board, 7700 series",
      manufacturer: "Agilent", kind: "part", assetTypes: ["Mass spec"], models: ["7700x"],
      note: "Long lead. Exchange units exist but Agilent will not always offer one.",
      createdBy: OWNER, createdAt: at(-52) },
    { tenantOrgId: T, partNumber: "G1946-80001", name: "Source cleaning kit", manufacturer: "Agilent",
      kind: "kit", assetTypes: ["Mass spec"], models: [], createdBy: OWNER, createdAt: at(-388) },
    { tenantOrgId: T, partNumber: "EXT255H", name: "Turbomolecular pump, EXT255H", manufacturer: "Edwards",
      kind: "part", assetTypes: ["Mass spec", "Vacuum pump"], models: ["ISQ 7000"], createdBy: OWNER, createdAt: at(-38) },
    { tenantOrgId: T, partNumber: "WAT271066", name: "ESI capillary", manufacturer: "Waters", kind: "part",
      assetTypes: ["Mass spec"], models: ["Xevo TQ-S micro"], createdBy: OWNER, createdAt: at(-70) },
    { tenantOrgId: T, partNumber: "SCX-CP-6500", name: "Curtain plate assembly, 6500 series",
      manufacturer: "Sciex", kind: "part", assetTypes: ["Mass spec"], models: ["QTRAP 6500+"],
      note: "DISCONTINUED. Substitutes under evaluation - neither confirmed.", createdBy: OWNER, createdAt: at(-46) },
    { tenantOrgId: T, partNumber: "PK-XE35-FLT", name: "Generator filter set, Genius XE 35",
      manufacturer: "Peak Scientific", kind: "consumable", assetTypes: ["Other"], models: ["Genius XE 35"],
      createdBy: OWNER, createdAt: at(-36) },
    { tenantOrgId: T, partNumber: "MET-SUP-930", name: "Suppressor module, 930 Compact IC",
      manufacturer: "Metrohm", kind: "part", assetTypes: ["Other"], models: ["930 Compact IC Flex"],
      archived: true, note: "Superseded by the MSM-HC. Kept for the history.",
      createdBy: OWNER, createdAt: at(-300) },
  ]).returning();
  const cid = (pn: string) => cat.find((c) => c.partNumber === pn)!.id;

  // The same part, called four things by four people. This is the table that
  // makes a serial number typed off a label find anything at all.
  await db.insert(partNumbers).values([
    { catalogId: cid("5190-2293"), kind: "oem", partNumber: "5190-2293", manufacturer: "Agilent", sortOrder: 0 },
    { catalogId: cid("5190-2293"), kind: "alt", partNumber: "23305A", manufacturer: "Restek",
      note: "Equivalent, tested here", sortOrder: 1 },
    { catalogId: cid("5190-2293"), kind: "superseded", partNumber: "5183-4647", manufacturer: "Agilent",
      note: "Pre-2019 liner, no longer supplied", sortOrder: 2 },
    { catalogId: cid("ED-A72401"), kind: "oem", partNumber: "A724-01-401", manufacturer: "Edwards", sortOrder: 0 },
    { catalogId: cid("EXT255H"), kind: "oem", partNumber: "B722-52-991", manufacturer: "Edwards", sortOrder: 0 },
    { catalogId: cid("G3280-65010"), kind: "exchange", partNumber: "G3280-69010", manufacturer: "Agilent",
      note: "Rebuilt exchange - core return required", sortOrder: 1 },
    { catalogId: cid("SCX-CP-6500"), kind: "alt", partNumber: "PC-6500-CP", manufacturer: "PhoenixParts",
      note: "Fit unconfirmed", sortOrder: 1 },
  ]);

  await db.insert(partKitLines).values([
    { kitId: cid("ED-A72401"), partNumber: "ED-A70501", name: "Tip seal, pair", qty: 2, sortOrder: 0 },
    { kitId: cid("ED-A72401"), partNumber: "ED-A70502", name: "O-ring set", qty: 1, sortOrder: 1 },
    { kitId: cid("ED-A72401"), partNumber: "ED-A70503", name: "Exhaust filter", qty: 1, sortOrder: 2 },
    { kitId: cid("5063-6589"), partNumber: "5063-6589-S", name: "Seal, PTFE", qty: 2, sortOrder: 0 },
    { kitId: cid("5063-6589"), partNumber: "0905-1175", name: "Wash seal", qty: 2, sortOrder: 1 },
    { kitId: cid("G1946-80001"), partNumber: "G1946-80002", name: "Abrasive, 12 micron", qty: 1, sortOrder: 0 },
    { kitId: cid("G1946-80001"), partNumber: "G1946-80003", name: "Polishing cloth, 10/pk", qty: 1, sortOrder: 1 },
  ]);

  const linerShot = await store("part-5190-2293.svg", "image/svg+xml",
    photo("Inlet liner", "5190-2293 · ultra inert", "#E7EFF7", "#1B3A5C"));
  const linerBox = await store("part-5190-2293-box.svg", "image/svg+xml",
    photo("Carton label", "Agilent 5190-2293", "#F2F5F8", "#1B3A5C"));
  const sealShot = await store("part-5063-6589.svg", "image/svg+xml",
    photo("Seal kit", "5063-6589 · analytical head", "#EAF3EC", "#22503A"));
  await db.insert(partPhotos).values([
    { catalogId: cid("5190-2293"), url: linerShot.url, caption: "The liner, out of the carton", sortOrder: 0, uploadedBy: OWNER, createdAt: at(-200) },
    { catalogId: cid("5190-2293"), url: linerBox.url, caption: "Carton label", sortOrder: 1, uploadedBy: OWNER, createdAt: at(-200) },
    { catalogId: cid("5063-6589"), url: sealShot.url, caption: "Kit contents", sortOrder: 0, uploadedBy: HOUSE.tess.email, createdAt: at(-150) },
  ]);

  // Vendor offers arranged so cheapest and fastest disagree - the whole reason
  // the sourcing panel exists.
  await db.insert(partPrices).values([
    { tenantOrgId: T, partNumber: "5190-2293", vendor: "Agilent", isOem: true, priceCents: 6400, leadDays: 2,
      dropShips: false, expediteOk: true, updatedBy: OWNER, updatedAt: at(-30), createdAt: at(-380) },
    { tenantOrgId: T, partNumber: "5190-2293", vendor: "Restek Direct", isOem: false, priceCents: 4150, leadDays: 4,
      dropShips: true, expediteOk: true, note: "Equivalent liner. Min order 5.",
      updatedBy: HOUSE.dana.email, updatedAt: at(-14), createdAt: at(-380) },
    { tenantOrgId: T, partNumber: "5188-5365", vendor: "Agilent", isOem: true, priceCents: 4200, leadDays: 2,
      dropShips: false, expediteOk: true, updatedBy: OWNER, updatedAt: at(-30), createdAt: at(-380) },
    { tenantOrgId: T, partNumber: "5063-6589", vendor: "Agilent", isOem: true, priceCents: 31500, leadDays: 3,
      dropShips: false, expediteOk: true, updatedBy: OWNER, updatedAt: at(-45), createdAt: at(-380) },
    { tenantOrgId: T, partNumber: "ED-A72401", vendor: "Edwards", isOem: true, priceCents: 23500, leadDays: 10,
      dropShips: false, expediteOk: false, updatedBy: OWNER,
      // Nobody has confirmed this in four months, which is what the stale pill is for.
      updatedAt: at(-128), createdAt: at(-380) },
    { tenantOrgId: T, partNumber: "ED-A72401", vendor: "Vacuum Spares Co", isOem: false, priceCents: 19900,
      leadDays: 3, dropShips: true, expediteOk: true, note: "Aftermarket seals; we have used them twice.",
      updatedBy: HOUSE.dana.email, updatedAt: at(-20), createdAt: at(-300) },
    { tenantOrgId: T, partNumber: "G3280-65010", vendor: "Agilent", isOem: true, priceCents: 918000, leadDays: 45,
      dropShips: false, expediteOk: false, note: "Backordered. No ETA offered.",
      updatedBy: HOUSE.dana.email, updatedAt: at(-5), createdAt: at(-52) },
    { tenantOrgId: T, partNumber: "EXT255H", vendor: "Edwards", isOem: true, priceCents: 512000, leadDays: 7,
      dropShips: false, expediteOk: true, updatedBy: OWNER, updatedAt: at(-38), createdAt: at(-38) },
    { tenantOrgId: T, partNumber: "WAT271066", vendor: "Waters", isOem: true, priceCents: 71000, leadDays: 5,
      dropShips: false, expediteOk: false, updatedBy: OWNER, updatedAt: at(-60), createdAt: at(-70) },
    { tenantOrgId: T, partNumber: "SCX-CP-6500", vendor: "PhoenixParts", isOem: false, priceCents: 268000,
      leadDays: 21, dropShips: true, expediteOk: false, note: "Used, sold as seen, no returns.",
      updatedBy: HOUSE.owen.email, updatedAt: at(-9), createdAt: at(-40) },
  ]);

  // ── Stock ────────────────────────────────────────────────────────────────
  // Three kinds of stockroom, because they behave differently: the shop's own,
  // a client's cage we are allowed to draw from, and a van.
  const rooms = await db.insert(stockrooms).values([
    { tenantOrgId: T, name: "Portland shop", kind: "shop", keeper: HOUSE.dana.name,
      location: "Back wall, bins A-D", createdBy: OWNER, createdAt: at(-405) },
    { tenantOrgId: T, name: "Ellison cage (Hillsboro)", kind: "client", orgId: ellison.id,
      keeper: "Rita Alvarez", location: "Hillsboro, room 118",
      note: "Their consumables. We may issue against a job; we never adjust the count without telling them.",
      createdBy: OWNER, createdAt: at(-330) },
    { tenantOrgId: T, name: "Van 2 - Nakamura", kind: "mobile", keeper: HOUSE.tess.name,
      location: "Rolling", createdBy: HOUSE.tess.email, createdAt: at(-280) },
  ]).returning();
  const room = (n: string) => rooms.find((r) => r.name.startsWith(n))!.id;

  await db.insert(stockroomShares).values({
    stockroomId: room("Ellison"), orgId: ellison.id, access: "issue", addedBy: OWNER, createdAt: at(-330),
  }).onConflictDoNothing();

  await db.insert(stockItems).values([
    { stockroomId: room("Portland"), partNumber: "5190-2293", name: "Inlet liner, split/splitless", qty: 11, minQty: 4, bin: "A1", unitCostCents: 6400, updatedAt: at(-14) },
    { stockroomId: room("Portland"), partNumber: "5188-5365", name: "Septa, 11 mm, 50/pk", qty: 1, minQty: 2, bin: "A2", unitCostCents: 4200, updatedAt: at(-4) },
    { stockroomId: room("Portland"), partNumber: "5063-6589", name: "Plunger seal kit", qty: 0, minQty: 2, bin: "A3", unitCostCents: 31500, updatedAt: at(-2) },
    { stockroomId: room("Portland"), partNumber: "ED-A72401", name: "nXDS tip seal kit", qty: 2, minQty: 1, bin: "B1", unitCostCents: 19900, updatedAt: at(-20) },
    { stockroomId: room("Portland"), partNumber: "G1946-80001", name: "Source cleaning kit", qty: 3, minQty: 1, bin: "B2", unitCostCents: 44000, updatedAt: at(-30) },
    { stockroomId: room("Portland"), partNumber: "221-48601", name: "Desolvation line, LCMS-8060", qty: 2, minQty: 1, bin: "B3", unitCostCents: 45500, updatedAt: at(-60) },
    { stockroomId: room("Portland"), partNumber: "WAT271066", name: "ESI capillary", qty: 0, minQty: 1, bin: "C1", unitCostCents: 71000, updatedAt: at(-40) },
    { stockroomId: room("Ellison"), partNumber: "5190-2293", name: "Inlet liner, split/splitless", qty: 6, minQty: 6, bin: "Cage 1", unitCostCents: 6400, updatedAt: at(-25) },
    { stockroomId: room("Ellison"), partNumber: "PK-XE35-FLT", name: "Generator filter set", qty: 2, minQty: 1, bin: "Cage 2", unitCostCents: 28900, updatedAt: at(-36) },
    { stockroomId: room("Van 2"), partNumber: "5188-5365", name: "Septa, 11 mm, 50/pk", qty: 2, minQty: 1, bin: "Drawer 3", unitCostCents: 4200, updatedAt: at(-13) },
    { stockroomId: room("Van 2"), partNumber: "5063-6589", name: "Plunger seal kit", qty: 1, minQty: 1, bin: "Drawer 1", unitCostCents: 31500, updatedAt: at(-13) },
  ]);

  await db.insert(stockMoves).values([
    { stockroomId: room("Portland"), partNumber: "5190-2293", delta: 10, kind: "receive",
      reason: "PO-CIS-0311", actor: HOUSE.dana.email, at: at(-14) },
    { stockroomId: room("Portland"), partNumber: "5190-2293", delta: -2, kind: "transfer_out",
      counterpartyId: room("Van 2"), reason: "Van restock", actor: HOUSE.tess.email, at: at(-13) },
    { stockroomId: room("Van 2"), partNumber: "5190-2293", delta: 2, kind: "transfer_in",
      counterpartyId: room("Portland"), reason: "Van restock", actor: HOUSE.tess.email, at: at(-13) },
    { stockroomId: room("Portland"), partNumber: "5063-6589", delta: -2, kind: "issue",
      instrumentId: sid("CIS-1004"), reason: "WO-2047 - outlet check valve job took the seals too",
      actor: HOUSE.tess.email, at: at(-13) },
    { stockroomId: room("Portland"), partNumber: "5188-5365", delta: -1, kind: "issue",
      instrumentId: sid("CIS-1005"), reason: "WO-2044", actor: HOUSE.owen.email, at: at(-4) },
    { stockroomId: room("Portland"), partNumber: "5188-5365", delta: -1, kind: "adjust",
      reason: "Cycle count - one pack short, opened and never logged", actor: HOUSE.dana.email, at: at(-2) },
    { stockroomId: room("Ellison"), partNumber: "5190-2293", delta: -2, kind: "issue",
      instrumentId: sid("CIS-1005"), reason: "Drawn from the client's own cage", actor: HOUSE.owen.email, at: at(-25) },
    { stockroomId: room("Portland"), partNumber: "WAT271066", delta: -1, kind: "issue",
      instrumentId: sid("CIS-1009"), reason: "WO-2050 source rebuild", actor: HOUSE.owen.email, at: at(-20) },
    { stockroomId: room("Portland"), partNumber: "ED-A72401", delta: 1, kind: "return",
      reason: "Job cancelled, kit unopened", actor: HOUSE.owen.email, at: at(-20) },
  ]);

  // ── Purchasing ───────────────────────────────────────────────────────────
  // Every status a PO can hold, including the one nobody demos: cancelled.
  const pos = await db.insert(purchaseOrders).values([
    { tenantOrgId: T, number: "PO-CIS-0311", vendor: "Agilent", stockroomId: room("Portland"),
      status: "closed", reference: "AG-Q-88213", expectedAt: day(-15), createdBy: HOUSE.dana.email,
      sentAt: at(-22), closedAt: at(-14), createdAt: at(-23) },
    { tenantOrgId: T, number: "PO-CIS-0312", vendor: "Agilent", orgId: harbor.id,
      workOrderId: wo("WO-2041"), status: "sent", reference: "AG-Q-88907",
      note: "RF generator board. Backordered at the vendor - chase weekly.",
      expectedAt: "no ETA offered", urgent: true, createdBy: HOUSE.dana.email,
      sentAt: at(-50), createdAt: at(-51) },
    { tenantOrgId: T, number: "PO-CIS-0313", vendor: "Edwards", stockroomId: room("Portland"),
      workOrderId: wo("WO-2042"), orgId: ellison.id, status: "closed", reference: "ED-88-4412",
      expectedAt: day(-9), shipToSiteId: site("Hillsboro"), createdBy: OWNER,
      sentAt: at(-36), closedAt: at(-8), createdAt: at(-37) },
    { tenantOrgId: T, number: "PO-CIS-0314", vendor: "Restek Direct", stockroomId: room("Portland"),
      status: "sent", reference: "", expectedAt: day(3), createdBy: HOUSE.dana.email,
      sentAt: at(-2), createdAt: at(-2) },
    { tenantOrgId: T, number: "PO-CIS-0315", vendor: "PhoenixParts", orgId: meridian.id,
      workOrderId: wo("WO-2049"), status: "draft", note: "Held until the vendor confirms the fit.",
      createdBy: HOUSE.owen.email, createdAt: at(-9) },
    { tenantOrgId: T, number: "PO-CIS-0316", vendor: "Vacuum Spares Co", stockroomId: room("Portland"),
      status: "cancelled", cancelReason: "Job cancelled before the seals were needed; kit came back unopened.",
      createdBy: HOUSE.owen.email, sentAt: at(-28), closedAt: at(-20), createdAt: at(-29) },
  ]).returning();
  const po = (n: string) => pos.find((p) => p.number === n)!.id;

  await db.insert(poLines).values([
    { poId: po("PO-CIS-0311"), partNumber: "5190-2293", name: "Inlet liner, split/splitless", qtyOrdered: 10, qtyReceived: 10, unitCents: 6400 },
    { poId: po("PO-CIS-0311"), partNumber: "5188-5365", name: "Septa, 11 mm, 50/pk", qtyOrdered: 2, qtyReceived: 2, unitCents: 4200 },
    { poId: po("PO-CIS-0312"), partNumber: "G3280-65010", name: "RF generator board, 7700 series", qtyOrdered: 1, qtyReceived: 0, unitCents: 918000, note: "Backordered" },
    { poId: po("PO-CIS-0313"), partNumber: "EXT255H", name: "Turbomolecular pump, EXT255H", qtyOrdered: 1, qtyReceived: 1, unitCents: 512000 },
    { poId: po("PO-CIS-0313"), partNumber: "G1946-80001", name: "Source cleaning kit", qtyOrdered: 1, qtyReceived: 1, unitCents: 44000 },
    // Part-received: the state a purchasing screen has to be able to show.
    { poId: po("PO-CIS-0314"), partNumber: "5190-2293", name: "Inlet liner (Restek equivalent)", qtyOrdered: 10, qtyReceived: 4, unitCents: 4150 },
    { poId: po("PO-CIS-0314"), partNumber: "5063-6589", name: "Plunger seal kit", qtyOrdered: 4, qtyReceived: 0, unitCents: 31500 },
    { poId: po("PO-CIS-0315"), partNumber: "SCX-CP-6500", name: "Curtain plate assembly (used)", qtyOrdered: 1, qtyReceived: 0, unitCents: 268000, note: "Fit unconfirmed - do not send yet" },
    { poId: po("PO-CIS-0316"), partNumber: "ED-A72401", name: "nXDS tip seal kit", qtyOrdered: 1, qtyReceived: 1, unitCents: 19900 },
  ]);

  // Parts on the bench, in every one of the ten statuses - both lanes, bought
  // and made, and the "Suggested" step that comes before anyone has agreed to
  // spend money.
  await db.insert(parts).values([
    { instrumentId: sid("CIS-1007"), workOrderId: wo("WO-2041"), assetId: aid("JP18310042"), poId: po("PO-CIS-0312"),
      kind: "part", name: "RF generator board", partNumber: "G3280-65010", vendor: "Agilent",
      cost: "$9,180.00", costCents: 918000, ownerOrgId: harbor.id, status: "Backordered",
      po: "PO-CIS-0312", orderedAt: day(-50), eta: "no ETA offered",
      note: "Chased weekly. Asked about a rebuilt exchange unit on the 21st.", createdAt: at(-51) },
    { instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"), assetId: aid("ISQ70-24118"), poId: po("PO-CIS-0313"),
      kind: "part", name: "Turbomolecular pump, EXT255H", partNumber: "EXT255H", serial: "EXT-88213",
      vendor: "Edwards", cost: "$5,120.00", costCents: 512000, ownerOrgId: ellison.id, status: "Installed",
      po: "PO-CIS-0313", carrier: "FedEx", tracking: "774829118203", orderedAt: day(-36),
      receivedAt: day(-9), installedAt: day(-7), moduleKind: "Vacuum pump", createdAt: at(-37) },
    { instrumentId: sid("CIS-1002"), workOrderId: wo("WO-2042"), assetId: aid("ISQ70-24118"),
      kind: "part", name: "Turbomolecular pump (seized)", partNumber: "EXT255H", serial: "EXT-44190",
      vendor: "Edwards", ownerOrgId: ellison.id, status: "Removed", removedAt: day(-7),
      note: "Bearing failure at 41k rpm. Returned to Edwards for core credit.", createdAt: at(-38) },
    { instrumentId: sid("CIS-1005"), workOrderId: wo("WO-2044"), pmScheduleId: pm("Annual PM"),
      kind: "consumable", name: "Inlet liner, split/splitless", partNumber: "5190-2293", qty: "2",
      vendor: "Agilent", cost: "$128.00", costCents: 12800, ownerOrgId: ellison.id, status: "Needed",
      createdAt: at(-21) },
    { instrumentId: sid("CIS-1005"), workOrderId: wo("WO-2044"),
      kind: "consumable", name: "Septa, 11 mm, 50/pk", partNumber: "5188-5365", qty: "1", vendor: "Agilent",
      cost: "$42.00", costCents: 4200, ownerOrgId: ellison.id, status: "Installed", installedAt: day(-4),
      note: "Drawn from the shop shelf.", createdAt: at(-21) },
    { instrumentId: sid("CIS-1001"), workOrderId: wo("WO-2043"), poId: po("PO-CIS-0314"),
      kind: "kit", name: "Plunger seal kit, analytical head", partNumber: "5063-6589", qty: "2",
      vendor: "Restek Direct", cost: "$630.00", costCents: 63000, ownerOrgId: ellison.id,
      status: "Ordered", po: "PO-CIS-0314", orderedAt: day(-2), eta: day(3), createdAt: at(-2) },
    { instrumentId: sid("CIS-1004"), poId: po("PO-CIS-0314"),
      kind: "consumable", name: "Inlet liner (Restek equivalent)", partNumber: "23305A", qty: "6",
      vendor: "Restek Direct", cost: "$249.00", costCents: 24900, ownerOrgId: ellison.id,
      status: "In transit", po: "PO-CIS-0314", carrier: "UPS", tracking: "1Z999AA10123456784",
      orderedAt: day(-2), eta: day(1), createdAt: at(-2) },
    { instrumentId: sid("CIS-1009"), workOrderId: wo("WO-2050"),
      kind: "part", name: "ESI capillary", partNumber: "WAT271066", vendor: "Waters",
      cost: "$710.00", costCents: 71000, ownerOrgId: meridian.id, status: "Installed",
      installedAt: day(-20), note: "Issued from the shop shelf.", createdAt: at(-24) },
    { instrumentId: sid("CIS-1006"), workOrderId: wo("WO-2048"),
      kind: "part", name: "Torch box assembly", partNumber: "N0790456", vendor: "PerkinElmer",
      cost: "call for quote", ownerOrgId: harbor.id, status: "Suggested",
      note: "Not in the crate. Nobody has agreed to buy one yet - it is in the quote, not on order.",
      requestedOrgId: harbor.id, requestedAt: at(-8), createdAt: at(-8) },
    { instrumentId: sid("CIS-1006"), workOrderId: wo("WO-2048"),
      kind: "consumable", name: "Purge line, 3 m", partNumber: "N0777021", vendor: "PerkinElmer",
      cost: "$186.00", costCents: 18600, ownerOrgId: harbor.id, status: "Received",
      po: "", carrier: "UPS", tracking: "1Z999AA10123456799", orderedAt: day(-7), receivedAt: day(-2),
      createdAt: at(-8) },
    // The made lane: nobody is selling this any more, so the shop is printing it.
    { instrumentId: sid("CIS-1011"), workOrderId: wo("WO-2049"),
      kind: "part", name: "Curtain plate retainer, printed", partNumber: "CIS-3DP-0007",
      makerOrgId: T, status: "Being made", specs: "PEEK, 0.15 mm layers, 60% infill. Two spares on the same plate.",
      ownerOrgId: meridian.id, note: "Measured off the old assembly. Test fit before anyone is told it works.",
      createdAt: at(-9) },
    { instrumentId: sid("CIS-1011"), workOrderId: wo("WO-2049"),
      kind: "part", name: "Interface bracket, printed", partNumber: "CIS-3DP-0006",
      makerOrgId: T, status: "Made", madeAt: day(-3), ownerOrgId: meridian.id,
      specs: "PETG, 0.2 mm layers", note: "Fits. Second copy on the shelf.", createdAt: at(-14) },
    { instrumentId: sid("CIS-1003"), kind: "part", name: "Desolvation line", partNumber: "221-48601",
      vendor: "Shimadzu", cost: "$455.00", costCents: 45500, ownerOrgId: ellison.id,
      status: "Installed", installedAt: day(-153), note: "Annual swap.", createdAt: at(-160) },
    { instrumentId: sid("CIS-1012"), kind: "consumable", name: "Liquid helium, 60 L",
      partNumber: "LHE-60", vendor: "Airgas", cost: "$1,240.00", costCents: 124000,
      ownerOrgId: ellison.id, status: "Needed", note: "Vantage will fill on the 14th.", createdAt: at(-6) },
  ]);

  // ── Money ────────────────────────────────────────────────────────────────
  section("Contracts, rates, quotes, invoices and collections");

  const agr = await db.insert(agreements).values([
    { tenantOrgId: T, orgId: ellison.id, kind: "contract", number: "AGR-2026-11",
      title: "Ellison BioLabs - full service", status: "active",
      startsOn: monthStart(-7), endsOn: day(158), renewNoticeDays: 60,
      visitsIncluded: 8, partsAllowanceCents: 750_000, laborIncludedMinutes: 6000,
      pmPartsIncluded: true, includedKits: "5063-6589, 5190-2293, G1946-80001",
      hourlyRateCents: 14500, valueCents: 4_800_000,
      instrumentIds: [sid("CIS-1001"), sid("CIS-1003"), sid("CIS-1004"), sid("CIS-1005")],
      note: "Four systems. PM parts included; anything beyond the allowance is quoted first.",
      createdBy: OWNER, createdAt: at(-218) },
    // Inside its notice window, so the renewals cron has something to draft.
    { tenantOrgId: T, orgId: ellison.id, kind: "contract", number: "AGR-2025-04",
      title: "Ellison BioLabs - cleanroom GxP coverage", status: "active",
      startsOn: day(-322), endsOn: day(41), renewNoticeDays: 60, visitsIncluded: 4,
      partsAllowanceCents: 300_000, laborIncludedMinutes: 2400, valueCents: 2_100_000,
      instrumentIds: [sid("CIS-1003")], note: "Includes the annual OQ re-execution.",
      createdBy: OWNER, createdAt: at(-322) },
    // A retainer with a billing cycle whose cursor is a month behind, so the
    // Contracts screen opens with a cycle ready to raise.
    { tenantOrgId: T, orgId: meridian.id, kind: "contract", number: "AGR-2026-22",
      title: "Meridian - refurbishment retainer", status: "active",
      startsOn: day(-240), visitsUnlimited: true, partsUnlimited: false,
      valueCents: 18_000_000, hourlyRateCents: 12500,
      billEveryMonths: 1, billAmountCents: 1_500_000, billDescription: "Monthly refurbishment retainer",
      billDayOfMonth: 1, billLeadDays: 7, billNextOn: monthStart(-1), billLastOn: monthStart(-2),
      createdBy: OWNER, createdAt: at(-240) },
    { tenantOrgId: T, orgId: harbor.id, kind: "po", number: "NH-PO-9912",
      title: "North Harbor - blanket PO for ICP work", status: "active",
      startsOn: day(-120), endsOn: day(240), valueCents: 2_500_000,
      note: "Draw against this rather than raising a PO per job.", createdBy: HOUSE.dana.email, createdAt: at(-120) },
    { tenantOrgId: T, orgId: harbor.id, kind: "contract", number: "AGR-2025-01",
      title: "North Harbor - lapsed service plan", status: "expired",
      startsOn: day(-700), endsOn: day(-335), visitsIncluded: 4, partsAllowanceCents: 200_000,
      valueCents: 1_400_000, note: "Not renewed - they moved to time and materials.",
      createdBy: OWNER, createdAt: at(-700) },
    // The provider side of the same idea: what Vantage does for us.
    { tenantOrgId: T, orgId: vantage.id, kind: "contract", number: "VS-SUB-004",
      title: "Vantage Scientific - magnet subcontract", status: "active",
      startsOn: day(-150), endsOn: day(215), providerOrgId: vantage.id, hourlyRateCents: 21000,
      valueCents: 900_000, instrumentIds: [sid("CIS-1012")],
      note: "They invoice us; we invoice Ellison. Their scope is the magnet only.",
      createdBy: OWNER, createdAt: at(-150) },
    { tenantOrgId: T, orgId: keystone.id, kind: "quote", number: "AGR-DRAFT-03",
      title: "Keystone Bio - proposed coverage", status: "draft", startsOn: day(30),
      visitsIncluded: 2, partsAllowanceCents: 100_000, valueCents: 640_000,
      note: "Waiting on their budget cycle.", createdBy: OWNER, createdAt: at(-20) },
  ]).returning();
  const ag = (n: string) => agr.find((a) => a.number === n)!;

  // Three rungs of rate card, so the precedence rule is visible rather than
  // asserted: the agreement beats the org, the org beats the default.
  // Deliberately NO workspace-default card (orgId null AND agreementId null).
  // lib/rates.resolveRate ends at `cards.find(c => c.orgId === null && c.agreementId === null)`
  // and its callers load every card on the instance with no tenant predicate,
  // so a default card belonging to the demo would quietly become the fallback
  // hourly rate for the operator that actually runs this instance. Two rungs of
  // precedence - the agreement beating the organization - demonstrate the rule
  // without reaching into somebody else's pricing.
  await db.insert(rateCards).values([
    { tenantOrgId: T, orgId: harbor.id, agreementId: null, hourlyCents: 18500, afterHoursPct: 150,
      travelPct: 50, minIncrementMin: 15, label: "North Harbor - time and materials",
      createdBy: OWNER, createdAt: at(-330) },
    { tenantOrgId: T, orgId: ellison.id, agreementId: null, hourlyCents: 17000, afterHoursPct: 150,
      travelPct: 50, minIncrementMin: 15, label: "Ellison negotiated", createdBy: OWNER, createdAt: at(-395) },
    { tenantOrgId: T, orgId: ellison.id, agreementId: ag("AGR-2026-11").id, hourlyCents: 14500,
      afterHoursPct: 125, travelPct: 0, minIncrementMin: 30, label: "AGR-2026-11 contract rate",
      createdBy: OWNER, createdAt: at(-218) },
    { tenantOrgId: T, orgId: meridian.id, agreementId: ag("AGR-2026-22").id, hourlyCents: 12500,
      afterHoursPct: 150, travelPct: 50, minIncrementMin: 30, label: "Meridian retainer rate",
      createdBy: OWNER, createdAt: at(-240) },
  ]);

  // Quotes in all five statuses. Q-3004 is the one a buyer should click: out
  // with the client, opened twice, a week from lapsing, with a job waiting on it.
  const qs = await db.insert(quotes).values([
    { tenantOrgId: T, orgId: harbor.id, workOrderId: wo("WO-2048"), number: "Q-3001", status: "sent",
      title: "Optima 8300 - refurbishment to working order", sentOn: day(-6), expiresOn: day(9),
      depositPct: 40, note: "Torch box and purge line are the two big items; the rest is labour.",
      createdBy: OWNER, createdAt: at(-7), updatedAt: at(-6) },
    { tenantOrgId: T, orgId: ellison.id, workOrderId: wo("WO-2043"), number: "Q-3002", status: "approved",
      title: "Bioanalysis triple quad - checkout and release", sentOn: day(-12), expiresOn: day(18),
      depositPct: 0, answeredOn: day(-9), answeredBy: "rita@ellisonbio.example",
      answerNote: "Approved. Please book the familiarisation for the same week.",
      createdBy: OWNER, createdAt: at(-13), updatedAt: at(-9) },
    { tenantOrgId: T, orgId: meridian.id, number: "Q-3003", status: "declined",
      title: "QTRAP 6500+ - source replacement with new OEM assembly", sentOn: day(-40),
      expiresOn: day(-10), answeredOn: day(-36), answeredBy: "jules@meridianexchange.example",
      answerNote: "Not at that price on a unit we are reselling. Find us a used one or print it.",
      createdBy: OWNER, createdAt: at(-41), updatedAt: at(-36) },
    { tenantOrgId: T, orgId: keystone.id, number: "Q-3004", status: "sent",
      title: "Keystone Bio - annual coverage, two systems", sentOn: day(-4), expiresOn: day(6),
      depositPct: 25, note: "Two visits a year, parts allowance, phone support included.",
      createdBy: OWNER, createdAt: at(-5), updatedAt: at(-4) },
    { tenantOrgId: T, orgId: harbor.id, number: "Q-3005", status: "expired",
      title: "Suppressor replacement - 930 Compact IC", sentOn: day(-70), expiresOn: day(-40),
      createdBy: HOUSE.dana.email, createdAt: at(-71), updatedAt: at(-70) },
    { tenantOrgId: T, orgId: ellison.id, number: "Q-3006", status: "draft",
      title: "Bend annex - second GC, budgetary", expiresOn: day(45),
      note: "Rough numbers for their FY planning. Not sent.", createdBy: OWNER, createdAt: at(-2), updatedAt: at(0) },
  ]).returning();
  const q = (n: string) => qs.find((x) => x.number === n)!.id;

  await db.insert(quoteLines).values([
    { quoteId: q("Q-3001"), kind: "part", description: "N0790456 Torch box assembly", detail: "OEM, price book +30%", qty: 1000, unitCents: 486_000, position: 0 },
    { quoteId: q("Q-3001"), kind: "part", description: "N0777021 Purge line, 3 m", detail: "", qty: 1000, unitCents: 24_200, position: 1 },
    { quoteId: q("Q-3001"), kind: "labor", description: "Refurbishment labour", detail: "Estimated 22.0 h at the standard rate", qty: 22_000, unitCents: 18500, position: 2 },
    { quoteId: q("Q-3001"), kind: "travel", description: "Travel - Astoria, two visits", detail: "Half rate", qty: 6000, unitCents: 9250, position: 3 },
    { quoteId: q("Q-3001"), kind: "expense", description: "Freight, inbound torch box", detail: "", qty: 1000, unitCents: 21_400, position: 4 },
    { quoteId: q("Q-3002"), kind: "labor", description: "Checkout to the OQ protocol", detail: "8.0 h at the AGR-2026-11 rate", qty: 8000, unitCents: 14500, covered: true, coveredBy: "AGR-2026-11", position: 0 },
    { quoteId: q("Q-3002"), kind: "part", description: "5063-6589 Plunger seal kit", detail: "Drawn from the parts allowance", qty: 2000, unitCents: 31_500, covered: true, coveredBy: "AGR-2026-11", position: 1 },
    { quoteId: q("Q-3002"), kind: "labor", description: "Client familiarisation", detail: "1.5 h, beyond the contract's included hours", qty: 1500, unitCents: 14500, position: 2 },
    { quoteId: q("Q-3003"), kind: "part", description: "SCX-CP-6500 Curtain plate assembly (OEM)", detail: "Discontinued - last-buy pricing", qty: 1000, unitCents: 742_000, position: 0 },
    { quoteId: q("Q-3003"), kind: "labor", description: "Source rebuild and verification", detail: "6.0 h", qty: 6000, unitCents: 12500, position: 1 },
    { quoteId: q("Q-3004"), kind: "retainer", description: "Annual coverage - two systems", detail: "Two PM visits, phone support, 8 h labour included", qty: 1000, unitCents: 640_000, position: 0 },
    { quoteId: q("Q-3005"), kind: "part", description: "MET-SUP-930 Suppressor module", detail: "", qty: 1000, unitCents: 318_000, position: 0 },
    { quoteId: q("Q-3005"), kind: "labor", description: "Fit and verify", detail: "3.0 h", qty: 3000, unitCents: 18500, position: 1 },
    { quoteId: q("Q-3006"), kind: "part", description: "7890B GC-FID, refurbished", detail: "Budgetary - subject to availability", qty: 1000, unitCents: 2_850_000, position: 0 },
    { quoteId: q("Q-3006"), kind: "labor", description: "Install, checkout, familiarisation", detail: "Estimated 16 h", qty: 16_000, unitCents: 17000, position: 1 },
  ]);

  // Invoices: one of every lifecycle word, and lines of every kind.
  const inv = await db.insert(invoices).values([
    { tenantOrgId: T, orgId: ellison.id, workOrderId: wo("WO-2046"), number: "INV-2041", status: "paid",
      issuedOn: day(-42), dueOn: day(-12), poNumber: "PO-EBL-4471", createdBy: HOUSE.dana.email,
      createdAt: at(-42), updatedAt: at(-11) },
    { tenantOrgId: T, orgId: ellison.id, workOrderId: wo("WO-2047"), agreementId: ag("AGR-2026-11").id,
      number: "INV-2042", status: "sent", issuedOn: day(-9), dueOn: day(21), poNumber: "PO-EBL-4471",
      createdBy: HOUSE.dana.email, createdAt: at(-9), updatedAt: at(-9) },
    // The $0 invoice, which is a feature: the visit is documented and the
    // contract is visibly doing its job.
    { tenantOrgId: T, orgId: ellison.id, workOrderId: wo("WO-2042"), agreementId: ag("AGR-2026-11").id,
      number: "INV-2043", status: "sent", issuedOn: day(-2), dueOn: day(28), poNumber: "PO-EBL-4471",
      note: "Covered under AGR-2026-11 - nothing to pay. Sent so the visit is on your record.",
      createdBy: HOUSE.dana.email, createdAt: at(-2), updatedAt: at(-2) },
    // The collections story: 47 days past due, three rungs climbed, a fee
    // posted, a promise broken.
    { tenantOrgId: T, orgId: harbor.id, workOrderId: wo("WO-2045"), number: "INV-2038", status: "sent",
      issuedOn: day(-62), dueOn: day(-47), poNumber: "NH-PO-9912", createdBy: HOUSE.dana.email,
      createdAt: at(-62), updatedAt: at(-11) },
    { tenantOrgId: T, orgId: harbor.id, number: "INV-2039", status: "partial",
      issuedOn: day(-34), dueOn: day(-19), poNumber: "NH-PO-9912", createdBy: HOUSE.dana.email,
      createdAt: at(-34), updatedAt: at(-15) },
    // Handed to a collections agency: the status nobody wants and everybody needs.
    { tenantOrgId: T, orgId: harbor.id, number: "INV-1994", status: "referred",
      issuedOn: day(-210), dueOn: day(-195), poNumber: "", note: "With Cordray Recovery since the 4th.",
      createdBy: HOUSE.dana.email, createdAt: at(-210), updatedAt: at(-60) },
    { tenantOrgId: T, orgId: meridian.id, agreementId: ag("AGR-2026-22").id, number: "INV-2040",
      status: "paid", issuedOn: day(-31), dueOn: day(14), createdBy: HOUSE.dana.email,
      createdAt: at(-31), updatedAt: at(-24) },
    { tenantOrgId: T, orgId: meridian.id, workOrderId: wo("WO-2050"), number: "INV-2044", status: "draft",
      issuedOn: "", dueOn: "", createdBy: HOUSE.dana.email, createdAt: at(-1), updatedAt: at(0) },
    // Raised in error and voided rather than deleted, because the number was used.
    { tenantOrgId: T, orgId: harbor.id, number: "INV-2036", status: "void", issuedOn: day(-70),
      dueOn: day(-55), note: "Raised against the wrong job. Superseded by INV-2038.",
      createdBy: HOUSE.dana.email, createdAt: at(-70), updatedAt: at(-69) },
  ]).returning();
  const iv = (n: string) => inv.find((x) => x.number === n)!.id;

  const lines = await db.insert(invoiceLines).values([
    { invoiceId: iv("INV-2041"), kind: "labor", description: "Labour, on site - Tess Nakamura", detail: "Install, IQ, familiarisation", qty: 8000, unitCents: 17000, position: 0 },
    { invoiceId: iv("INV-2041"), kind: "travel", description: "Travel - Hillsboro", detail: "Half rate", qty: 1500, unitCents: 8500, position: 1 },
    { invoiceId: iv("INV-2041"), kind: "part", description: "Installation kit and fittings", detail: "price book, 22% markup", qty: 1000, unitCents: 41_800, position: 2 },
    { invoiceId: iv("INV-2041"), kind: "expense", description: "Freight, inbound crate", detail: "", qty: 1000, unitCents: 38_500, position: 3 },
    { invoiceId: iv("INV-2042"), kind: "labor", description: "Labour, on site - Tess Nakamura", detail: "Diagnose and replace outlet check valve", qty: 3250, unitCents: 14500, covered: true, coveredBy: "AGR-2026-11", position: 0 },
    { invoiceId: iv("INV-2042"), kind: "travel", description: "Travel - Hillsboro", detail: "Included under the contract", qty: 1000, unitCents: 0, covered: true, coveredBy: "AGR-2026-11", position: 1 },
    { invoiceId: iv("INV-2042"), kind: "part", description: "5063-6589 Plunger seal kit", detail: "Beyond the parts allowance", qty: 2000, unitCents: 38_400, position: 2 },
    { invoiceId: iv("INV-2042"), kind: "part", description: "G1315-60006 Outlet check valve", detail: "price book, 22% markup", qty: 1000, unitCents: 52_700, position: 3 },
    { invoiceId: iv("INV-2043"), kind: "labor", description: "Labour, bench - Owen Brandt", detail: "Turbo replacement and vacuum recertification", qty: 11_170, unitCents: 14500, covered: true, coveredBy: "AGR-2026-11", position: 0 },
    { invoiceId: iv("INV-2043"), kind: "part", description: "EXT255H Turbomolecular pump", detail: "Drawn from the parts allowance", qty: 1000, unitCents: 624_600, covered: true, coveredBy: "AGR-2026-11", position: 1 },
    { invoiceId: iv("INV-2038"), kind: "labor", description: "Labour - Priya Raman", detail: "PFAS method transfer", qty: 7000, unitCents: 18500, position: 0 },
    { invoiceId: iv("INV-2038"), kind: "travel", description: "Travel - Astoria", detail: "Half rate", qty: 3000, unitCents: 9250, position: 1 },
    { invoiceId: iv("INV-2038"), kind: "part", description: "Column set, PFAS panel", detail: "price book, 30% markup", qty: 1000, unitCents: 214_000, position: 2 },
    { invoiceId: iv("INV-2038"), kind: "expense", description: "Standards and consumables", detail: "", qty: 1000, unitCents: 46_800, position: 3 },
    { invoiceId: iv("INV-2039"), kind: "labor", description: "Labour - Tess Nakamura", detail: "ICP-MS diagnosis, two visits", qty: 9500, unitCents: 18500, position: 0 },
    { invoiceId: iv("INV-2039"), kind: "expense", description: "Overnight, Astoria", detail: "Two nights at the policy cap", qty: 1000, unitCents: 33_000, position: 1 },
    { invoiceId: iv("INV-1994"), kind: "labor", description: "Labour - annual service", detail: "", qty: 6000, unitCents: 17500, position: 0 },
    { invoiceId: iv("INV-1994"), kind: "part", description: "Suppressor module", detail: "", qty: 1000, unitCents: 318_000, position: 1 },
    { invoiceId: iv("INV-2040"), kind: "retainer", description: "Monthly refurbishment retainer", detail: "AGR-2026-22", qty: 1000, unitCents: 1_500_000, position: 0 },
    { invoiceId: iv("INV-2044"), kind: "labor", description: "Labour, bench - Owen Brandt", detail: "Source rebuild and checkout", qty: 8500, unitCents: 12500, position: 0 },
    { invoiceId: iv("INV-2044"), kind: "part", description: "WAT271066 ESI capillary", detail: "price book, 30% markup", qty: 1000, unitCents: 92_300, position: 1 },
    // Tax on parts only, at the site's rate - the line lib/billing draws when a
    // client's policy asks for it.
    { invoiceId: iv("INV-2044"), kind: "tax", description: "Sales tax on parts (Tacoma, 10.30%)", detail: "", qty: 1000, unitCents: 9507, position: 2 },
    { invoiceId: iv("INV-2036"), kind: "labor", description: "Labour - raised in error", detail: "", qty: 4000, unitCents: 18500, position: 0 },
  ]).returning();

  await db.insert(payments).values([
    { tenantOrgId: T, invoiceId: iv("INV-2041"), method: "ach", amountCents: 1_895_000,
      reference: "ACH 0912-44118", receivedOn: day(-11), recordedBy: HOUSE.dana.email, createdAt: at(-11) },
    { tenantOrgId: T, invoiceId: iv("INV-2040"), method: "card", amountCents: 1_500_000,
      reference: "pi_demo_3PxQ21Kb", receivedOn: day(-24), recordedBy: "stripe", createdAt: at(-24) },
    { tenantOrgId: T, invoiceId: iv("INV-2039"), method: "check", amountCents: 900_000,
      reference: "Check 20418", receivedOn: day(-15), recordedBy: HOUSE.dana.email, createdAt: at(-15) },
    { tenantOrgId: T, invoiceId: iv("INV-1994"), method: "other", amountCents: 150_000,
      reference: "Agency remittance, less commission", receivedOn: day(-30),
      recordedBy: HOUSE.dana.email, createdAt: at(-30) },
  ]);

  await db.insert(invoiceFees).values([
    { tenantOrgId: T, invoiceId: iv("INV-2038"), amountCents: 7500,
      basis: "Flat late fee, 44 days past the 3-day grace period.", postedOn: day(-11),
      postedBy: HOUSE.dana.email, createdAt: at(-11) },
    { tenantOrgId: T, invoiceId: iv("INV-2039"), amountCents: 7500,
      basis: "Flat late fee, 16 days past the 3-day grace period.", postedOn: day(-3),
      postedBy: HOUSE.dana.email, waived: true, waivedBy: OWNER,
      waivedReason: "They paid most of it and rang first. Not worth the relationship.",
      createdAt: at(-3) },
  ]);

  await db.insert(promises).values([
    { tenantOrgId: T, invoiceId: iv("INV-2038"), promisedOn: day(-8), byName: "K. Osei",
      note: "Cheque going out Friday with the run.", loggedBy: HOUSE.dana.email, createdAt: at(-14) },
    { tenantOrgId: T, invoiceId: iv("INV-2039"), promisedOn: day(-16), byName: "K. Osei",
      note: "Part payment now, balance after their quarter closes.", keptOn: day(-15),
      loggedBy: HOUSE.dana.email, createdAt: at(-20) },
  ]);

  await db.insert(disputes).values([
    { tenantOrgId: T, invoiceId: iv("INV-2038"),
      lineId: lines.find((l) => l.invoiceId === iv("INV-2038") && l.kind === "travel")!.id,
      reason: "Sam: the second Astoria trip was to collect a part we had forgotten, not for their job.",
      openedOn: day(-30), openedBy: HOUSE.dana.email, createdAt: at(-30) },
    { tenantOrgId: T, invoiceId: iv("INV-2039"),
      lineId: lines.find((l) => l.invoiceId === iv("INV-2039") && l.kind === "expense")!.id,
      reason: "Queried the second hotel night.", openedOn: day(-22), openedBy: HOUSE.dana.email,
      resolvedOn: day(-18), resolution: "Held. The visit genuinely ran two days - their own log agrees.",
      resolvedBy: OWNER, createdAt: at(-22) },
  ]);

  await db.insert(dunningEvents).values([
    { tenantOrgId: T, invoiceId: iv("INV-2038"), rung: "nudge", toName: "K. Osei",
      toEmail: "k.osei@northharbor.example", sentBy: "auto", sentOn: day(-54), createdAt: at(-54) },
    { tenantOrgId: T, invoiceId: iv("INV-2038"), rung: "due", toName: "K. Osei",
      toEmail: "k.osei@northharbor.example", sentBy: "auto", sentOn: day(-47), createdAt: at(-47) },
    { tenantOrgId: T, invoiceId: iv("INV-2038"), rung: "statement", toName: "R. Beaumont",
      toEmail: "ap@northharbor.example", sentBy: HOUSE.dana.email, sentOn: day(-32),
      note: "Escalated a rung - the lab manager has stopped replying.", createdAt: at(-32) },
    { tenantOrgId: T, invoiceId: iv("INV-2038"), rung: "demand", toName: "M. Vance",
      toEmail: "controller@northharbor.example", sentBy: OWNER, sentOn: day(-9),
      note: "Demand letter, citing the view receipts on the share link.", createdAt: at(-9) },
    { tenantOrgId: T, invoiceId: iv("INV-1994"), rung: "referred", toName: "Cordray Recovery",
      toEmail: "", sentBy: OWNER, sentOn: day(-60), note: "Handed over at 150 days.", createdAt: at(-60) },
  ]);

  // New work on hold, and the override an owner granted anyway - with a reason
  // and an end date, which is the only way that decision should ever be made.
  await db.insert(creditOverrides).values({
    tenantOrgId: T, orgId: harbor.id,
    reason: "Their ICP is down and the board is on order. Holding the job would punish the wrong people.",
    untilOn: day(21), grantedBy: OWNER, createdAt: at(-9),
  });

  // ── Expenses, reimbursements and payroll ─────────────────────────────────
  // Three different things that all look like "money out": rebillable costs on
  // a job, an engineer's own receipts waiting on a payout, and overhead nobody
  // will ever invoice.
  const reports = await db.insert(expenseReports).values([
    { tenantOrgId: T, person: HOUSE.tess.name, status: "submitted", submittedBy: HOUSE.tess.email,
      submittedAt: at(-6), note: "Astoria week - two nights and the drive." },
    { tenantOrgId: T, person: HOUSE.owen.name, status: "paid", submittedBy: HOUSE.owen.email,
      submittedAt: at(-40), paidOn: day(-33), paidBy: OWNER, paidRef: "Payroll run 09-15",
      note: "Tacoma trips, first half of the month." },
    { tenantOrgId: T, person: HOUSE.priya.name, status: "returned", submittedBy: HOUSE.priya.email,
      submittedAt: at(-12), returnedReason: "The hotel receipt is the booking confirmation, not the folio - resend it.",
      note: "Astoria overnight." },
  ]).returning();
  const rep = (person: string) => reports.find((r) => r.person === person)!.id;

  await db.insert(expenses).values([
    // On a job, rebillable.
    { tenantOrgId: T, workOrderId: wo("WO-2047"), kind: "mileage", description: "44 miles round trip at 0.67",
      amountCents: 2948, incurredOn: day(-13), billable: true, person: HOUSE.tess.name,
      siteId: site("Hillsboro"), loggedBy: HOUSE.tess.email, createdAt: at(-13) },
    { tenantOrgId: T, workOrderId: wo("WO-2042"), kind: "shipping", description: "Overnight freight, turbo from Edwards",
      amountCents: 21_400, incurredOn: day(-10), billable: true, person: HOUSE.dana.name,
      loggedBy: HOUSE.dana.email, createdAt: at(-10) },
    { tenantOrgId: T, workOrderId: wo("WO-2050"), kind: "other", description: "Forklift and crate handling, Tacoma",
      amountCents: 32_500, incurredOn: day(-20), billable: true, person: HOUSE.owen.name,
      siteId: site("Tacoma"), loggedBy: HOUSE.owen.email, createdAt: at(-20) },
    // On a job and NOT rebillable: it must show in the job's cost and stay off
    // the invoice draft. That pair is the whole reason the flag exists.
    { tenantOrgId: T, workOrderId: wo("WO-2042"), kind: "per_diem", description: "Lunch, install day",
      amountCents: 1850, incurredOn: day(-7), billable: false, person: HOUSE.owen.name,
      loggedBy: HOUSE.owen.email, createdAt: at(-7) },
    // A claim mid-flight: submitted, waiting on the owner.
    { tenantOrgId: T, workOrderId: wo("WO-2045"), kind: "Lodging", description: "Cannery Pier Hotel, 2 nights",
      amountCents: 33_000, incurredOn: day(-6), billable: true, person: HOUSE.tess.name,
      siteId: site("Pier Road"), loggedBy: HOUSE.tess.email, reportId: rep(HOUSE.tess.name),
      receiptName: "cannery-pier-folio.pdf", createdAt: at(-6) },
    { tenantOrgId: T, workOrderId: wo("WO-2045"), kind: "Per diem", description: "Astoria, 2 days",
      amountCents: 13_000, incurredOn: day(-6), billable: true, person: HOUSE.tess.name,
      loggedBy: HOUSE.tess.email, reportId: rep(HOUSE.tess.name), createdAt: at(-6) },
    { tenantOrgId: T, workOrderId: wo("WO-2045"), kind: "Mileage", description: "196 miles round trip at 0.67",
      amountCents: 13_132, incurredOn: day(-6), billable: true, person: HOUSE.tess.name,
      siteId: site("Pier Road"), loggedBy: HOUSE.tess.email, reportId: rep(HOUSE.tess.name), createdAt: at(-6) },
    { tenantOrgId: T, workOrderId: wo("WO-2050"), kind: "Mileage", description: "296 miles round trip at 0.67",
      amountCents: 19_832, incurredOn: day(-40), billable: true, person: HOUSE.owen.name,
      siteId: site("Tacoma"), loggedBy: HOUSE.owen.email, reportId: rep(HOUSE.owen.name), createdAt: at(-40) },
    { tenantOrgId: T, workOrderId: null, kind: "Lodging", description: "Astoria overnight",
      amountCents: 18_900, incurredOn: day(-13), billable: false, person: HOUSE.priya.name,
      loggedBy: HOUSE.priya.email, reportId: rep(HOUSE.priya.name), createdAt: at(-12) },
    // Overhead: money no job caused. Lives at /money/expenses and is never invoiced.
    { tenantOrgId: T, workOrderId: null, kind: "Software & subscriptions", description: "MassHunter licence, annual",
      amountCents: 348_000, incurredOn: day(-45), billable: false, person: "", loggedBy: OWNER, createdAt: at(-45) },
    { tenantOrgId: T, workOrderId: null, kind: "Phone & internet", description: "Shop internet and mobiles",
      amountCents: 41_900, incurredOn: monthStart(0), billable: false, person: "", loggedBy: HOUSE.dana.email, createdAt: at(-4) },
    { tenantOrgId: T, workOrderId: null, kind: "Equipment rental", description: "Helium leak detector, weekly hire",
      amountCents: 62_500, incurredOn: day(-18), billable: false, person: "", loggedBy: OWNER, createdAt: at(-18) },
    { tenantOrgId: T, workOrderId: null, kind: "Training & certification", description: "Sciex certification, O. Brandt",
      amountCents: 189_000, incurredOn: day(-70), billable: false, person: HOUSE.owen.name, loggedBy: OWNER, createdAt: at(-70) },
    { tenantOrgId: T, workOrderId: null, kind: "Permits & fees", description: "Business licence renewal",
      amountCents: 32_500, incurredOn: day(-90), billable: false, person: "", loggedBy: HOUSE.dana.email, createdAt: at(-90) },
  ]);

  // What the shop pays its own people - the number every margin in the app is
  // measured against. Owner-only, and on its own side of the wall.
  await db.insert(payroll).values([
    { tenantOrgId: T, orgId: T, personEmail: OWNER, name: HOUSE.owner.name, title: HOUSE.owner.title,
      kind: "salary", amountCents: 14_500_000, hoursPerWeek: 45, ftePct: 100, burdenPct: 18,
      effectiveOn: monthStart(-14), note: "Owner draw.", createdBy: OWNER, createdAt: at(-410) },
    { tenantOrgId: T, orgId: T, personEmail: HOUSE.tess.email, name: HOUSE.tess.name, title: HOUSE.tess.title,
      kind: "salary", amountCents: 11_800_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 24,
      effectiveOn: monthStart(-6), note: "Raise at the two-year review.", createdBy: OWNER, createdAt: at(-190) },
    { tenantOrgId: T, orgId: T, personEmail: HOUSE.tess.email, name: HOUSE.tess.name, title: HOUSE.tess.title,
      kind: "salary", amountCents: 10_600_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 24,
      effectiveOn: monthStart(-18), endsOn: monthStart(-6), note: "Superseded.",
      createdBy: OWNER, createdAt: at(-380) },
    { tenantOrgId: T, orgId: T, personEmail: HOUSE.owen.email, name: HOUSE.owen.name, title: HOUSE.owen.title,
      kind: "hourly", amountCents: 4800, hoursPerWeek: 40, ftePct: 100, burdenPct: 26,
      effectiveOn: monthStart(-10), createdBy: OWNER, createdAt: at(-300) },
    { tenantOrgId: T, orgId: T, personEmail: HOUSE.priya.email, name: HOUSE.priya.name, title: HOUSE.priya.title,
      kind: "salary", amountCents: 12_400_000, hoursPerWeek: 32, ftePct: 80, burdenPct: 22,
      effectiveOn: monthStart(-7), note: "Four days a week by arrangement.", createdBy: OWNER, createdAt: at(-210) },
    { tenantOrgId: T, orgId: T, personEmail: HOUSE.dana.email, name: HOUSE.dana.name, title: HOUSE.dana.title,
      kind: "hourly", amountCents: 3600, hoursPerWeek: 24, ftePct: 60, burdenPct: 20,
      effectiveOn: monthStart(-12), createdBy: OWNER, createdAt: at(-360) },
  ]);

  // ── Paperwork ────────────────────────────────────────────────────────────
  // Generated for real, so every download in the demo opens something.
  section("Files, packets and share links");
  const lib = await db.insert(folders).values([
    { tenantOrgId: T, orgId: null, parentId: null, name: "Manuals", createdBy: OWNER, createdAt: at(-400) },
    { tenantOrgId: T, orgId: null, parentId: null, name: "Shop procedures", createdBy: OWNER, createdAt: at(-400) },
    { tenantOrgId: T, orgId: ellison.id, parentId: null, name: "Ellison - validation", createdBy: HOUSE.priya.email, createdAt: at(-260) },
  ]).returning();
  const folder = (n: string) => lib.find((f) => f.name.startsWith(n))!.id;
  const [manualsSub] = await db.insert(folders).values({
    tenantOrgId: T, orgId: null, parentId: folder("Manuals"), name: "Agilent", createdBy: OWNER, createdAt: at(-390),
  }).returning();

  const tuneReport = await paper("Reserpine tune report", "CIS-1001 · Agilent 6495C LC-MS/MS · " + day(-2), [
    "## Instrument",
    "System CIS-1001, Agilent 6495C LC-MS/MS, serial US24071104",
    "Source: Agilent Jet Stream, cleaned " + day(-9),
    "",
    "## Conditions",
    "Mobile phase 0.1% formic acid in water / acetonitrile",
    "Gas temp 250 C, sheath gas 375 C, capillary 3500 V",
    "",
    "## Result",
    "MRM 609.3 > 195.1, 1 pg on column, three replicates",
    "Mean peak area 61,400 counts (specification 50,000, tolerance 20%)",
    "Signal to noise 148:1 peak-to-peak",
    "",
    "Verdict: PASS. Recorded by Tess Nakamura.",
  ]);
  const leakCurve = await paper("Vacuum recertification", "CIS-1002 · Thermo ISQ 7000 · " + day(-5), [
    "## Work",
    "Turbomolecular pump EXT255H replaced (serial EXT-44190 out, EXT-88213 in)",
    "New centring ring and clamp; foreline joints leak-checked with helium",
    "",
    "## Pump-down",
    "t = 0 min      atmospheric",
    "t = 10 min     4.8e-1 mbar",
    "t = 20 min     6.2e-2 mbar",
    "t = 30 min     2.1e-2 mbar   (specification 2.0e-2 mbar, tolerance 15%)",
    "t = 12 h       8.4e-3 mbar",
    "",
    "Verdict: PASS at 30 minutes and still falling. Recorded by Owen Brandt.",
  ]);
  const oqReport = await paper("OQ report - LCMS-8060NX", "CIS-1003 · Ellison BioLabs cleanroom · " + day(-14), [
    "## Scope",
    "Operational qualification following VP-2026-03, sections 4.1 to 4.9.",
    "",
    "## Tests executed",
    "4.1  Flow accuracy            0.994 mL/min      PASS",
    "4.2  Gradient composition     within 1.2%       PASS",
    "4.3  Column oven accuracy     40.1 C            PASS",
    "4.4  Injection precision      0.28 %RSD         PASS",
    "4.5  Detector wavelength      656.2 nm          PASS",
    "4.6  Carryover                0.04%             PASS",
    "4.7  Mass accuracy            1.8 ppm           PASS",
    "4.8  Sensitivity              S/N 212:1         PASS",
    "4.9  Pressure trace           see note          OPEN",
    "",
    "## Note on 4.9",
    "An 8 bar step is present at 14.0 min. This is the column-switching valve",
    "at the gradient hold and is expected behaviour for this method.",
    "",
    "Executed by Priya Raman. Awaiting QA counter-signature.",
  ]);
  const calCert = await paper("Calibration certificate", "Pressure transducer · cert PT-88213 · " + day(-60), [
    "## Instrument under calibration",
    "Digital pressure transducer, Ashcroft 2089, serial 88213",
    "",
    "## Reference standard",
    "Fluke 719Pro, cert 4471-2026, traceable to NIST",
    "",
    "## Points",
    "0 bar     0.00 bar    within tolerance",
    "100 bar   99.8 bar    within tolerance",
    "400 bar   399.4 bar   within tolerance",
    "600 bar   599.1 bar   within tolerance",
    "",
    "Valid to " + day(305) + ". Issued by " + ORG_NAME + ".",
  ]);
  const sitePrep = await paper("Site preparation checklist", "What a lab needs ready before install day", [
    "## Services",
    "Dedicated 20 A circuit within 2 m of the bench position",
    "Nitrogen at 90-100 psi, 1/8 in Swagelok, dry and oil free",
    "Exhaust: 100 mm duct within 3 m, 200 m3/h minimum",
    "",
    "## Space",
    "Bench 1800 x 750 mm, level to 2 mm across the span",
    "600 mm clearance behind for service access",
    "",
    "## Environment",
    "18-27 C, stable to 2 C per hour",
    "20-80% RH, non-condensing",
    "",
    "## People",
    "One person available on install day who will run the instrument",
    "Site induction and badge arranged in advance",
  ]);
  const packingList = csv([
    ["Item", "Part number", "Qty", "Checked", "Note"],
    ["Mass spectrometer", "5977B", "1", "yes", "Serial US16290331"],
    ["GC oven", "8890", "1", "yes", ""],
    ["Autosampler tower", "7693A", "1", "yes", ""],
    ["Sample tray", "G4513-40530", "1", "yes", ""],
    ["Foreline pump", "nXDS15i", "1", "yes", "Rebuilt at intake"],
    ["Interface cable set", "-", "1", "yes", ""],
    ["Column set", "19091S-433UI", "2", "yes", "Unused"],
    ["Manuals and media", "-", "1", "no", "Digital only - link in the packet"],
  ]);
  const intakePhoto = await store("cis-1006-intake.svg", "image/svg+xml",
    photo("CIS-1006 at intake", "Optima 8300 · pallet, front face", "#EEF1F5", "#1B2A44"));
  const damagePhoto = await store("cis-1006-damage.svg", "image/svg+xml",
    photo("Side panel dent", "40 mm, cosmetic · CIS-1006", "#F7EFEA", "#7A3B12"));
  const listingPhoto = await store("cis-1009-listing.svg", "image/svg+xml",
    photo("Xevo TQ-S micro", "Refurbished · source rebuilt", "#EAF2EC", "#22503A"));
  const heroPhoto = await store("cis-1001-hero.svg", "image/svg+xml",
    photo("CIS-1001", "Agilent 6495C LC-MS/MS", "#E9EEF6", "#1B2A44"));

  const files = await db.insert(attachments).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), fileName: "reserpine-tune-report.pdf", kind: "Tune report",
      description: "Post-clean verification, three replicates", url: (await store("reserpine-tune-report.pdf", "application/pdf", tuneReport)).url,
      size: tuneReport.byteLength, uploadedBy: HOUSE.tess.email, taskId: task("Reserpine sensitivity").id,
      workOrderId: wo("WO-2043"), createdAt: at(-2, 21) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), fileName: "cis-1001.svg", kind: "Photo",
      description: "Bench photograph", url: heroPhoto.url, size: heroPhoto.size, framing: "cover",
      uploadedBy: HOUSE.tess.email, createdAt: at(-20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), fileName: "vacuum-recertification.pdf", kind: "Test data",
      description: "Pump-down curve after the turbo swap", url: (await store("vacuum-recert.pdf", "application/pdf", leakCurve)).url,
      size: leakCurve.byteLength, uploadedBy: HOUSE.owen.email, taskId: task("Leak check", "CIS-1002").id,
      workOrderId: wo("WO-2042"), createdAt: at(-5, 22) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), fileName: "oq-report-8060.pdf", kind: "Report",
      description: "OQ execution, one open item at 4.9", url: (await store("oq-report-8060.pdf", "application/pdf", oqReport)).url,
      size: oqReport.byteLength, uploadedBy: HOUSE.priya.email, orgId: ellison.id, folderId: folder("Ellison"),
      createdAt: at(-14) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), fileName: "cis-1006-intake.svg", kind: "Photo",
      description: "As received, front face", url: intakePhoto.url, size: intakePhoto.size,
      uploadedBy: HOUSE.owen.email, workOrderId: wo("WO-2048"), createdAt: at(-8, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1006"), fileName: "cis-1006-side-damage.svg", kind: "Photo",
      description: "Shipping damage, left side panel", url: damagePhoto.url, size: damagePhoto.size,
      uploadedBy: HOUSE.owen.email, workOrderId: wo("WO-2048"), createdAt: at(-8, 20) },
    { tenantOrgId: T, instrumentId: sid("CIS-1009"), fileName: "cis-1009-listing.svg", kind: "Photo",
      description: "Listing photograph", url: listingPhoto.url, size: listingPhoto.size,
      // The one flag that makes a file readable by a stranger holding the link.
      showOnListing: true, uploadedBy: HOUSE.owen.email, createdAt: at(-12) },
    { tenantOrgId: T, instrumentId: sid("CIS-1010"), fileName: "cis-1010-packing-list.csv", kind: "Other",
      description: "Crate inventory, checked before sealing", url: (await store("cis-1010-packing-list.csv", "text/csv", packingList)).url,
      size: packingList.byteLength, showOnListing: true, uploadedBy: HOUSE.owen.email, createdAt: at(-2) },
    { tenantOrgId: T, orgId: null, folderId: folder("Shop procedures"), fileName: "site-preparation-checklist.pdf",
      kind: "Manual", description: "Sent to every client before an install", url: (await store("site-prep.pdf", "application/pdf", sitePrep)).url,
      size: sitePrep.byteLength, uploadedBy: OWNER, createdAt: at(-300) },
    { tenantOrgId: T, orgId: null, folderId: manualsSub.id, fileName: "6495c-site-guide.pdf", kind: "Manual",
      description: "", url: (await store("6495c-site-guide.pdf", "application/pdf", await paper(
        "6495C site guide", "Agilent 6495C LC-MS/MS · services and clearances",
        ["## Power", "230 V, 16 A dedicated", "", "## Gases", "Nitrogen 99.995%, 100 psi, 60 L/min peak",
         "", "## Exhaust", "Source exhaust to house extract, 200 m3/h"],
      ))).url, size: 2048, uploadedBy: OWNER, createdAt: at(-390) },
    { tenantOrgId: T, orgId: ellison.id, folderId: folder("Ellison"), fileName: "calibration-cert-PT-88213.pdf",
      kind: "Report", description: "Reference transducer, valid twelve months",
      url: (await store("cal-cert-pt-88213.pdf", "application/pdf", calCert)).url, size: calCert.byteLength,
      expiresOn: day(305), uploadedBy: HOUSE.priya.email, createdAt: at(-60) },
    { tenantOrgId: T, assetId: aid("ED-NX-33112"), fileName: "nxds15i-service-record.pdf", kind: "Report",
      description: "Tip seal service, March", url: (await store("nxds-service.pdf", "application/pdf", await paper(
        "Service record - nXDS15i", "Serial ED-NX-33112 · tip seals and O-rings",
        ["## Work", "Tip seals replaced (kit ED-A72401)", "O-ring set replaced", "Exhaust filter replaced",
         "", "## Verification", "Ultimate pressure 6.2e-2 mbar against a 7.0e-2 specification"],
      ))).url, size: 1536, uploadedBy: HOUSE.owen.email, createdAt: at(-291) },
    { tenantOrgId: T, poId: po("PO-CIS-0313"), fileName: "edwards-order-confirmation.pdf", kind: "Other",
      description: "Vendor confirmation ED-88-4412", url: (await store("edwards-confirmation.pdf", "application/pdf", await paper(
        "Order confirmation", "Edwards · reference ED-88-4412",
        ["## Ordered", "1 x EXT255H turbomolecular pump    $5,120.00",
         "1 x G1946-80001 source cleaning kit  $440.00", "", "## Shipment", "FedEx priority, tracking 774829118203"],
      ))).url, size: 1200, uploadedBy: HOUSE.dana.email, createdAt: at(-36) },
    { tenantOrgId: T, agreementId: ag("AGR-2026-11").id, fileName: "AGR-2026-11-signed.pdf", kind: "Other",
      description: "Countersigned contract", url: (await store("agr-2026-11.pdf", "application/pdf", await paper(
        "Full service agreement", "AGR-2026-11 · Ellison BioLabs · " + monthStart(-7),
        ["## Coverage", "Four systems: CIS-1001, CIS-1003, CIS-1004, CIS-1005",
         "8 visits, 100 hours of labour, $7,500 parts allowance per year", "PM parts included",
         "", "## Rate beyond the inclusions", "$145.00 per hour, 30 minute increments", "",
         "## Term", "Twelve months from " + monthStart(-7) + ", 60 days' notice to renew"],
      ))).url, size: 1800, uploadedBy: OWNER, createdAt: at(-218) },
  ]).returning();
  const file = (name: string) => files.find((f) => f.fileName === name)!.id;

  await db.update(instruments).set({ photoAttachmentId: file("cis-1001.svg") }).where(eq(instruments.id, sid("CIS-1001")));
  await db.update(instruments).set({ photoAttachmentId: file("cis-1006-intake.svg") }).where(eq(instruments.id, sid("CIS-1006")));
  await db.update(instruments).set({ photoAttachmentId: file("cis-1009-listing.svg") }).where(eq(instruments.id, sid("CIS-1009")));

  // A packet of files sent out by link, an invoice link the client has opened
  // twice (which is where the invoice timeline's "Viewed" line comes from), a
  // quote link, and a drop link pointing the other way - somewhere for a client
  // to put files without an account.
  const shares = await db.insert(shareLinks).values([
    { tenantOrgId: T, token: token("share-files-ellison-01"), kind: "files", orgId: ellison.id,
      label: "CIS-1001 release packet", expiresOn: day(60), createdBy: HOUSE.tess.email,
      openedAt: at(-1, 18), lastOpenedAt: at(0, 15), openCount: 3, createdAt: at(-2) },
    { tenantOrgId: T, token: token("share-invoice-2042"), kind: "invoice", orgId: ellison.id,
      invoiceId: iv("INV-2042"), label: "Invoice INV-2042", expiresOn: day(300),
      createdBy: HOUSE.dana.email, openedAt: at(-8, 16), lastOpenedAt: at(-6, 20), openCount: 2, createdAt: at(-9) },
    { tenantOrgId: T, token: token("share-invoice-2038"), kind: "invoice", orgId: harbor.id,
      invoiceId: iv("INV-2038"), label: "Invoice INV-2038", expiresOn: day(250),
      createdBy: HOUSE.dana.email, openedAt: at(-61, 15), lastOpenedAt: at(-31, 14), openCount: 5, createdAt: at(-62) },
    { tenantOrgId: T, token: token("share-quote-3001"), kind: "quote", orgId: harbor.id, quoteId: q("Q-3001"),
      label: "Quote Q-3001", expiresOn: day(40), createdBy: OWNER,
      openedAt: at(-5, 17), lastOpenedAt: at(-3, 19), openCount: 2, createdAt: at(-6) },
    { tenantOrgId: T, token: token("share-quote-3004"), kind: "quote", orgId: keystone.id, quoteId: q("Q-3004"),
      label: "Quote Q-3004", expiresOn: day(30), createdBy: OWNER,
      openedAt: at(-3, 16), lastOpenedAt: at(-1, 21), openCount: 4, createdAt: at(-4) },
    // Withdrawn, so the revoked state is on screen rather than only in a test.
    { tenantOrgId: T, token: token("share-files-revoked"), kind: "files", orgId: meridian.id,
      label: "QTRAP condition report (superseded)", expiresOn: day(20), createdBy: HOUSE.owen.email,
      revokedAt: at(-10), createdAt: at(-30) },
  ]).returning();
  const share = (t: string) => shares.find((s) => s.token === t)!.id;

  await db.insert(shareLinkFiles).values([
    { shareId: share(token("share-files-ellison-01")), attachmentId: file("reserpine-tune-report.pdf") },
    { shareId: share(token("share-files-ellison-01")), attachmentId: file("cis-1001.svg") },
    { shareId: share(token("share-files-ellison-01")), attachmentId: file("calibration-cert-PT-88213.pdf") },
    { shareId: share(token("share-files-revoked")), attachmentId: file("cis-1009-listing.svg") },
  ]);

  await db.insert(dropLinks).values([
    { tenantOrgId: T, orgId: ellison.id, folderId: folder("Ellison"), token: token("drop-ellison-methods"),
      label: "Method files from Rita", expiresOn: day(21), usedCount: 2, lastUploadAt: at(-3, 18),
      createdBy: HOUSE.priya.email, createdAt: at(-14) },
    { tenantOrgId: T, orgId: harbor.id, folderId: null, token: token("drop-harbor-photos"),
      label: "Photos of the ICP install", expiresOn: day(-2), usedCount: 0,
      createdBy: HOUSE.tess.email, createdAt: at(-32) },
  ]);

  // ── Regulated paperwork ──────────────────────────────────────────────────
  // The GxP half: a document set with versions, states and signatures, one of
  // them revoked - which is the case that proves a signature means something.
  const docs = await db.insert(validationDocs).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "URS", title: "User requirement specification - cleanroom LC-MS",
      state: "Approved", version: 2, reviewOn: day(400), createdBy: HOUSE.priya.email, createdAt: at(-250) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "Validation Plan", title: "VP-2026-03",
      state: "Approved", version: 1, reviewOn: day(320), createdBy: HOUSE.priya.email, createdAt: at(-240) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "IQ Protocol", title: "IQ protocol - LCMS-8060NX",
      state: "Executed", version: 1, createdBy: HOUSE.priya.email, createdAt: at(-200) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "IQ Report", title: "IQ report - LCMS-8060NX",
      state: "Approved", version: 1, createdBy: HOUSE.priya.email, createdAt: at(-190) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "OQ Protocol", title: "OQ protocol - LCMS-8060NX",
      state: "Executed", version: 1, createdBy: HOUSE.priya.email, createdAt: at(-30) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "OQ Report", title: "OQ report - LCMS-8060NX",
      state: "Draft", version: 1, attachmentId: file("oq-report-8060.pdf"),
      note: "Section 4.9 open - QA queried the pressure trace.", createdBy: HOUSE.priya.email, createdAt: at(-14) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "Calibration Certificate",
      title: "Reference transducer PT-88213", state: "Approved", version: 1,
      attachmentId: file("calibration-cert-PT-88213.pdf"), reviewOn: day(305),
      createdBy: HOUSE.priya.email, createdAt: at(-60) },
    { tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "Deviation Report", title: "DEV-2026-011 - oven overshoot",
      state: "Approved", version: 1, note: "Oven overshot to 42.8 C once during 4.3. Root cause: door interlock.",
      createdBy: HOUSE.priya.email, createdAt: at(-28) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), docType: "Periodic Review", title: "Annual periodic review - CIS-1001",
      state: "Draft", version: 1, reviewOn: day(30), createdBy: HOUSE.priya.email, createdAt: at(-6) },
  ]).returning();
  const doc = (title: string) => docs.find((d) => d.title.startsWith(title))!.id;

  // Version 1 of the URS, superseded by the version above it.
  const [ursV1] = await db.insert(validationDocs).values({
    tenantOrgId: T, instrumentId: sid("CIS-1003"), docType: "URS",
    title: "User requirement specification - cleanroom LC-MS", state: "Superseded", version: 1,
    createdBy: HOUSE.priya.email, createdAt: at(-330),
  }).returning();
  await db.update(validationDocs).set({ supersedesId: ursV1.id })
    .where(eq(validationDocs.id, doc("User requirement specification")));

  await db.insert(validationSignatures).values([
    { docId: doc("User requirement specification"), role: "Author", signedBy: HOUSE.priya.email,
      signerName: HOUSE.priya.name, signerTitle: HOUSE.priya.title, createdAt: at(-250) },
    { docId: doc("User requirement specification"), role: "Reviewed", signedBy: "rita@ellisonbio.example",
      signerName: "Rita Alvarez", signerTitle: "Lab operations manager", createdAt: at(-249) },
    { docId: doc("User requirement specification"), role: "Approved", signedBy: "qa@ellisonbio.example",
      signerName: "Priya Iyer", signerTitle: "QA specialist", createdAt: at(-248) },
    { docId: doc("VP-2026-03"), role: "Author", signedBy: HOUSE.priya.email, signerName: HOUSE.priya.name,
      signerTitle: HOUSE.priya.title, createdAt: at(-240) },
    { docId: doc("VP-2026-03"), role: "Approved", signedBy: "qa@ellisonbio.example", signerName: "Priya Iyer",
      signerTitle: "QA specialist", createdAt: at(-239) },
    { docId: doc("IQ report"), role: "Author", signedBy: HOUSE.priya.email, signerName: HOUSE.priya.name,
      signerTitle: HOUSE.priya.title, createdAt: at(-190) },
    { docId: doc("IQ report"), role: "Approved", signedBy: "qa@ellisonbio.example", signerName: "Priya Iyer",
      signerTitle: "QA specialist", note: "Installed as specified.", createdAt: at(-188) },
    // Signed, then withdrawn when the reading it rested on turned out to be
    // from the wrong probe. The record keeps both facts.
    { docId: doc("DEV-2026-011"), role: "Approved", signedBy: "qa@ellisonbio.example", signerName: "Priya Iyer",
      signerTitle: "QA specialist", createdAt: at(-26),
      revokedAt: at(-20), revokeReason: "Signed against the wrong probe's trace. Re-executed and re-signed below." },
    { docId: doc("DEV-2026-011"), role: "Approved", signedBy: "qa@ellisonbio.example", signerName: "Priya Iyer",
      signerTitle: "QA specialist", note: "Re-signed on the corrected trace.", createdAt: at(-19) },
  ]);

  // A release signature on the unit that has actually finished, with the
  // evidence frozen at the moment it was signed.
  await db.insert(signoffs).values({
    instrumentId: sid("CIS-1014"), signedBy: "rita@ellisonbio.example", signerName: "Rita Alvarez",
    signerTitle: "Lab operations manager", meaning: "Approved for release",
    note: "Installed, demonstrated and running our own method. Happy to sign.",
    data: { version: 1, tasksTotal: 6, tasksDone: 6, requiredTests: [
      { title: "Leak check", reports: 1 }, { title: "Flow accuracy", reports: 1 },
      { title: "Electrical safety (PAT)", reports: 1 },
    ] },
    createdAt: at(-16, 22),
  });
  // And one that was signed and then pulled, which is the case a demo usually
  // cannot show: the signature stands in the record, marked withdrawn.
  await db.insert(signoffs).values({
    assetId: aid("DEG-1260-88"), signedBy: OWNER, signerName: HOUSE.owner.name,
    signerTitle: HOUSE.owner.title, meaning: "Released as a spare",
    note: "Released to the shelf after bench test.",
    data: { version: 1, tasksTotal: 2, tasksDone: 2, requiredTests: [] },
    revokedAt: at(-92), revokedBy: HOUSE.owen.email,
    revokedReason: "It leaks under vacuum. Should never have gone back on the shelf.",
    createdAt: at(-96, 20),
  });

  // A share that was withdrawn: the client keeps a frozen copy of what they
  // could see, and nothing live.
  await db.insert(engagementRecords).values({
    instrumentId: null, orgId: ellison.id, kind: "revoked", externalId: "CIS-1000",
    label: "GC-MS - 5975C GC-MSD", revokedBy: OWNER, revokedAt: at(-58),
    data: {
      version: 1,
      system: { externalId: "CIS-1000", client: "Ellison BioLabs", category: "GC-MS",
        location: "Hillsboro - Bay 3", lead: HOUSE.owen.name,
        notes: "Decommissioned at the client's request; parts harvested.", stages: ["Shipped"] },
      label: "GC-MS - 5975C GC-MSD",
      assets: [{ kind: "Mass spec", model: "5975C MSD", serial: "US83221909", manufacturer: "Agilent",
        status: "Decommissioned", asFound: "", note: "Source and quads good - kept as a donor." }],
      gases: [{ gas: "Helium", status: "Not needed", note: "" }],
      tasks: [{ title: "Final decontamination and wipe-down", body: "", state: "Done",
        assignee: HOUSE.owen.name, dueDate: "", origin: "", createdAt: at(-62).toISOString(),
        completedAt: at(-59).toISOString(), checklist: [], notes: [] }],
      parts: [{ kind: "consumable", name: "Inlet liner", partNumber: "5190-2293", serial: "", qty: "1",
        specs: "", vendor: "Agilent", status: "Installed", installedAt: day(-120), removedAt: "",
        note: "", createdAt: at(-120).toISOString() }],
      attachments: [],
      discussion: [{ author: "Rita Alvarez", body: "Confirming we are taking it off our asset register.",
        createdAt: at(-59).toISOString() }],
      activity: [{ actor: HOUSE.owner.name, action: "archived", field: "", newValue: "",
        createdAt: at(-58).toISOString() }],
    },
  });

  // ── Conversation ─────────────────────────────────────────────────────────
  section("Discussions, messages and the inbox");
  await db.insert(discussionPosts).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), author: "Rita Alvarez", authorEmail: "rita@ellisonbio.example",
      authorOrgId: ellison.id, audience: "all",
      body: "Any word on the checkout date? We are trying to plan the validation runs around it.", createdAt: at(-5, 17) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), author: HOUSE.tess.name, authorEmail: HOUSE.tess.email,
      authorOrgId: null, audience: "all",
      body: "Tune passed this morning at 61,400 counts - report is on the system. One carryover re-run and it is yours.",
      createdAt: at(-2, 22) },
    // Ours, and not the client's business: the margin note that has to stay in.
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), author: OWNER, authorEmail: OWNER,
      authorOrgId: null, audience: "internal",
      body: "Quoted the checkout high on purpose - it covers a second tune pass if the carryover fights us.",
      createdAt: at(-2, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1007"), author: "Sam Okafor", authorEmail: "sam@northharbor.example",
      authorOrgId: harbor.id, audience: "all",
      body: "Is there any way to get a loaner while the board is stuck? We are turning work away.", createdAt: at(-11, 16) },
    { tenantOrgId: T, instrumentId: sid("CIS-1007"), author: OWNER, authorEmail: OWNER,
      authorOrgId: null, audience: "all",
      body: "Nothing of ours matches the 7700, but I can ask Vantage. Give me until Thursday.", createdAt: at(-11, 19) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), author: "Vantage dispatch", authorEmail: "dispatch@vantagesci.example",
      authorOrgId: vantage.id, audience: "all",
      body: "Booked for the 14th. Two engineers, full day. Cryogen will be on our truck.", createdAt: at(-6, 18) },
    // The General board is one room per organization - a client post here is
    // readable by that client and the operator, and by nobody else.
    { tenantOrgId: T, instrumentId: null, roomOrgId: ellison.id, author: "Rita Alvarez",
      authorEmail: "rita@ellisonbio.example", authorOrgId: ellison.id, audience: "all",
      body: "Our fiscal year starts in October - can we get budgetary numbers for a second GC before then?",
      createdAt: at(-3, 16) },
    { tenantOrgId: T, instrumentId: null, roomOrgId: ellison.id, author: OWNER, authorEmail: OWNER,
      authorOrgId: null, audience: "all",
      body: "Rough numbers are drafted as Q-3006. I will send it once I have the lead time in writing.",
      createdAt: at(-2, 20) },
    { tenantOrgId: T, instrumentId: null, roomOrgId: null, author: OWNER, authorEmail: OWNER,
      authorOrgId: null, audience: "internal",
      body: "Reminder: nothing goes out of the cleanroom without QA counter-signing. No exceptions, however late we are.",
      createdAt: at(-9, 17) },
  ]);

  const [thread] = await db.insert(messageThreads).values({
    tenantOrgId: T, title: "CIS-1001 release and familiarisation", createdBy: OWNER,
    createdAt: at(-4), lastMessageAt: at(0, 16),
  }).returning();
  const [thread2] = await db.insert(messageThreads).values({
    tenantOrgId: T, title: "NMR - Vantage scheduling", createdBy: HOUSE.tess.email,
    createdAt: at(-7), lastMessageAt: at(-6, 18),
  }).returning();
  await db.insert(threadMembers).values([
    { threadId: thread.id, email: OWNER, name: HOUSE.owner.name, orgName: ORG_NAME, addedBy: OWNER, lastReadAt: at(0, 16), createdAt: at(-4) },
    { threadId: thread.id, email: HOUSE.tess.email, name: HOUSE.tess.name, orgName: ORG_NAME, addedBy: OWNER, lastReadAt: at(-1, 12), createdAt: at(-4) },
    { threadId: thread.id, email: "rita@ellisonbio.example", name: "Rita Alvarez", orgName: "Ellison BioLabs", addedBy: OWNER, lastReadAt: at(0, 14), createdAt: at(-4) },
    { threadId: thread2.id, email: HOUSE.tess.email, name: HOUSE.tess.name, orgName: ORG_NAME, addedBy: HOUSE.tess.email, lastReadAt: at(-6, 18), createdAt: at(-7) },
    { threadId: thread2.id, email: "dispatch@vantagesci.example", name: "Vantage dispatch", orgName: "Vantage Scientific", addedBy: HOUSE.tess.email, createdAt: at(-7) },
    { threadId: thread2.id, email: OWNER, name: HOUSE.owner.name, orgName: ORG_NAME, addedBy: HOUSE.tess.email, leftAt: at(-5), createdAt: at(-7) },
  ]);
  await db.insert(messages).values([
    { threadId: thread.id, authorEmail: "rita@ellisonbio.example", authorName: "Rita Alvarez",
      body: "Could we do Thursday morning for the familiarisation? Two of our analysts can be free.", createdAt: at(-4, 17) },
    { threadId: thread.id, authorEmail: OWNER, authorName: HOUSE.owner.name,
      body: "Thursday 9 to 11 works. Priya will run it and bring the packet.", createdAt: at(-4, 19) },
    { threadId: thread.id, authorEmail: HOUSE.tess.email, authorName: HOUSE.tess.name,
      body: "One carryover re-run outstanding. If it clears tomorrow we are on for Thursday.", createdAt: at(-1, 20) },
    { threadId: thread.id, authorEmail: "rita@ellisonbio.example", authorName: "Rita Alvarez",
      body: "Understood. I will hold the room either way.", createdAt: at(0, 16) },
    { threadId: thread2.id, authorEmail: HOUSE.tess.email, authorName: HOUSE.tess.name,
      body: "Console is up and locking. When can you get the shim and fill done?", createdAt: at(-7, 16) },
    { threadId: thread2.id, authorEmail: "dispatch@vantagesci.example", authorName: "Vantage dispatch",
      body: "The 14th, two engineers. We will bring cryogen.", createdAt: at(-6, 18) },
    // Deleted, which the thread has to be able to show without pretending it
    // never happened.
    { threadId: thread2.id, authorEmail: HOUSE.tess.email, authorName: HOUSE.tess.name,
      body: "(withdrawn)", deletedAt: at(-6, 19), createdAt: at(-6, 18) },
  ]);

  await db.insert(notifications).values([
    { email: OWNER, kind: "access_request", title: "North Harbor asked to see CIS-1009",
      href: `/instruments/${sid("CIS-1009")}`, createdAt: at(-2, 14) },
    { email: OWNER, kind: "discussion", title: "Rita Alvarez posted in the Ellison BioLabs room",
      href: "/discussions", createdAt: at(-3, 16) },
    { email: OWNER, kind: "gas_empty", title: "Helium marked empty on CIS-1002",
      href: `/instruments/${sid("CIS-1002")}`, createdAt: at(0, 15) },
    { email: OWNER, kind: "renewal", title: "AGR-2025-04 is inside its 60-day notice window",
      href: "/money/contracts", createdAt: at(-1, 15) },
    { email: OWNER, kind: "message", title: "Rita Alvarez: \"I will hold the room either way.\"",
      href: `/messages/${thread.id}`, createdAt: at(0, 16) },
    { email: OWNER, kind: "sign_in", title: "Jules Ferrand signed in for the first time",
      href: "/settings/activity", createdAt: at(-255), readAt: at(-254) },
    { email: OWNER, kind: "drop", title: "Two files arrived on \"Method files from Rita\"",
      href: "/documents", createdAt: at(-3, 18), readAt: at(-3, 20) },
    { email: HOUSE.tess.email, kind: "task_assigned", title: "You were assigned: Carryover study",
      href: `/work/${wo("WO-2043")}`, createdAt: at(-6, 18) },
    { email: HOUSE.tess.email, kind: "queue", title: "CIS-1003 came back into our queue",
      href: `/instruments/${sid("CIS-1003")}`, createdAt: at(-4, 12) },
    { email: HOUSE.owen.email, kind: "parts_request", title: "Meridian asked us to order the curtain plate",
      href: `/work/${wo("WO-2049")}`, createdAt: at(-9, 16), readAt: at(-9, 17) },
    { email: HOUSE.priya.email, kind: "mention", title: "Tess mentioned you on \"Answer QA on the pressure trace\"",
      href: `/instruments/${sid("CIS-1003")}`, createdAt: at(-3, 19) },
    { email: "rita@ellisonbio.example", kind: "handoff", title: "CIS-1014 was handed over to Ellison BioLabs",
      href: `/instruments/${sid("CIS-1014")}`, createdAt: at(-16, 22), readAt: at(-15, 15) },
  ]);

  // The held-email queue, both rows ALREADY SENT.
  //
  // A pending row here would not be a picture of the feature, it would be an
  // email: flushOutbox selects every unsent due row on the instance with no
  // tenant predicate (lib/outboxData), and it is driven by the notifications
  // poller every open tab runs - so the first real user to open a tab would
  // mail tess@cascadeinstrument.example within about a minute. Sent rows show
  // the same history and post nothing.
  await db.insert(emailOutbox).values([
    { email: HOUSE.tess.email, kind: "task_assigned", title: "You were assigned: Carryover study",
      href: `/work/${wo("WO-2043")}`, subject: "A task is waiting for you", actor: HOUSE.owner.name,
      context: "CIS-1001", item: "Carryover study", sendAfter: at(0, 17), sendBy: at(0, 17),
      sentAt: at(0, 17), createdAt: at(0, 17) },
    { email: OWNER, kind: "gas_empty", title: "Helium marked empty on CIS-1002",
      href: `/instruments/${sid("CIS-1002")}`, subject: "Helium is empty on CIS-1002",
      actor: HOUSE.owen.name, context: "CIS-1002", item: "Helium",
      sendAfter: at(-1, 15), sendBy: at(-1, 17), sentAt: at(-1, 15, 2), createdAt: at(-1, 15) },
  ]);

  // ── The mail stop ────────────────────────────────────────────────────────
  // Every notification kind, switched off for every address the demo invents.
  //
  // This is the one thing standing between a demo tenant and real outbound
  // mail. Two crons notify without anybody pressing anything - the weekly
  // usage report and the weekly renewal warning, and the seed deliberately
  // plants a contract inside its notice window so the second one fires. Both
  // reach the WORKSPACE's staff, who here are four invented people on a
  // reserved domain, so every message would hard-bounce against the operator's
  // real sending reputation for as long as the demo exists.
  //
  // Switching them off in the product's own opt-out table rather than by some
  // flag of my own matters: lib/notify writes the in-app row FIRST and filters
  // recipients afterwards (lib/inbox.emailAllowed), so the bell still lights
  // up, the inbox still fills, and the demo still shows the feature working.
  // Only the envelope is dropped. Whoever holds the keys can turn any of these
  // back on from Settings, which is the same switch a real operator uses.
  //
  // --mail-to says "I want this demo to send"; then nothing is suppressed.
  if (!MAIL_TO) {
    await db.insert(notificationPrefs).values(
      demoEmails().flatMap((email) => NOTIFY_KINDS.map((k) => ({ email, kind: k.kind, emailOn: false }))),
    ).onConflictDoNothing();
  }

  // A saved panel layout, so "view as this person" reproduces THEIR screen and
  // not a generic one.
  await db.insert(uiLayouts).values([
    { email: HOUSE.tess.email, viewKey: "system",
      data: { order: ["tasks", "parts", "gases", "files", "discussion"], right: ["gases", "files"], hidden: ["custody"] },
      updatedAt: at(-20) },
    { email: OWNER, viewKey: "asset",
      data: { order: ["history", "files", "notes"], right: ["files"], hidden: [] }, updatedAt: at(-45) },
  ]).onConflictDoNothing();

  // ── The day's report ─────────────────────────────────────────────────────
  // One row per system per day, plus the off-system lines that are the only
  // record a phone-support client ever gets.
  section("EOD, catalog, remote and the trail");
  await db.insert(eodUpdates).values([
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), date: day(0), ownerOrgId: ellison.id,
      title: "Carryover re-run", person: HOUSE.tess.name, minutes: 150,
      systemUpdate: "Re-ran the carryover set with a longer needle wash. Blank 1 down to 0.06%, the rest below the LLOQ.",
      actionItem: "Confirm Thursday for the familiarisation", updatedBy: HOUSE.tess.email, updatedAt: at(0, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), date: day(0), ownerOrgId: ellison.id,
      title: "Tune on cal gas", person: HOUSE.owen.name, minutes: 210,
      systemUpdate: "Base pressure held overnight at 8.4e-3 mbar. Cal gas tune started; mass axis is within 0.1 amu.",
      actionItem: "Helium is empty - Airgas delivery Thursday", updatedBy: HOUSE.owen.email, updatedAt: at(0, 23) },
    // House-only: it must show to staff and never reach the client edition.
    { tenantOrgId: T, instrumentId: sid("CIS-1007"), date: day(0), ownerOrgId: harbor.id,
      title: "Board chase", person: HOUSE.dana.name, minutes: 15, internal: true,
      systemUpdate: "Agilent still will not commit to a date. Worth pricing the rebuilt exchange unit before Sam asks again.",
      actionItem: "", updatedBy: HOUSE.dana.email, updatedAt: at(0, 22) },
    // Off-system: no instrument, no asset. The whole reason the row shape allows it.
    { tenantOrgId: T, instrumentId: null, assetId: null, date: day(0), ownerOrgId: keystone.id,
      title: "Phone support - headspace carryover", person: HOUSE.priya.name, minutes: 25,
      systemUpdate: "Their chemist called about carryover on a headspace method. Loop temperature was below the transfer line.",
      actionItem: "Send the headspace SOP", updatedBy: HOUSE.priya.email, updatedAt: at(0, 20) },
    // Yesterday, because the digest sends the previous day.
    { tenantOrgId: T, instrumentId: sid("CIS-1002"), date: day(-1), ownerOrgId: ellison.id,
      title: "Leak check and pump-down", person: HOUSE.owen.name, minutes: 240,
      systemUpdate: "New turbo at speed. Backing pressure 2.1e-2 mbar at 30 minutes and falling; foreline joints all tight.",
      actionItem: "Cal gas tune once base pressure holds overnight", updatedBy: HOUSE.owen.email, updatedAt: at(-1, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1001"), date: day(-1), ownerOrgId: ellison.id,
      title: "Margin note", person: HOUSE.owner.name, minutes: 5, internal: true,
      systemUpdate: "Checkout quoted high on purpose - a second tune pass is covered if the carryover fights us.",
      actionItem: "", updatedBy: OWNER, updatedAt: at(-1, 23) },
    { tenantOrgId: T, instrumentId: sid("CIS-1012"), date: day(-1), ownerOrgId: ellison.id,
      title: "Console bring-up finished", person: HOUSE.tess.name, minutes: 180,
      systemUpdate: "Console boots, locks on the lock channel, amplifiers in spec. Magnet work sits with Vantage on the 14th.",
      actionItem: "", updatedBy: HOUSE.tess.email, updatedAt: at(-1, 22) },
    // Skipped: written, and deliberately left out of the mail.
    { tenantOrgId: T, instrumentId: sid("CIS-1011"), date: day(-1), ownerOrgId: meridian.id,
      title: "No movement", person: HOUSE.owen.name, minutes: 0, skipped: true,
      systemUpdate: "Nothing today. Still waiting on the vendors.", actionItem: "",
      updatedBy: HOUSE.owen.email, updatedAt: at(-1, 21) },
  ]);

  // ── The equipment catalog ────────────────────────────────────────────────
  // What the shop knows about the models it works on, and the handful of pages
  // it is willing to publish where a search engine can find them.
  await db.insert(vocabTerms).values([
    { tenantOrgId: T, kind: "category", assetType: "", name: "LC-MS", createdAt: at(-400) },
    { tenantOrgId: T, kind: "category", assetType: "", name: "GC-MS", createdAt: at(-400) },
    { tenantOrgId: T, kind: "category", assetType: "", name: "ICP-MS", createdAt: at(-400) },
    { tenantOrgId: T, kind: "category", assetType: "", name: "ICP-OES", createdAt: at(-400) },
    { tenantOrgId: T, kind: "category", assetType: "", name: "NMR", createdAt: at(-400) },
    { tenantOrgId: T, kind: "category", assetType: "", name: "IC", createdAt: at(-400) },
    { tenantOrgId: T, kind: "asset_type", assetType: "", name: "Mass spec", createdAt: at(-400) },
    { tenantOrgId: T, kind: "asset_type", assetType: "", name: "Pump", createdAt: at(-400) },
    { tenantOrgId: T, kind: "asset_type", assetType: "", name: "Autosampler", createdAt: at(-400) },
    { tenantOrgId: T, kind: "asset_type", assetType: "", name: "Column oven", createdAt: at(-400) },
    { tenantOrgId: T, kind: "asset_type", assetType: "", name: "Vacuum pump", createdAt: at(-400) },
    { tenantOrgId: T, kind: "model", assetType: "Mass spec", name: "6495C", manufacturer: "Agilent",
      categories: ["LC-MS"], gases: ["Nitrogen", "Argon"], docTypes: ["Tune report", "Test data"],
      // published:false, deliberately. The public catalog is served to anyone,
      // unauthenticated, from the instance's own domain - so a published demo
      // model would put an invented company's marketing page on the real
      // operator's website, where a search engine would find it. The feature is
      // one toggle away in Settings > Equipment if the buyer wants to see it.
      photoUrl: heroPhoto.url, published: false, publicSlug: "agilent-6495c",
      publicSummary: "Triple quadrupole LC-MS/MS for regulated bioanalysis. We refurbish, install, qualify and support these.",
      specs: JSON.stringify([
        { name: "Mass range", value: "5-1400 m/z" }, { name: "Scan speed", value: "5000 Da/s" },
        { name: "Polarity switching", value: "20 ms" }, { name: "Source", value: "Agilent Jet Stream" },
      ]), createdAt: at(-400) },
    { tenantOrgId: T, kind: "model", assetType: "Mass spec", name: "LCMS-8060NX", manufacturer: "Shimadzu",
      categories: ["LC-MS"], gases: ["Nitrogen", "Argon"], docTypes: ["Tune report", "Report"],
      published: false, publicSlug: "shimadzu-lcms-8060nx",
      publicSummary: "High-sensitivity triple quadrupole. IQ/OQ execution and annual re-qualification available.",
      specs: JSON.stringify([
        { name: "Mass range", value: "2-2000 m/z" }, { name: "Scan speed", value: "30000 u/s" },
        { name: "Polarity switching", value: "5 ms" },
      ]), createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Mass spec", name: "ISQ 7000", manufacturer: "Thermo",
      categories: ["GC-MS"], gases: ["Helium", "Nitrogen"], specs: JSON.stringify([
        { name: "Mass range", value: "1.2-1100 m/z" }, { name: "Source", value: "ExtractaBrite, vacuum probe" },
      ]), createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Mass spec", name: "7700x", manufacturer: "Agilent",
      categories: ["ICP-MS"], gases: ["Argon"], createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Mass spec", name: "Xevo TQ-S micro", manufacturer: "Waters",
      categories: ["LC-MS"], gases: ["Nitrogen", "Argon"], photoUrl: listingPhoto.url,
      published: false, publicSlug: "waters-xevo-tq-s-micro",
      publicSummary: "Compact tandem quadrupole. Refurbished units in stock; source rebuilds a speciality.",
      createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Pump", name: "1290 Infinity II Flex", manufacturer: "Agilent",
      categories: ["LC-MS"], createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Vacuum pump", name: "nXDS15i", manufacturer: "Edwards",
      categories: [], createdAt: at(-398) },
    { tenantOrgId: T, kind: "model", assetType: "Autosampler", name: "TriPlus RSH", manufacturer: "Thermo",
      categories: ["GC-MS"], createdAt: at(-398) },
  ]).onConflictDoNothing();

  await db.insert(catalogRefs).values([
    { tenantOrgId: T, assetType: "Mass spec", model: "6495C", kind: "link",
      title: "Agilent 6495C user manual (vendor site)", url: "https://www.agilent.com/",
      createdBy: OWNER, createdAt: at(-380) },
    { tenantOrgId: T, assetType: "Mass spec", model: "6495C", kind: "note",
      title: "Source clean - what we have learned",
      body: "Bead-blast the cone at 12 micron, never 25. The heavier grit rounds the aperture and costs you 20% of the signal.\nSonicate 15 minutes, no longer - the PEEK insert swells.",
      provenance: "Owen, after three of them", createdBy: HOUSE.owen.email, createdAt: at(-120) },
    { tenantOrgId: T, assetType: "Mass spec", model: "", kind: "note", title: "Vent order, all makes",
      body: "Gas off, then heaters, then vent. Venting a hot source pulls oil back through the foreline every time.",
      createdBy: OWNER, createdAt: at(-300) },
    { tenantOrgId: T, assetType: "Vacuum pump", model: "nXDS15i", kind: "link",
      title: "Edwards nXDS tip seal procedure", url: "https://www.edwardsvacuum.com/",
      createdBy: HOUSE.owen.email, createdAt: at(-290) },
    { tenantOrgId: T, assetType: "Pump", model: "1290 Infinity II Flex", kind: "note",
      title: "Seal run-in", body: "5 mL/min of water for 20 minutes before any pressure test. Skipping it is why a new seal weeps at 400 bar.",
      createdBy: HOUSE.tess.email, createdAt: at(-160) },
  ]);

  // ── Remote support ───────────────────────────────────────────────────────
  // Enrolled controllers. Consent is derived from custody, not from a toggle:
  // the shipped unit prompts, the bench unit does not, and one is overridden by
  // hand with the reason on the record.
  await db.insert(remoteDevices).values([
    { tenantOrgId: T, orgId: ellison.id, instrumentId: sid("CIS-1001"), nodeId: "demo-node-cis1001",
      name: "EBL-LCMS-01", nickname: "Bay 1 controller", platform: "windows",
      lastSeenAt: at(0, 16), enrolledBy: HOUSE.tess.email, createdAt: at(-60) },
    { tenantOrgId: T, orgId: ellison.id, instrumentId: sid("CIS-1014"), nodeId: "demo-node-cis1014",
      name: "EBL-PREPLC-01", nickname: "QC prep LC", platform: "windows",
      lastSeenAt: at(-1, 20), enrolledBy: HOUSE.tess.email, createdAt: at(-24) },
    { tenantOrgId: T, orgId: ellison.id, instrumentId: sid("CIS-1003"), nodeId: "demo-node-cis1003",
      name: "EBL-CLEAN-01", nickname: "Cleanroom 8060", platform: "windows",
      // Regulated area: always ask, whatever custody says.
      consentOverride: true, lastSeenAt: at(-2, 18), enrolledBy: HOUSE.priya.email, createdAt: at(-118) },
    { tenantOrgId: T, orgId: null, instrumentId: sid("CIS-1002"), nodeId: "demo-node-bench2",
      name: "CIS-BENCH-02", nickname: "Bay 2 bench PC", platform: "windows",
      lastSeenAt: at(0, 17), enrolledBy: HOUSE.owen.email, createdAt: at(-38) },
    { tenantOrgId: T, orgId: meridian.id, instrumentId: null, nodeId: "demo-node-meridian-bench",
      name: "MIE-BENCH-01", nickname: "Tacoma bench", platform: "linux",
      lastSeenAt: at(-9, 19), enrolledBy: HOUSE.owen.email, createdAt: at(-70) },
  ]);

  // ── The trail ────────────────────────────────────────────────────────────
  await db.insert(loginEvents).values([
    { email: OWNER, method: "password", role: "owner", orgId: null, orgName: "", operatorOrgId: T,
      ip: "198.51.100.24", userAgent: "Mozilla/5.0 (Macintosh)", createdAt: at(0, 15) },
    { email: HOUSE.tess.email, method: "code", role: "staff", orgId: null, orgName: "", operatorOrgId: T,
      ip: "198.51.100.77", userAgent: "Mozilla/5.0 (iPhone)", createdAt: at(0, 16) },
    { email: HOUSE.owen.email, method: "code", role: "staff", orgId: null, orgName: "", operatorOrgId: T,
      ip: "198.51.100.31", userAgent: "Mozilla/5.0 (Windows NT 10.0)", createdAt: at(-1, 22) },
    { email: "rita@ellisonbio.example", method: "code", role: "client_editor", orgId: ellison.id,
      orgName: "Ellison BioLabs", operatorOrgId: T, ip: "203.0.113.14",
      userAgent: "Mozilla/5.0 (Windows NT 10.0)", createdAt: at(0, 14) },
    { email: "jules@meridianexchange.example", method: "code", role: "client_editor", orgId: meridian.id,
      orgName: "Meridian Instrument Exchange", operatorOrgId: T, ip: "203.0.113.88",
      userAgent: "Mozilla/5.0 (Macintosh)", createdAt: at(0, 13) },
    { email: "sam@northharbor.example", method: "code", role: "client_viewer", orgId: harbor.id,
      orgName: "North Harbor Diagnostics", operatorOrgId: T, ip: "203.0.113.51",
      userAgent: "Mozilla/5.0 (iPad)", createdAt: at(-2, 21) },
  ]);

  await db.insert(trailEvents).values([
    { kind: "page", email: OWNER, role: "owner", operatorOrgId: T, route: "/", at: at(0, 15) },
    { kind: "page", email: OWNER, role: "owner", operatorOrgId: T, route: "/money/collections", at: at(0, 15, 4) },
    { kind: "page", email: "rita@ellisonbio.example", role: "client_editor", orgId: ellison.id,
      orgName: "Ellison BioLabs", operatorOrgId: T, route: "/units", at: at(0, 14) },
    { kind: "page", email: "rita@ellisonbio.example", role: "client_editor", orgId: ellison.id,
      orgName: "Ellison BioLabs", operatorOrgId: T, route: `/instruments/${sid("CIS-1001")}`, at: at(0, 14, 3) },
    { kind: "error", email: HOUSE.owen.email, role: "staff", operatorOrgId: T, route: "/api/export/parts",
      message: "Export timed out after 30s", detail: "Retried and succeeded on the second attempt.",
      at: at(-4, 19) },
  ]);

  // Routed miles, pre-computed so the travel strip has an answer without a
  // geocoding call at seed time.
  await db.insert(driveCache).values([
    { memberEmail: OWNER, siteId: site("Hillsboro"), miles: 21.4, fromLat: 45.5054, fromLng: -122.6427,
      toLat: 45.5301, toLng: -122.9432, estimated: false, computedAt: at(-30) },
    { memberEmail: OWNER, siteId: site("Bend"), miles: 168.2, fromLat: 45.5054, fromLng: -122.6427,
      toLat: 44.0763, toLng: -121.3153, estimated: false, computedAt: at(-30) },
    { memberEmail: HOUSE.tess.email, siteId: site("Pier Road"), miles: 96.8, fromLat: 45.5476, fromLng: -122.6668,
      toLat: 46.1879, toLng: -123.8313, estimated: false, computedAt: at(-20) },
    { memberEmail: HOUSE.owen.email, siteId: site("Tacoma"), miles: 151.6, fromLat: 45.4611, fromLng: -122.7010,
      toLat: 47.2529, toLng: -122.4187, estimated: false, computedAt: at(-25) },
  ]).onConflictDoNothing();

  // ── The audit log ────────────────────────────────────────────────────────
  // Append-only in the product, and written here so the trail does not start on
  // the day the demo was opened. Every line is stamped with the tenant, which
  // is also what lets `--wipe` find them again.
  await db.insert(auditLog).values([
    { tenantOrgId: T, actor: OWNER, entityType: "org", entityId: String(T),
      action: `opened a workspace for "${ORG_NAME}" with ${OWNER} as its first owner`, createdAt: at(-410) },
    { tenantOrgId: T, actor: OWNER, entityType: "house", entityId: HOUSE.tess.email,
      action: `granted ${HOUSE.tess.email} staff access to the whole shop`, field: "role",
      newValue: "staff", createdAt: at(-380) },
    { tenantOrgId: T, actor: OWNER, entityType: "org", entityId: String(ellison.id),
      action: "added Ellison BioLabs as a client organization", createdAt: at(-395) },
    { tenantOrgId: T, actor: HOUSE.tess.email, instrumentId: sid("CIS-1007"), entityType: "instrument",
      entityId: String(sid("CIS-1007")), action: "marked CIS-1007 waiting / blocked",
      field: "blockedReason", newValue: "Waiting on the RF generator board from Agilent - backordered, no ETA since the 9th.",
      createdAt: at(-12) },
    { tenantOrgId: T, actor: HOUSE.owen.email, instrumentId: sid("CIS-1002"), assetId: aid("ISQ70-24118"),
      entityType: "part", entityId: "EXT255H", action: "marked the turbo Installed on CIS-1002",
      field: "status", oldValue: "Received", newValue: "Installed", createdAt: at(-7) },
    { tenantOrgId: T, actor: HOUSE.tess.email, instrumentId: sid("CIS-1001"), entityType: "task",
      entityId: String(task("Reserpine sensitivity").id),
      action: "recorded 61,400 counts on \"Reserpine sensitivity\" - pass", createdAt: at(-2, 21) },
    { tenantOrgId: T, actor: HOUSE.dana.email, entityType: "invoice", entityId: String(iv("INV-2042")),
      action: "sent INV-2042 to Ellison BioLabs", field: "status", oldValue: "draft", newValue: "sent",
      createdAt: at(-9) },
    { tenantOrgId: T, actor: OWNER, entityType: "invoice", entityId: String(iv("INV-2039")),
      action: "waived the late fee on INV-2039", field: "waived", oldValue: "false", newValue: "true",
      createdAt: at(-3) },
    { tenantOrgId: T, actor: "rita@ellisonbio.example", entityType: "quote", entityId: String(q("Q-3002")),
      action: "approved Q-3002", field: "status", oldValue: "sent", newValue: "approved", createdAt: at(-9) },
    { tenantOrgId: T, actor: OWNER, entityType: "org", entityId: String(harbor.id),
      action: "granted North Harbor Diagnostics a credit-hold override until " + day(21),
      createdAt: at(-9) },
    { tenantOrgId: T, actor: HOUSE.priya.email, instrumentId: sid("CIS-1003"), entityType: "signature",
      entityId: String(doc("DEV-2026-011")), action: "revoked the approval signature on DEV-2026-011",
      field: "revokeReason", newValue: "Signed against the wrong probe's trace.", createdAt: at(-20) },
    { tenantOrgId: T, actor: OWNER, instrumentId: sid("CIS-1000"), entityType: "instrument",
      entityId: String(sid("CIS-1000")), action: "archived CIS-1000", field: "archived",
      oldValue: "false", newValue: "true", createdAt: at(-58) },
  ]);

  // ── What was built ───────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log(`  ${ORG_NAME} is ready.\n`);
  console.log("  Sign in");
  console.log(`    ${OWNER}`);
  console.log(chosen
    ? "    password: the one you supplied (not printed - this output may be a CI log)"
    : `    password: ${password}   (generated - change it in Settings, or supply DEMO_PASSWORD next time)`);
  console.log("    or ask for a six-digit code at /login, which reaches the same account.\n");
  const live = sysRows.filter((r) => !r.archived).length;
  console.log("  What is in there");
  console.log("    5 client organizations: a regulated lab, a late payer, a reseller,");
  console.log("      another service company, and one with nothing on the bench");
  console.log(`    ${live} live systems (+${sysRows.length - live} archived) across every stage, `
    + `${assetRows.length + 1} modules`);
  console.log(`    ${wos.length} work orders in all six states, ${tk.length} tasks, ${cl.length} checklist items`);
  console.log(`    ${qs.length} quotes and ${inv.length} invoices across every status, `
    + "a collections ladder mid-climb");
  console.log(`    ${agr.length} agreements, ${pos.length} purchase orders, ${rooms.length} stockrooms, `
    + `${cat.length} catalog parts`);
  console.log(`    ${docs.length + 1} validation documents with signatures, 2 release sign-offs, `
    + `${shares.length} share links`);
  console.log(`    ${files.length} files - ${blobUp > 0 ? `${blobUp} uploaded to Blob` : "stored inline, no Blob store configured"}`);
  console.log("");
  console.log("  Try these first");
  console.log("    /                      the board, with what is blocked and whose move it is");
  console.log("    /money                 the position: what is owed, what is late, what a job cost");
  console.log("    /money/collections     North Harbor, 47 days past due, three rungs climbed");
  console.log(`    /money/quotes/${q("Q-3001")}         a quote out with a client, opened twice`);
  console.log(`    /instruments/${sid("CIS-1003")}        the regulated one: validation docs and signatures`);
  console.log("    /settings/organizations  the five client shapes, and what each may see");
  console.log("");
  if (notes.length) {
    console.log("  Worth knowing");
    for (const n of notes) console.log(`    - ${n}`);
    console.log("");
  }
  console.log("  To rebuild:  npx tsx scripts/seed-demo.ts --reset");
  console.log("  To remove:   npx tsx scripts/seed-demo.ts --wipe");
  console.log("─".repeat(72) + "\n");
}

main().catch((e) => {
  console.error(`\n  Failed: ${(e as Error).message}\n`);
  process.exit(1);
});
