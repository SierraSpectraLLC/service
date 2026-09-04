// The navigation, as one tree, built once.
//
// It used to be defined in three places - inline arrays in app/layout.tsx, the
// financial section's own list in lib/finance, and the settings sidebar's
// table in lib/settingsNav - and read by four surfaces: the desktop header,
// the phone drawer, the phone tab bar, and each section's rail. Nothing forced
// any of them to agree, and they didn't: one destination went by three names
// ("Dashboard" in the header, "Today" on the tab bar), and the drawer unrolled
// every group the header folded, so a staff phone opened onto 29 flat rows.
//
// So: one builder, one context, one tree. Every surface renders a projection
// of the same value, which is why they cannot drift. financeNavItems stays the
// source for the money section's rooms - this calls it rather than restating
// it, for exactly the reason that function's own comment gives.
//
// Pure on purpose. The facts it branches on are gathered in lib/navData, so
// the branching itself is testable without a database - see tests/nav.test.ts,
// which pins one tree per persona.
import { financeNavItems } from "@/lib/finance";

/** One destination. `badge` is a count; `tone` says the count is a problem. */
export type NavLeaf = { href: string; label: string; badge?: number; tone?: "warn" | "bad" };

/**
 * A section is a PLACE, not a menu.
 *
 * "Financial" used to be a label over ten links with no page of its own, so
 * there was nothing to tap that meant "take me to the money side of the app".
 * Every section now has an `href` that leads somewhere real, and `homeLabel`
 * is what that somewhere is called - written out rather than assembled from
 * the section's own label, because "Financial home" reads and "Your equipment
 * home" does not.
 */
export type SectionKey = "money" | "ops" | "library" | "roster" | "account";
export type NavSection = {
  key: SectionKey;
  label: string;
  /** The hub. Always a real page; see homeLabel for what it is called. */
  href: string;
  homeLabel: string;
  /** The rooms, NOT including the hub - every surface renders that itself. */
  items: NavLeaf[];
};

/**
 * The tab bar's five, by icon key. The icons themselves live in MobileNav;
 * this names which one, so the tree stays data.
 */
export type TabKey = "home" | "work" | "assets" | "inbox" | "library" | "approvals" | "parts";
export type TabItem = { href: string; label: string; icon: TabKey };

export type NavTree = {
  /** Where the work is. Four rows at most, and they match the tab bar's words. */
  primary: NavLeaf[];
  tabs: TabItem[];
  sections: NavSection[];
};

/**
 * Everything the shape of somebody's navigation depends on.
 *
 * Assembled by lib/navData from the reader's row, their organization and the
 * instance's modules. Nothing here is a preference about how the nav LOOKS -
 * those are decisions this file makes - they are all facts about who is
 * holding the phone.
 */
export type NavContext = {
  /** Signed in at all. A signed-out request gets an empty tree. */
  signedIn: boolean;
  isStaff: boolean;
  /** The workspace's owner, rather than one of its engineers. */
  isOwner: boolean;
  /** A client who works the reselling half of their company. See lib/viewMode. */
  resells: boolean;
  /** Their organization is a client rather than another provider. */
  isClientOrg: boolean;
  /** Whether they have an organization at all (platform staff have none). */
  hasOrg: boolean;
  modules: { eod: boolean; remote: boolean; sheetSync: boolean };
  /** They have a stockroom of their own, or one shared with them. */
  hasStock: boolean;
  /** Their own organization's remote support tier is on. */
  orgRemoteOn: boolean;
  /** The shop's position - see lib/books. */
  seesBooks: boolean;
  /** The payroll register - see lib/hr. Not implied by the books. */
  seesPayroll: boolean;
  /** The quotes and invoices their own organization was sent. */
  seesOwnMoney: boolean;
  /** The HR room - the owner, and whoever they have made HR. */
  adminsPeople: boolean;
  /** Unresolved sheet diffs, for the parity badge. */
  openDiffs: number;
  /** Where organization settings live for this reader, or null if nowhere. */
  settingsHref: string | null;
};

/** The empty tree, for a signed-out request. */
const NOTHING: NavTree = { primary: [], tabs: [], sections: [] };

/**
 * WHETHER THIS READER GETS A FINANCIAL MENU AT ALL - the books, or the payroll
 * register on its own. It decides Operations as well as Financial: the two
 * working rooms (Purchasing, Reimbursements) appear in exactly one of the two
 * menus, and this is which.
 */
const hasFinanceMenu = (ctx: NavContext) => ctx.seesBooks || ctx.seesPayroll;

/**
 * The one word each destination goes by.
 *
 * Not a convenience - it is the fix. A label written at the point of use is a
 * label that can be written differently at the next point of use, which is how
 * /documents came to be "Library" on the tab bar, "Documents" in a client's
 * header and "Files" inside the Library menu. If a destination is renamed it
 * is renamed here, once, and every surface follows.
 */
export const LABEL = {
  today: "Today",
  work: "Work orders",
  assets: "Assets",
  stock: "Inventory",
  inbox: "Inbox",
  documents: "Documents",
  library: "Library",
  calendar: "Calendar",
  money: "Financial",
  ops: "Operations",
  account: "Account",
} as const;

export function buildNav(ctx: NavContext): NavTree {
  if (!ctx.signedIn) return NOTHING;
  return {
    primary: primaryOf(ctx),
    tabs: tabsOf(ctx),
    sections: [...workSections(ctx), accountSection(ctx)],
  };
}

/*
 * Two products, not one product with things hidden.
 *
 * Staff get the shop: a board, the work, the equipment, the inventory. A
 * client gets doors onto their own relationship, in their own words - they do
 * not file a work order, they ask for help, and the work order is what the
 * shop creates in response. See lib/clientView for the rest of that
 * vocabulary. Anything a particular account happens to have (its own
 * stockroom, remote support, its own payroll) is a capability rather than a
 * door, and lives in a section below.
 */
function primaryOf(ctx: NavContext): NavLeaf[] {
  if (ctx.isStaff) {
    return [
      { href: "/", label: LABEL.today },
      { href: "/work", label: LABEL.work },
      { href: "/assets", label: LABEL.assets },
      ...(ctx.hasStock ? [{ href: "/stock", label: LABEL.stock }] : []),
      /* Money is staff work and it is a SECTION rather than a primary row -
         a client sees their own bills through their own portal, never through
         a nav word that lists everybody's.
         The owner view is not here either. It is the same person's other
         question about the same shop - what is the business doing, rather than
         what is the shop doing today - so the two pages carry the door to each
         other in their own headers and this row stays the places work actually
         happens. A permanent nav word for a page most of the staff cannot open
         is a word everybody reads and almost nobody uses. */
    ];
  }
  return [
    { href: "/", label: ctx.resells ? "Your pipeline" : "Your lab" },
    { href: "/work", label: "Requests" },
    /* When somebody is coming, what is coming due on their machines, and
       anything they have told us about their own year. The same room the shop
       reads, scoped to them - one destination and one word, which is the rule
       this file is built on; app/calendar branches the reading.
       A PRIMARY row rather than a room in the equipment section, where it
       first landed: a calendar is not a thing they own, and "when is somebody
       coming" is close to the top of why a lab opens this portal at all. It
       sits beside Requests because it is the same subject - what we have asked
       for, and when it is happening. */
    { href: "/calendar", label: LABEL.calendar },
    /* Quotes and invoices, named for what the client does with them rather
       than for what the shop filed. */
    ...(ctx.isClientOrg && ctx.seesOwnMoney ? [{ href: "/orders", label: "Approvals" }] : []),
    /* What this is costing and whether they are covered - the question the
       person who signs the cheque asks, which is not the one "Your lab"
       answers. Offered only to a client org: a reseller's page is a pipeline
       and this would be a second, emptier version of it. */
    ...(ctx.isClientOrg && !ctx.resells ? [{ href: "/owner", label: "Your account" }] : []),
    ...(ctx.resells
      ? [{ href: "/listings", label: "Listings" }]
      : ctx.isClientOrg ? [{ href: "/store", label: "Parts" }] : []),
    { href: "/documents", label: LABEL.documents },
  ];
}

/**
 * The phone's five.
 *
 * Same destinations as the primary row and, now, the same words: the bar used
 * to say Today / Work / Assets / Inbox / Library beside a drawer that said
 * Dashboard / Work orders / Assets / ... / Files, two surfaces disagreeing
 * about the vocabulary of one app. The fifth tab is the Library HUB rather
 * than /documents, so the word on the tab and the page it opens are the same
 * thing.
 */
function tabsOf(ctx: NavContext): TabItem[] {
  if (ctx.isStaff) {
    return [
      { href: "/", label: LABEL.today, icon: "home" },
      { href: "/work", label: LABEL.work, icon: "work" },
      { href: "/assets", label: LABEL.assets, icon: "assets" },
      { href: "/inbox", label: LABEL.inbox, icon: "inbox" },
      { href: "/library", label: LABEL.library, icon: "library" },
    ];
  }
  /* A client's tab bar IS their primary row - and it agrees with the header
     word for word, because both come from primaryOf.
     A lab has seven doors and a bar holds five, so two give way, in a stated
     order rather than by whatever slice(0, 5) happens to cut off. Each one
     dropped stays a single tap away in the header and the drawer:
       /owner, the coverage-and-spend page, which a person opens deliberately
         when they are asking what this is costing rather than reaching for
         with a thumb;
       then the parts store - /store for a lab, /listings for a reseller -
         which is a place you go to shop, not a place you check.
     Documents is not droppable and neither is the calendar: one is the second
     most used thing a client comes here for, and the other answers "when is
     somebody coming", which is the first. Slicing blind used to drop
     Documents the moment a seventh door appeared. */
  const primary = primaryOf(ctx);
  const icon = (href: string): TabKey =>
    href === "/" ? "home" : href === "/work" ? "work"
      : href === "/orders" ? "approvals"
        : href === "/store" || href === "/listings" ? "parts"
          : href === "/calendar" ? "work"
            : href === "/owner" ? "assets" : "library";
  const GIVES_WAY = ["/owner", "/store", "/listings"];
  let forBar = primary;
  for (const href of GIVES_WAY) {
    if (forBar.length <= 5) break;
    forBar = forBar.filter((l) => l.href !== href);
  }
  return forBar.slice(0, 5).map((l) => ({ href: l.href, label: l.label, icon: icon(l.href) }));
}

/** The sections that are about the work, in the order they are worked. */
function workSections(ctx: NavContext): NavSection[] {
  return ctx.isStaff ? staffSections(ctx) : clientSections(ctx);
}

function staffSections(ctx: NavContext): NavSection[] {
  const fin = hasFinanceMenu(ctx);
  const out: NavSection[] = [];
  /* Financial is a section, not a page - ten rooms behind one word, which
     meant every one of them was two clicks away behind a link that looked like
     a destination. The rooms come from lib/finance so this and the rail inside
     the section cannot drift apart; Payroll leaves the list entirely for a
     reader who may not read one. Overview is dropped here because it IS the
     hub - /money is the section's href, and every surface draws that row
     itself as "Financial home". */
  if (fin) {
    out.push({
      key: "money", label: LABEL.money, href: "/money", homeLabel: "Financial home",
      items: financeNavItems({ seesBooks: ctx.seesBooks, seesPayroll: ctx.seesPayroll })
        .filter((i) => i.href !== "/money"),
    });
  }
  out.push({
    key: "ops", label: LABEL.ops, href: "/ops", homeLabel: "Operations home",
    items: [
      ...(ctx.modules.eod ? [{ href: "/eod", label: "EOD update" }] : []),
      /* What is happening WHEN, across everything - the field crew's morning
         question, so it leads the group. */
      { href: "/calendar", label: LABEL.calendar },
      { href: "/maintenance", label: "Maintenance" },
      /* The reseller pipeline: systems moving Receive → Commission. Something
         the shop DOES, so it sits with the other doing. */
      { href: "/restorations", label: "Restoration queue" },
      /* Who the shop works FOR, next to who it works WITH - the two "which
         company" rooms, in that order, because ours come before theirs.
         Every staff member, not the owner: an engineer can spend a week on a
         client's system, and the only room that said who that client was and
         what else of theirs we look after was owner-only Settings. Adding one
         is staff too, and always was - addOrg is requireStaff, and the only
         thing gating it in practice was which page the form sat on.
         NOT the Settings room under a second name. That one is configuration -
         sign-ins, sharing, report recipients - and stays the owner's; this is
         the roster. Two questions, so two rooms, cross-linked. */
      { href: "/clients", label: "Clients" },
      /* The owner, not every staff member: the room is the companies the
         owner deals with - the ones they added, offered clients and leads
         to, or invited - and who the owner deals with is not the engineers'
         to read. The page refuses them too; this keeps the door off the
         wall. */
      ...(ctx.isOwner ? [{ href: "/network", label: "Service companies" }] : []),
      ...(ctx.adminsPeople ? [{ href: "/people", label: "People" }] : []),
      /* Purchasing and Reimbursements, for the readers who have no Financial
         menu to find them in.
         They are things an engineer DOES rather than facts about how the
         business is doing, and both were doors of their own before the
         financial section existed - so an engineer must be able to raise a
         purchase order and claim back a hotel without the books. That used to
         mean listing them in BOTH menus, on the reasoning that the Financial
         menu was owner-only and so the two readerships never overlapped. They
         do now: HR gets that menu for the payroll register, and would have
         seen the same two rooms twice.
         So: one door each, and which menu it is in depends on which menus this
         reader has. lib/finance.WORKING_ROOMS keeps them in the Financial menu
         for everybody who has one. */
      ...(fin ? [] : [
        { href: "/money/purchasing", label: "Purchasing" },
        /* "Reimbursements", not "Expenses": Overhead is also expenses, and two
           things by one name in one section is the confusion the financial
           merge exists to remove. */
        { href: "/money/reimbursements", label: "Reimbursements" },
      ]),
      /* Payroll lives in the Financial menu. It is not something an engineer
         DOES - unlike the two rooms above it, which stay here precisely
         because they are - and its gate is the register gate, so anybody who
         could see it here already has the menu that holds it. */
      /* Something you DO to a system, so it sits with the other doing - it was
         under Library, which is files and tools, and a remote session is
         neither. */
      ...(ctx.modules.remote ? [{ href: "/remote", label: "Remote support" }] : []),
      { href: "/metrics", label: "Metrics" },
      /* The count is DATA now, not a suffix on the label. It used to read
         "Sheet parity (3)", which put a number inside the one string every
         surface prints - so the drawer, which is not allowed to carry counts,
         had no way to drop it. See the badge policy: counts live on the tab
         bar and on hub cards; the drawer shows at most a tone dot. */
      ...(ctx.modules.sheetSync
        ? [{ href: "/parity", label: "Sheet parity", badge: ctx.openDiffs, tone: "warn" as const }]
        : []),
      { href: "/archive", label: "Archived" },
    ],
  });
  out.push({
    key: "library", label: LABEL.library, href: "/library", homeLabel: "Library home",
    items: [
      /* The equipment catalog is reference material the shop reaches for
         daily; burying it three taps into Settings made it feel like
         configuration. It still lives at its Settings URL - this is the short
         way in. */
      { href: "/settings/catalog", label: "Equipment catalog" },
      { href: "/settings/parts", label: "Parts catalog" },
      { href: "/documents", label: LABEL.documents },
      { href: "/gallery", label: "Gallery" },
      { href: "/pdf", label: "PDF studio" },
      { href: "/import", label: "Import spreadsheet" },
    ],
  });
  return out;
}

/**
 * A client's one work section: what they HAVE.
 *
 * The landing answers "what needs me" - a lab's groups by exception, a
 * reseller's counts by position in a process. Neither answers "what do I
 * have", and for a reseller nothing did: the pipeline columns named six units
 * in Refurbishment with no way to reach the six. So the roster is the hub, and
 * the capabilities this particular account happens to have hang off it.
 *
 * It is not called "Your account". That is already the name of a primary door
 * (/owner, where the coverage and the spend are), and two sections of a
 * four-row drawer sharing one word is the drift this file exists to stop.
 */
function clientSections(ctx: NavContext): NavSection[] {
  if (!ctx.hasOrg) return [];
  return [{
    key: "roster",
    label: "Your equipment",
    href: "/units",
    homeLabel: ctx.resells ? "All units" : "All instruments",
    items: [
      // A reseller's primary row spends its slots on the pipeline and the
      // listings, so the parts store lives here rather than disappearing -
      // they buy parts to refurbish with, and a door they use should not
      // vanish.
      ...(ctx.resells && ctx.isClientOrg ? [{ href: "/store", label: "Parts" }] : []),
      // Their own shelf, when they keep one - not the shop's inventory.
      ...(ctx.hasStock ? [{ href: "/stock", label: "Your inventory" }] : []),
      ...(ctx.orgRemoteOn ? [{ href: "/remote", label: "Remote support" }] : []),
      /* Payroll is NOT here any more. A client manager with the flag reached
         /money/payroll from this group, which put an operator's route in a
         client's nav and read as the shop's register rather than their own
         company's. Their own pay is a personal matter and lives in the account
         section, which has a room for it - see accountSection. */
    ],
  }];
}

/**
 * The person's own settings, which the app did not have.
 *
 * /settings/* is entirely organizational - catalog, tenants, billing,
 * procedures, trail - so "Settings" in the account menu pointed at the
 * company's pages, and "Notifications" pointed at the inbox, which is mail
 * rather than preferences. This is the fourth section, present for every
 * signed-in role, and organization settings become a room inside it for
 * whoever is gated into them.
 */
function accountSection(ctx: NavContext): NavSection {
  return {
    key: "account", label: LABEL.account, href: "/account", homeLabel: "Account home",
    items: [
      { href: "/account/profile", label: "Profile" },
      { href: "/account/security", label: "Sign-in & security" },
      { href: "/account/notifications", label: "Notifications" },
      /* Their own paystubs and what the company holds about their pay -
         distinct from /money/payroll, which is the register and stays behind
         the register gate. Staff always have one because everybody who works
         here is paid; a client only when their own company turned the flag on
         for them. */
      ...(ctx.isStaff || ctx.seesPayroll ? [{ href: "/account/pay", label: "My pay" }] : []),
      ...(ctx.settingsHref ? [{ href: ctx.settingsHref, label: "Organization settings" }] : []),
    ],
  };
}

/**
 * Every destination in the tree, flat - the command palette's index, for free.
 *
 * /search was a database search with no way to reach a PAGE: typing "parity"
 * found any record mentioning the word and never the room. One tree means one
 * index, and a room added to the nav is searchable the same day.
 */
export type NavPlace = { href: string; label: string; section: string };

export function navIndex(tree: NavTree): NavPlace[] {
  const out: NavPlace[] = tree.primary.map((l) => ({ href: l.href, label: l.label, section: "" }));
  for (const s of tree.sections) {
    out.push({ href: s.href, label: s.homeLabel, section: s.label });
    for (const i of s.items) out.push({ href: i.href, label: i.label, section: s.label });
  }
  // One row per destination: a href reachable two ways (an engineer's
  // Purchasing, say) is one place, and the first naming of it wins.
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.href) ? false : (seen.add(p.href), true)));
}

/**
 * Whether a section has anything worth an eye in it - the drawer's dot.
 *
 * TONE, NOT A NUMBER. Counts live on the tab bar and on hub cards, where
 * there is room to say what they count; a drawer row has room for one bit,
 * and one bit honestly rendered is a dot.
 */
export function sectionTone(section: NavSection): "warn" | "bad" | null {
  let worst: "warn" | "bad" | null = null;
  for (const i of section.items) {
    if (!i.badge || !i.tone) continue;
    if (i.tone === "bad") return "bad";
    worst = "warn";
  }
  return worst;
}

/** Whether a path is inside a destination, for the active state. */
export function isActive(path: string, href: string): boolean {
  const base = href.split("?")[0];
  if (base === "/") return path === "/";
  return path === base || path.startsWith(`${base}/`);
}
