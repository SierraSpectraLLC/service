import { describe, expect, it } from "vitest";
import { maySeeBooks, type BooksViewer } from "@/lib/books";
import { WORKING_ROOMS, isWorkingRoom, FINANCE_KEYS } from "@/lib/finance";

/**
 * Who may read an organization's books.
 *
 * The rule that had to exist: /money was gated on isStaffRole, so every
 * engineer with a login could read what the shop had invoiced, collected and
 * was owed, plus the margin on the job they had just finished. The trap this
 * file guards is the same one tests/payroll.test.ts guards one room deeper -
 * that somebody "fixes" the rule by letting staff through, or by adding the
 * platform bypass every OTHER permission in the app has.
 */

const viewer = (over: Partial<BooksViewer> = {}): BooksViewer => ({
  email: "", role: "client_viewer", orgId: null, operatorOrgId: null, canSeeMoney: false, ...over,
});

/* The shop: org 3. Bill is on the bench, and the engineer this rule is named
   after - he does the work, and does not read what it billed. */
const SHOP_OWNER = viewer({ email: "joe@sierra.test", role: "owner", operatorOrgId: 3 });
const BILL = viewer({ email: "bill@sierra.test", role: "staff", operatorOrgId: 3 });
/* Another operator on the same instance. */
const RIVAL_OWNER = viewer({ email: "own@coastal.test", role: "owner", operatorOrgId: 9 });

/* Lab Zen: org 1, a client. Rita signs the quotes; Thomas checks whether the
   LC is fixed. */
const LZ_MANAGER = viewer({ email: "rita@labzen.test", role: "client_editor", orgId: 1, canSeeMoney: true });
const THOMAS = viewer({ email: "thomas@labzen.test", role: "client_editor", orgId: 1, canSeeMoney: false });

describe("who reads an operator's books", () => {
  it("lets the owner read their own company's", () => {
    expect(maySeeBooks(SHOP_OWNER, 3)).toBe(true);
  });

  it("KEEPS THEM FROM THE BENCH - staff of the same shop", () => {
    // The whole point. Bill sees every system, every job and every part in
    // this workspace; he does not see what any of it was worth.
    expect(maySeeBooks(BILL, 3)).toBe(false);
  });

  it("does not let the flag rescue a staff account", () => {
    // A client flag on a staff row must not be a back door: the house branch
    // never consults it.
    expect(maySeeBooks({ ...BILL, canSeeMoney: true }, 3)).toBe(false);
  });

  it("keeps one operator out of another's", () => {
    expect(maySeeBooks(RIVAL_OWNER, 3)).toBe(false);
    expect(maySeeBooks(SHOP_OWNER, 9)).toBe(false);
  });

  it("keeps an owner with no workspace out of everybody's", () => {
    expect(maySeeBooks(viewer({ role: "owner", operatorOrgId: null }), 3)).toBe(false);
  });

  it("keeps clients out of an operator's, flag or no flag", () => {
    expect(maySeeBooks(LZ_MANAGER, 3)).toBe(false);
    expect(maySeeBooks({ ...LZ_MANAGER, orgId: 3 }, 3)).toBe(true); // only by BEING that org
  });
});

describe("who reads a client organization's money", () => {
  it("lets a person with the flag read their own org's", () => {
    expect(maySeeBooks(LZ_MANAGER, 1)).toBe(true);
  });

  it("keeps a person whose flag was turned off out of it", () => {
    expect(maySeeBooks(THOMAS, 1)).toBe(false);
  });

  it("never lets one client read another's", () => {
    expect(maySeeBooks(LZ_MANAGER, 2)).toBe(false);
    expect(maySeeBooks({ ...LZ_MANAGER, orgId: 2 }, 1)).toBe(false);
  });

  it("keeps a client with no organization out of everything", () => {
    expect(maySeeBooks(viewer({ canSeeMoney: true, orgId: null }), 1)).toBe(false);
  });
});

describe("the two rooms that are not the books", () => {
  it("is exactly purchasing and reimbursements", () => {
    expect([...WORKING_ROOMS]).toEqual(["purchasing", "reimbursements"]);
  });

  it("counts every other room in the section as the books", () => {
    const books = FINANCE_KEYS.filter((k) => !isWorkingRoom(k));
    // Named one by one rather than by subtraction, so a room ADDED to the
    // section has to be classified here on purpose. A new key that silently
    // lands on the open side of the wall is how this leaks back.
    expect(books).toEqual([
      "overview", "quotes", "invoices", "collections", "contracts",
      "overhead", "payroll", "costing",
    ]);
  });
});
