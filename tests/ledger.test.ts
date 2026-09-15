// The journal's four invariants, against a real Postgres.
//
// An in-process PGlite seeded from the same drizzle/schema-sync.sql every
// deploy applies, because two of the guarantees live in the database itself
// (the one-side CHECK, the posting-key unique index) and a test with a stubbed
// db would be checking that my mock refuses rather than that Postgres does.
//
//   1. Append-only: there is no update or delete path; a correction is a
//      mirror entry that nets to zero.
//   2. Balanced: post() refuses debits != credits, and the CHECK refuses a
//      line that is both or neither.
//   3. Closed months refuse postings; reversals date today.
//   4. A bank-matched entry cannot be reversed on our side alone.
//   5. Sums are tenant-scoped.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const SIERRA = 1, OTHER = 2;
const TODAY = "2026-09-14";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind, is_operator) VALUES
      ('Sierra Spectra', 'provider', true),
      ('Another Shop',   'provider', true),
      ('Lab Zen',        'client',   false);
  `);
});

const ledger = () => import("@/lib/ledger");

/** A deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe("post()", () => {
  it("refuses an entry whose debits do not equal its credits", async () => {
    const { post, LedgerError } = await ledger();
    await expect(post({
      on: TODAY, memo: "lopsided", ref: { type: "bank", id: "x" }, postedBy: "t", tenantOrgId: SIERRA,
      lines: [{ account: "bank", debitCents: 100 }, { account: "receivable", creditCents: 90 }],
    })).rejects.toBeInstanceOf(LedgerError);
    await expect(post({
      on: TODAY, memo: "lopsided", ref: { type: "bank", id: "x" }, postedBy: "t", tenantOrgId: SIERRA,
      lines: [{ account: "bank", debitCents: 100 }, { account: "receivable", creditCents: 90 }],
    })).rejects.toMatchObject({ code: "unbalanced" });
  });

  it("refuses a line that is both sides, neither side, negative, or not in the chart", async () => {
    const { checkLines } = await ledger();
    expect(() => checkLines([{ account: "bank", debitCents: 5, creditCents: 5 }, { account: "receivable", creditCents: 0 }])).toThrow(/debit or a credit/);
    expect(() => checkLines([{ account: "bank" }, { account: "receivable", creditCents: 5 }])).toThrow(/debit or a credit/);
    expect(() => checkLines([{ account: "bank", debitCents: -5 }, { account: "receivable", creditCents: 5 }])).toThrow(/whole cents/);
    expect(() => checkLines([{ account: "misc" as never, debitCents: 5 }, { account: "receivable", creditCents: 5 }])).toThrow(/not an account/);
    expect(() => checkLines([{ account: "bank", debitCents: 5 }])).toThrow(/at least two/);
  });

  it("the database refuses a one-sided line too, so no other writer can slip one in", async () => {
    await client.exec(`INSERT INTO ledger_entries (tenant_org_id, posted_on, memo) VALUES (${SIERRA}, '${TODAY}', 'raw')`);
    const [{ id }] = (await client.query<{ id: number }>("SELECT max(id) AS id FROM ledger_entries")).rows;
    await expect(client.exec(`INSERT INTO ledger_lines (entry_id, account, debit_cents, credit_cents) VALUES (${id}, 'bank', 5, 5)`))
      .rejects.toThrow(/ledger_lines_one_side_check/);
    await expect(client.exec(`INSERT INTO ledger_lines (entry_id, account, debit_cents, credit_cents) VALUES (${id}, 'bank', 0, 0)`))
      .rejects.toThrow(/ledger_lines_one_side_check/);
    await client.exec(`DELETE FROM ledger_entries WHERE id = ${id}`);   // test scaffolding only
  });

  it("a random batch of balanced postings always sums to a balanced journal", async () => {
    const { post, accountSums, ACCOUNT_KEYS } = await ledger();
    const r = rng(20260914);
    let expectedDr = 0;
    for (let i = 0; i < 40; i++) {
      const cents = 1 + Math.floor(r() * 500000);
      const a = ACCOUNT_KEYS[Math.floor(r() * ACCOUNT_KEYS.length)];
      let b = ACCOUNT_KEYS[Math.floor(r() * ACCOUNT_KEYS.length)];
      if (b === a) b = ACCOUNT_KEYS[(ACCOUNT_KEYS.indexOf(a) + 1) % ACCOUNT_KEYS.length];
      // Some entries split one side across two accounts.
      const split = r() < 0.3 && cents > 1 ? Math.floor(cents / 2) : 0;
      const lines = split
        ? [{ account: a, debitCents: cents }, { account: b, creditCents: cents - split }, { account: "revenue_fees" as const, creditCents: split }]
        : [{ account: a, debitCents: cents }, { account: b, creditCents: cents }];
      // Fix any account collision the split introduced by letting post()
      // judge balance only - a debit and a credit on one account is legal.
      await post({ on: TODAY, memo: `random ${i}`, ref: { type: "bank", id: `rnd-${i}` }, kind: "post", postedBy: "t", tenantOrgId: SIERRA, lines });
      expectedDr += cents;
    }
    const sums = await accountSums({ tenant: SIERRA, q: "random" });
    const dr = sums.reduce((n, s) => n + s.debitCents, 0);
    const cr = sums.reduce((n, s) => n + s.creditCents, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(expectedDr);
  });

  it("sums by account equal the sum of the lines", async () => {
    const { accountSums } = await ledger();
    const sums = await accountSums({ tenant: SIERRA });
    for (const s of sums) {
      const [{ dr, cr }] = (await client.query<{ dr: string; cr: string }>(
        `SELECT coalesce(sum(l.debit_cents),0) dr, coalesce(sum(l.credit_cents),0) cr
           FROM ledger_lines l JOIN ledger_entries e ON e.id = l.entry_id
          WHERE e.tenant_org_id = ${SIERRA} AND l.account = '${s.account}'`)).rows;
      expect(s.debitCents).toBe(Number(dr));
      expect(s.creditCents).toBe(Number(cr));
    }
  });

  it("posts the same key once: a retry returns the first entry", async () => {
    const { post, pair, balanceOf } = await ledger();
    const first = await post({
      on: "2026-09-02", memo: "INV-0091 sent", ref: { type: "invoice", id: 91, orgId: 3 }, kind: "send",
      postedBy: "t", tenantOrgId: SIERRA, lines: pair("receivable", "revenue_labor", 45000),
    });
    const again = await post({
      on: "2026-09-02", memo: "INV-0091 sent", ref: { type: "invoice", id: 91, orgId: 3 }, kind: "send",
      postedBy: "t", tenantOrgId: SIERRA, lines: pair("receivable", "revenue_labor", 45000),
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(await balanceOf(91, SIERRA)).toBe(45000);
  });

  it("the unique index catches a second writer that bypasses post()", async () => {
    await expect(client.exec(
      `INSERT INTO ledger_entries (tenant_org_id, posted_on, memo, ref_type, ref_id, posting_key)
       VALUES (${SIERRA}, '${TODAY}', 'dup', 'invoice', '91', 'invoice:91:send')`,
    )).rejects.toThrow(/ledger_entries_posting_key_unique/);
  });
});

describe("balanceOf and positions", () => {
  it("an invoice's balance is its receivable rows: sent, paid, fee, waiver", async () => {
    const { post, pair, balanceOf, positions } = await ledger();
    const inv = { type: "invoice" as const, id: 92, orgId: 3 };
    await post({ on: "2026-08-01", memo: "INV-0092 sent", ref: inv, kind: "send", postedBy: "t", tenantOrgId: SIERRA,
      lines: [{ account: "receivable", debitCents: 120000 }, { account: "revenue_parts", creditCents: 100000 }, { account: "sales_tax_owed", creditCents: 20000 }] });
    await post({ on: "2026-08-20", memo: "payment", ref: inv, kind: "payment:1", postedBy: "t", tenantOrgId: SIERRA, lines: pair("bank", "receivable", 50000) });
    await post({ on: "2026-09-01", memo: "late fee", ref: inv, kind: "fee:1", postedBy: "t", tenantOrgId: SIERRA, lines: pair("receivable", "revenue_fees", 1050) });
    expect(await balanceOf(92, SIERRA)).toBe(71050);
    await post({ on: "2026-09-03", memo: "fee waived", ref: inv, kind: "waive:1", postedBy: "t", tenantOrgId: SIERRA, lines: pair("revenue_fees", "receivable", 1050) });
    expect(await balanceOf(92, SIERRA)).toBe(70000);
    const { sumAccount } = await ledger();
    expect(await sumAccount("sales_tax_owed", { tenant: SIERRA, refType: "invoice", refId: "92" })).toBe(20000);
    expect((await positions(SIERRA)).receivable).toBe(
      await sumAccount("receivable", { tenant: SIERRA }));
  });

  it("does not see another workspace's rows", async () => {
    const { post, pair, positions, balanceOf, sumAccount } = await ledger();
    await post({ on: TODAY, memo: "theirs", ref: { type: "invoice", id: 500 }, kind: "send", postedBy: "t", tenantOrgId: OTHER,
      lines: pair("receivable", "revenue_labor", 999999) });
    expect(await balanceOf(500, SIERRA)).toBe(0);
    expect(await balanceOf(500, OTHER)).toBe(999999);
    expect((await positions(OTHER)).receivable).toBe(999999);
    expect(await sumAccount("revenue_labor", { tenant: OTHER })).toBe(999999);
  });
});

describe("periodFlow", () => {
  it("groups revenue and cost inside the window and reports what cash did", async () => {
    const { post, pair, periodFlow } = await ledger();
    await post({ on: "2026-07-31", memo: "July payroll", ref: { type: "payroll", id: "2026-07" }, kind: "run", postedBy: "t", tenantOrgId: SIERRA, lines: pair("payroll", "bank", 1460000) });
    await post({ on: "2026-08-31", memo: "August payroll", ref: { type: "payroll", id: "2026-08" }, kind: "run", postedBy: "t", tenantOrgId: SIERRA, lines: pair("payroll", "bank", 1460000) });
    const aug = await periodFlow(SIERRA, "2026-08-01", "2026-08-31");
    expect(aug.cost.payroll).toBe(1460000);
    expect(aug.revenue.revenue_parts).toBe(100000);     // INV-0092's parts line, sent 2026-08-01
    expect(aug.cashInCents).toBe(50000);                 // the payment on the 20th
    expect(aug.cashOutCents).toBe(1460000);
    const jul = await periodFlow(SIERRA, "2026-07-01", "2026-07-31");
    expect(jul.cost.payroll).toBe(1460000);
    expect(jul.revenue.revenue_parts).toBe(0);
  });
});

describe("reverse()", () => {
  it("nets the original to zero with a mirror dated today, and never twice", async () => {
    const { post, pair, reverse, balanceOf, entries } = await ledger();
    const inv = { type: "invoice" as const, id: 93, orgId: 3 };
    await post({ on: "2026-08-10", memo: "INV-0093 sent", ref: inv, kind: "send", postedBy: "t", tenantOrgId: SIERRA, lines: pair("receivable", "revenue_labor", 30000) });
    const pay = await post({ on: "2026-08-15", memo: "payment on INV-0093", ref: inv, kind: "payment:2", postedBy: "t", tenantOrgId: SIERRA, lines: pair("bank", "receivable", 30000) });
    expect(await balanceOf(93, SIERRA)).toBe(0);
    const rev = await reverse({ entryId: pay.id, reason: "check bounced", postedBy: "owner", today: TODAY });
    expect(rev.created).toBe(true);
    expect(await balanceOf(93, SIERRA)).toBe(30000);
    const rows = await entries({ tenant: SIERRA, refType: "invoice", refId: "93" });
    const mirror = rows.find((e) => e.id === rev.id)!;
    expect(mirror.postedOn).toBe(TODAY);          // today, not 2026-08-15
    expect(mirror.reversesId).toBe(pay.id);
    expect(mirror.memo).toContain("check bounced");
    expect(rows.find((e) => e.id === pay.id)!.reversedBy).toBe(rev.id);
    expect(mirror.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([["bank", 0, 30000], ["receivable", 30000, 0]]);
    // The original row is untouched, and a second reversal is the same one.
    const again = await reverse({ entryId: pay.id, reason: "again", postedBy: "owner", today: TODAY });
    expect(again).toEqual({ id: rev.id, created: false });
    expect(await balanceOf(93, SIERRA)).toBe(30000);
    // A live-only read drops both.
    const live = await entries({ tenant: SIERRA, refType: "invoice", refId: "93", liveOnly: true });
    expect(live.map((e) => e.id)).toEqual([rows.find((e) => e.memo === "INV-0093 sent")!.id]);
  });

  it("refuses to reverse a reversal", async () => {
    const { reverse, entries } = await ledger();
    const rows = await entries({ tenant: SIERRA, refType: "invoice", refId: "93" });
    const mirror = rows.find((e) => e.reversesId !== null)!;
    await expect(reverse({ entryId: mirror.id, reason: "no", postedBy: "t", today: TODAY })).rejects.toMatchObject({ code: "reversed" });
  });

  it("refuses to reverse an entry the bank has confirmed", async () => {
    const { post, pair, reverse } = await ledger();
    const e = await post({ on: "2026-09-04", memo: "EXP-86 paid", ref: { type: "report", id: 86 }, kind: "paid", postedBy: "t", tenantOrgId: SIERRA, lines: pair("cost_field_expenses", "bank", 14800) });
    await client.exec(`INSERT INTO bank_transactions (tenant_org_id, provider, provider_txn_id, "on", description, amount_cents, matched_entry_id)
      VALUES (${SIERRA}, 'plaid', 'txn-1', '2026-09-04', 'ZELLE TO PRIYA', -14800, ${e.id})`);
    await expect(reverse({ entryId: e.id, reason: "oops", postedBy: "t", today: TODAY })).rejects.toMatchObject({ code: "bank_confirmed" });
  });
});

describe("closing the books", () => {
  it("refuses a posting into a closed month and lets a reversal land today", async () => {
    const { post, pair, reverse, closeBooksThrough, closeProblem, isClosed, entries } = await ledger();
    expect(closeProblem("2026-09", TODAY)).toMatch(/not ended/);
    expect(closeProblem("2026-8", TODAY)).toMatch(/Pick a month/);
    expect(closeProblem("2026-08", TODAY)).toBe("");
    expect(isClosed("2026-08-31", "2026-08")).toBe(true);
    expect(isClosed("2026-09-01", "2026-08")).toBe(false);
    expect(isClosed("2026-01-01", "")).toBe(false);

    const closed = await closeBooksThrough("2026-08", TODAY);
    expect(closed).toEqual({ was: "" });
    await expect(post({ on: "2026-08-20", memo: "late", ref: { type: "bill", id: 9 }, kind: "x", postedBy: "t", tenantOrgId: SIERRA, lines: pair("overhead", "bank", 100) }))
      .rejects.toMatchObject({ code: "closed" });
    // An August entry can still be corrected - the mirror is dated today.
    const aug = (await entries({ tenant: SIERRA, refType: "payroll", refId: "2026-08" }))[0];
    const rev = await reverse({ entryId: aug.id, reason: "ran twice", postedBy: "t", today: TODAY });
    expect((await entries({ tenant: SIERRA, refType: "payroll", refId: "2026-08" })).find((e) => e.id === rev.id)!.postedOn).toBe(TODAY);
    // The backfill may write history the close would refuse.
    const hist = await post({ on: "2026-07-01", memo: "opening", ref: { type: "opening", id: SIERRA }, kind: "opening", postedBy: "backfill", tenantOrgId: SIERRA, lines: pair("bank", "opening_balance", 5850000), ignoreClose: true });
    expect(hist.created).toBe(true);
    // Reopening is allowed, and says what it was.
    expect(await closeBooksThrough("", TODAY)).toEqual({ was: "2026-08" });
  });
});

describe("there is no way to edit the journal", () => {
  it("lib/ledger never updates or deletes a ledger row", () => {
    const src = ["post", "reverse", "sums", "close", "accounts", "index"]
      .map((f) => readFileSync(`src/lib/ledger/${f}.ts`, "utf8")).join("\n");
    expect(src).not.toMatch(/\.update\(ledger/);
    expect(src).not.toMatch(/\.delete\(ledger/);
    expect(src).not.toMatch(/delete\(\)\.from\(ledger/);
  });
});
