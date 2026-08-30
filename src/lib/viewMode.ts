// Which shape of the app a person gets, on a company that has two.
//
// A reseller's units are stock moving toward a sale; a lab's instruments are
// benches that have to stay up. The app already has both shapes - a pipeline
// landing against an attention wall, "All units" against "All instruments",
// Listings against a parts store - and it chose between them by asking the
// ORGANIZATION: orgs.resale_enabled, one flag, everybody inside gets the same
// answer.
//
// Which is wrong for the person the company put in charge of the equipment. A
// COO at a reselling company opens a pipeline of stock when what they came for
// is whether the instruments are running. They are not in the wrong app; they
// are in the wrong half of it, and there was no way to say so.
//
// So the org's flag becomes the DEFAULT rather than the answer, and a person
// can say which half they work on. Nothing about permissions moves: every view
// shows the same systems to the same people with the same rights. This is which
// question the page leads with, and that is a preference, not a privilege.
//
// A third shape, "board", joined the two halves: the operator's own working
// table - the dashboard the shop opens every morning - offered to a client's
// people over the card landing. Same rows, same tenancy scope, denser answer.
// It is never a default: a company is a lab or a reseller, but the board is a
// way of reading either, so it exists only as a per-person choice (their own,
// or a starting view their operator set).
//
// Pure. The column is users.view_mode and the switch is components/ViewSwitch.

export const VIEW_MODES = ["lab", "board", "reseller"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/**
 * What somebody has chosen, or "" for "whatever my company is".
 *
 * Blank is a real answer and the common one: most people never touch this, and
 * a company that starts or stops reselling should carry them along rather than
 * strand them in a shape they picked once by accident.
 */
export type ViewPref = ViewMode | "";

export const isViewPref = (v: string): v is ViewPref =>
  v === "" || (VIEW_MODES as readonly string[]).includes(v);

/**
 * WHICH VIEWS THIS COMPANY HAS AT ALL.
 *
 * The equipment view is universal - every company that owns instruments has
 * instruments to keep running. So is the board: it is the same systems the
 * card landing shows, on the operator's working table instead, and tenancy
 * already decides which rows are on it. The pipeline only exists for a
 * company that sells things, and a standard client must never land on one:
 * an empty pipeline is not a harmless extra screen, it is the app telling a
 * lab it is something it is not.
 */
export function availableViews(orgResells: boolean): ViewMode[] {
  return orgResells ? ["lab", "board", "reseller"] : ["lab", "board"];
}

export const viewAllowed = (mode: string, orgResells: boolean): boolean =>
  (availableViews(orgResells) as readonly string[]).includes(mode);

/**
 * The shape this person actually gets, from three answers in order of who is
 * closest to the question.
 *
 * `own` is what they chose for themselves and wins outright. `assigned` is
 * where the operator started them - the right view for a COO in charge of
 * equipment at a reselling company, set before he ever signs in - and it holds
 * until he says otherwise. The org's flag is the fallback under both.
 *
 * AND THE ANSWER IS CLAMPED, at read time, every time. A start view set while
 * a company resold, or a choice made before they stopped, must not survive as
 * a pipeline on a lab's screen - and the check belonging here rather than only
 * at the two write paths is what makes that true without either of them having
 * to be revisited when the org flag changes underneath them.
 */
export function viewModeFor(
  own: string, assigned: string, orgResells: boolean,
): ViewMode {
  const wanted = isViewPref(own) && own !== "" ? own
    : isViewPref(assigned) && assigned !== "" ? assigned
      : orgResells ? "reseller" : "lab";
  return viewAllowed(wanted, orgResells) ? wanted : "lab";
}

export const resellerView = (
  own: string, assigned: string, orgResells: boolean,
): boolean => viewModeFor(own, assigned, orgResells) === "reseller";

export const boardView = (
  own: string, assigned: string, orgResells: boolean,
): boolean => viewModeFor(own, assigned, orgResells) === "board";

/**
 * What the switch calls each one, in the words of somebody choosing.
 *
 * Named for the WORK rather than for the data model: "Equipment" and "Sales"
 * are what the two halves of a reselling company do, whereas "lab mode" and
 * "reseller mode" are what the app calls its own branches. Michael is a COO,
 * not an administrator of his own view settings.
 */
export const VIEW_LABEL: Record<ViewMode, string> = {
  lab: "Equipment",
  board: "The board",
  reseller: "Sales pipeline",
};

export const VIEW_BLURB: Record<ViewMode, string> = {
  lab: "What is running, what is down, what is due",
  board: "Every system on one table - stages, parts, tasks and whose move it is",
  reseller: "What is moving toward a sale, and what has stalled",
};

/**
 * Is there a second shape worth offering this person at all?
 *
 * Since the board became universal every organization has at least two, so
 * today this is always true - but the rule stays "more than one available
 * view" rather than a literal, because the menu must keep tracking
 * availableViews if either ever changes shape again.
 */
export const mayChooseView = (orgResells: boolean): boolean =>
  availableViews(orgResells).length > 1;
