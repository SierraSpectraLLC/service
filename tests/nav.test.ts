import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNav, navIndex, sectionTone, isActive, type NavContext, type NavTree } from "@/lib/nav";

/**
 * The nav, pinned per persona.
 *
 * buildNav is the single point where every view of the app is defined, so the
 * acceptance test for it is coverage per person rather than per branch: five
 * readers, five trees, and a diff on any of them is a product decision
 * somebody has to look at rather than a refactor that slipped.
 *
 * The rules underneath the trees are the ones the architecture brief made
 * load-bearing, and they are asserted for every persona at once: one label per
 * destination, a drawer that fits a phone at rest, and no counts baked into a
 * label.
 */
const BASE: NavContext = {
  signedIn: true, isStaff: false, resells: false, isClientOrg: false, hasOrg: false,
  modules: { eod: false, remote: false, sheetSync: false },
  hasStock: false, orgRemoteOn: false, seesBooks: false, seesPayroll: false,
  seesOwnMoney: true, adminsPeople: false, openDiffs: 0, settingsHref: null,
};

const OWNER: NavContext = {
  ...BASE, isStaff: true, hasStock: true, seesBooks: true, seesPayroll: true,
  adminsPeople: true, openDiffs: 3, settingsHref: "/settings",
  modules: { eod: true, remote: true, sheetSync: true },
};

/* An ordinary engineer: neither the books nor the register, so no Financial
   menu at all - which is precisely why Purchasing and Reimbursements have to
   appear under Operations for them and nowhere else. */
const ENGINEER: NavContext = {
  ...BASE, isStaff: true, hasStock: true,
  /* Null, and that is the point: an engineer administers no organization.
     Pointing them at /settings/catalog, as the old rule did, named the
     equipment catalog "Settings" in one breath and "Equipment catalog" in the
     next - one page, two words, in one person's nav. */
  settingsHref: null,
  modules: { eod: true, remote: true, sheetSync: false },
};

/* HR: the register without the books. The case that broke the old split, when
   somebody first had a Financial menu without being able to read a balance. */
const HR: NavContext = { ...ENGINEER, seesPayroll: true };

const CLIENT_LAB: NavContext = {
  ...BASE, isClientOrg: true, hasOrg: true, hasStock: true, orgRemoteOn: true,
  modules: { eod: false, remote: true, sheetSync: false },
  settingsHref: "/settings/organizations/12",
};

const CLIENT_RESELLER: NavContext = { ...CLIENT_LAB, resells: true, hasStock: false, orgRemoteOn: false };

const PERSONAS: [string, NavContext][] = [
  ["staff owner", OWNER], ["staff engineer", ENGINEER], ["HR with payroll", HR],
  ["client lab", CLIENT_LAB], ["client reseller", CLIENT_RESELLER],
];

/** The tree as one printable shape, so a snapshot reads as a nav rather than JSON. */
const sketch = (t: NavTree) => ({
  primary: t.primary.map((l) => `${l.label} → ${l.href}`),
  tabs: t.tabs.map((l) => `${l.label} → ${l.href}`),
  sections: t.sections.map((s) => ({
    [`${s.label} → ${s.href}`]: [
      `${s.homeLabel} (home)`,
      ...s.items.map((i) => `${i.label}${i.badge ? ` [${i.badge}]` : ""} → ${i.href}`),
    ],
  })),
});

describe("buildNav, per persona", () => {
  for (const [who, ctx] of PERSONAS) {
    it(`builds one tree for a ${who}`, () => {
      expect(sketch(buildNav(ctx))).toMatchSnapshot();
    });
  }

  it("gives a signed-out request nothing at all", () => {
    expect(buildNav({ ...BASE, signedIn: false })).toEqual({ primary: [], tabs: [], sections: [] });
  });
});

describe("the rules every tree obeys", () => {
  /**
   * ONE WORD PER DESTINATION.
   *
   * The fix this whole module exists for: /documents was "Library" on the tab
   * bar, "Documents" in a client's header and "Files" inside the Library menu,
   * because each surface wrote its own label at its own point of use. A href
   * that appears twice under two words fails here.
   */
  for (const [who, ctx] of PERSONAS) {
    it(`calls each destination one thing for a ${who}`, () => {
      const t = buildNav(ctx);
      const words = new Map<string, Set<string>>();
      /* A hub's row inside its own fold is "Library home" where the tab that
         leads to it says "Library". That is the same NAME in its qualified
         form - the row means "the whole of this section" and has to be
         distinguishable from the rooms under it - not a second vocabulary for
         one destination, which is what this rule is about. Compared with the
         qualifier off, so "Library home" vs "Documents" would still fail. */
      const note = (href: string, label: string) => {
        const key = href.split("?")[0];
        words.set(key, (words.get(key) ?? new Set()).add(label.replace(/ home$/, "")));
      };
      for (const l of t.primary) note(l.href, l.label);
      for (const l of t.tabs) note(l.href, l.label);
      for (const s of t.sections) {
        note(s.href, s.homeLabel);
        for (const i of s.items) note(i.href, i.label);
      }
      const clashes = [...words].filter(([, set]) => set.size > 1)
        .map(([href, set]) => `${href}: ${[...set].join(" / ")}`);
      expect(clashes, `one destination, two words:\n${clashes.join("\n")}`).toEqual([]);
    });

    it(`fits a phone drawer at rest for a ${who}`, () => {
      const t = buildNav(ctx);
      /* At rest the drawer is the identity block, the primary rows, one row
         per folding section, the account row and sign out. The sections FOLD -
         that is the whole change - so nothing inside them counts here. Eleven
         is the measured limit at 667px with nothing scrolling. */
      const folding = t.sections.filter((s) => s.key !== "account");
      const account = t.sections.filter((s) => s.key === "account");
      const rows = 1 + t.primary.length + folding.length + account.length + 1;
      expect(rows, `${who} drawer rows: ${rows}`).toBeLessThanOrEqual(11);
    });

    it(`keeps counts out of the labels for a ${who}`, () => {
      /* "Sheet parity (3)" put a number inside the one string every surface
         prints, so the drawer - which carries at most a dot - had no way to
         drop it. Counts are data now. */
      const t = buildNav(ctx);
      const labels = [
        ...t.primary.map((l) => l.label), ...t.tabs.map((l) => l.label),
        ...t.sections.flatMap((s) => [s.label, s.homeLabel, ...s.items.map((i) => i.label)]),
      ];
      expect(labels.filter((l) => /\(\d+\)|\d/.test(l))).toEqual([]);
      // And no em dashes in UI copy - the house rule, enforced where the copy is.
      expect(labels.filter((l) => l.includes("—"))).toEqual([]);
    });

    it(`gives every section a hub for a ${who}`, () => {
      /* A section is a PLACE. "Financial" was a label over ten links with no
         page of its own, so there was nothing to tap meaning "the money side
         of the app" - which is the reachability rule's whole foundation:
         drawer → hub → room is two taps from anywhere. */
      for (const s of buildNav(ctx).sections) {
        expect(s.href, `${s.label} has no hub`).toMatch(/^\//);
        expect(s.homeLabel.length, `${s.label} hub has no name`).toBeGreaterThan(0);
        expect(s.items.map((i) => i.href), `${s.label} lists its own hub as a room`)
          .not.toContain(s.href);
      }
    });
  }

  it("gives every signed-in reader an account section", () => {
    for (const [who, ctx] of PERSONAS) {
      const account = buildNav(ctx).sections.find((s) => s.key === "account");
      expect(account, `${who} has no account section`).toBeTruthy();
      expect(account!.items.map((i) => i.href)).toContain("/account/profile");
    }
  });
});

describe("who gets which room", () => {
  it("keeps the two working rooms in exactly one menu", () => {
    /* Purchasing and Reimbursements are things an engineer DOES, so everybody
       reaches them - but never twice. Whoever has a Financial menu finds them
       there (lib/finance.WORKING_ROOMS); whoever has none finds them under
       Operations. HR is the case that broke the old rule: a Financial menu
       without the books. */
    for (const ctx of [OWNER, ENGINEER, HR, CLIENT_LAB]) {
      const t = buildNav(ctx);
      const hrefs = t.sections.flatMap((s) => s.items.map((i) => i.href.split("?")[0]));
      const purchasing = hrefs.filter((h) => h === "/money/purchasing");
      expect(purchasing.length).toBeLessThanOrEqual(1);
    }
    const eng = buildNav(ENGINEER).sections.find((s) => s.key === "ops")!;
    expect(eng.items.map((i) => i.href)).toContain("/money/purchasing");
    const owner = buildNav(OWNER);
    expect(owner.sections.find((s) => s.key === "ops")!.items.map((i) => i.href))
      .not.toContain("/money/purchasing");
    expect(owner.sections.find((s) => s.key === "money")!.items.map((i) => i.href))
      .toContain("/money/purchasing");
  });

  it("gives HR the register without the books", () => {
    const money = buildNav(HR).sections.find((s) => s.key === "money");
    expect(money, "HR has no Financial menu").toBeTruthy();
    const hrefs = money!.items.map((i) => i.href);
    expect(hrefs).toContain("/money/payroll");
    // The books stay shut: no invoices, no collections, no job costing.
    expect(hrefs).not.toContain("/money/invoices");
    expect(hrefs).not.toContain("/money/costing");
  });

  it("takes the register out of an engineer's menus entirely", () => {
    const t = buildNav(ENGINEER);
    expect(t.sections.find((s) => s.key === "money")).toBeUndefined();
    const hrefs = t.sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/money/payroll");
    // Their own pay is theirs, though - that is the point of /account/pay.
    expect(hrefs).toContain("/account/pay");
  });

  it("keeps a client out of the operator's payroll route", () => {
    /* A client manager with the flag used to reach /money/payroll from a group
       in their own portal. Their own pay is a personal matter and lives in the
       account section; the operator's register is not in their nav at all. */
    const t = buildNav({ ...CLIENT_LAB, seesPayroll: true });
    const hrefs = t.sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/money/payroll");
    expect(hrefs).toContain("/account/pay");
  });

  it("hides My pay from a client whose company never turned it on", () => {
    const account = buildNav(CLIENT_LAB).sections.find((s) => s.key === "account")!;
    expect(account.items.map((i) => i.href)).not.toContain("/account/pay");
  });

  it("drops a room whose module is off", () => {
    const off = buildNav({ ...OWNER, modules: { eod: false, remote: false, sheetSync: false } });
    const ops = off.sections.find((s) => s.key === "ops")!;
    const hrefs = ops.items.map((i) => i.href);
    expect(hrefs).not.toContain("/eod");
    expect(hrefs).not.toContain("/remote");
    expect(hrefs).not.toContain("/parity");
  });

  it("drops Inventory for somebody with no stockroom", () => {
    expect(buildNav({ ...OWNER, hasStock: false }).primary.map((l) => l.href))
      .not.toContain("/stock");
  });

  it("gives every staff member the client roster, under Operations", () => {
    /*
     * "Who is this client and what else of theirs do we look after" is a daily
     * question in a service company, and the only room that answered it was
     * owner-only Settings - so an engineer could spend a week on a client's
     * system without being able to look the company up.
     *
     * The engineer is the assertion that matters. The owner having it was
     * never in doubt.
     */
    for (const ctx of [OWNER, ENGINEER, HR]) {
      const ops = buildNav(ctx).sections.find((s) => s.key === "ops")!;
      expect(ops.items.map((i) => i.href)).toContain("/clients");
    }
  });

  it("keeps it out of a client's own nav", () => {
    // Staff, not "signed in": the roster is who the shop works for, which is
    // not a list any one of them is shown.
    for (const ctx of [CLIENT_LAB, CLIENT_RESELLER]) {
      const hrefs = buildNav(ctx).sections.flatMap((s) => s.items.map((i) => i.href));
      expect(hrefs).not.toContain("/clients");
    }
  });

  it("leaves the Settings room out of the nav rather than naming it twice", () => {
    /*
     * The roster and Settings > Clients & orgs are two questions - who they
     * are, and who may sign in - so they are two rooms. What must not happen
     * is BOTH in one menu: two words a reader has to tell apart, for what
     * reads like one subject. The Settings sidebar is where the other one
     * lives, and lib/settingsNav still carries it.
     */
    const hrefs = buildNav(OWNER).sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/settings/organizations");
    expect(readFileSync("src/lib/settingsNav.ts", "utf8")).toContain('"/settings/organizations"');
  });

  it("names an organization settings room only for whoever administers one", () => {
    const has = buildNav(OWNER).sections.find((s) => s.key === "account")!;
    expect(has.items.map((i) => i.label)).toContain("Organization settings");
    const hasnt = buildNav({ ...CLIENT_LAB, settingsHref: null })
      .sections.find((s) => s.key === "account")!;
    expect(hasnt.items.map((i) => i.label)).not.toContain("Organization settings");
  });
});

describe("the drawer's dot, and the palette's index", () => {
  it("reports a tone only where a room has a nonzero signal", () => {
    const ops = buildNav(OWNER).sections.find((s) => s.key === "ops")!;
    expect(sectionTone(ops)).toBe("warn");
    const quiet = buildNav({ ...OWNER, openDiffs: 0 }).sections.find((s) => s.key === "ops")!;
    expect(sectionTone(quiet)).toBeNull();
  });

  it("indexes every destination once", () => {
    const index = navIndex(buildNav(OWNER));
    const hrefs = index.map((p) => p.href);
    expect(new Set(hrefs).size, "a destination indexed twice").toBe(hrefs.length);
    expect(hrefs).toContain("/ops");
    expect(hrefs).toContain("/account/notifications");
  });

  it("matches a route to the section it is inside, and only that one", () => {
    expect(isActive("/", "/")).toBe(true);
    // The root is exact: without this every page in the app reads as "home".
    expect(isActive("/work/12", "/")).toBe(false);
    expect(isActive("/money/invoices", "/money")).toBe(true);
    expect(isActive("/moneybox", "/money")).toBe(false);
    // A room's own children count as the room.
    expect(isActive("/settings/catalog/9", "/settings/catalog")).toBe(true);
    // The window a finance link carries does not stop it matching.
    expect(isActive("/money/invoices", "/money/invoices?period=ytd")).toBe(true);
  });
});

describe("the surfaces read the tree, and nothing else", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("leaves no second nav definition in the shell", () => {
    /* The nav used to be defined in three places and read by four surfaces,
       with nothing forcing any two to agree. The layout builds nothing now. */
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/buildNav\(facts\)/);
    expect(layout).not.toMatch(/const navLinks/);
    expect(layout).not.toMatch(/const navGroups/);
    expect(layout).not.toMatch(/const navTabs/);
  });

  it("hands both phone surfaces the same tree", () => {
    const drawer = read("src/components/MobileNav.tsx");
    expect(drawer).toMatch(/nav: NavTree/);
    // The fold, and the exclusivity that keeps the drawer bounded.
    expect(drawer).toMatch(/expanded === s\.key/);
    expect(drawer).toMatch(/setExpanded\(isOpen \? null : s\.key\)/);
    // Account is a row, not an accordion.
    expect(drawer).toMatch(/s\.key !== "account"/);
  });

  it("leads every header menu with the section's own page", () => {
    expect(read("src/components/HeaderNav.tsx")).toMatch(/\{s\.homeLabel\}/);
  });
});
