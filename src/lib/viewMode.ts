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
// can say which half they work on. Nothing about permissions moves: both views
// show the same systems to the same people with the same rights. This is which
// question the page leads with, and that is a preference, not a privilege.
//
// Pure. The column is users.view_mode and the switch is components/ViewSwitch.

export const VIEW_MODES = ["lab", "reseller"] as const;
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
 * The shape this person actually gets.
 *
 * One function, because four places used to derive it from the org flag on
 * their own - the nav, the landing, the roster and the landing's to-do list -
 * and a person who switched would otherwise get a pipeline nav over a lab
 * page.
 */
export function viewModeFor(pref: string, orgResells: boolean): ViewMode {
  if (isViewPref(pref) && pref !== "") return pref;
  return orgResells ? "reseller" : "lab";
}

export const resellerView = (pref: string, orgResells: boolean): boolean =>
  viewModeFor(pref, orgResells) === "reseller";

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
  reseller: "Sales pipeline",
};

export const VIEW_BLURB: Record<ViewMode, string> = {
  lab: "What is running, what is down, what is due",
  reseller: "What is moving toward a sale, and what has stalled",
};

/**
 * Is there a second shape worth offering this person at all?
 *
 * Only where the company does both. A lab that has never sold anything has no
 * pipeline to switch to, and an empty one offered in a menu is a feature that
 * teaches somebody the app is not for them. The moment their org turns resale
 * on, everybody there gets the choice.
 */
export const mayChooseView = (orgResells: boolean): boolean => orgResells;
