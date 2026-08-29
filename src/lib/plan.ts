// What a workspace is entitled to, and where it stops.
//
// THE PROBLEM THIS SOLVES. Opening a workspace used to require the platform
// owner: createOperator starts with requirePlatformOwner, so a workspace
// existed because somebody at Ridgeline made one, and they made one after the
// company paid. That human bottleneck WAS the price - there is no plan column,
// no subscription and no seat cap anywhere, because none was needed while only
// one door existed.
//
// Accepting a hand-off invitation is a second door into the same room, and it
// cannot have the same lock on it: the shops worth converting are the ones with
// no account, and the moment they are persuadable is the moment somebody is
// handing them paying work. A card form there would close the door it exists to
// open.
//
// So the workspace is REAL and the client list is BOUNDED. They keep the client
// they were handed, work it completely - schedules, orders, parts, invoices, a
// portal for that client - forever, at no charge. The second client of their
// own is where a subscription begins.
//
// Bounded on clients rather than on a clock, deliberately. A service company's
// rhythm is quarterly: thirty days can contain no maintenance visit at all, so
// a trial clock expires on people who never saw the product do the thing it is
// for, and converts on anxiety rather than on evidence. A second client is
// evidence. It means the first one worked.
//
// Pure and dependency-free, like lib/tenants: the rules are a table so they can
// be tested as one rather than discovered when somebody's shop hits a wall.

/**
 * Blank is FULL, and it is what every workspace that predates this column has.
 * A workspace is never downgraded into a limit; it can only be created with
 * one. Getting that backwards would bill somebody who already paid.
 */
export const PLANS = ["", "free"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LABEL: Record<Plan, string> = {
  "": "Full",
  free: "Free - one client",
};

/** Unknown strings read as FULL, for the reason above: never downgrade. */
export const cleanPlan = (raw: string | null | undefined): Plan =>
  (raw ?? "").trim() === "free" ? "free" : "";

export const isFree = (raw: string | null | undefined): boolean => cleanPlan(raw) === "free";

/**
 * How many client organizations a free workspace may hold.
 *
 * One: the one it was handed. Not two - the whole design is that the boundary
 * is reached by SUCCESS, and "I have a second client to put in here" is the
 * moment the product has demonstrably worked.
 */
export const FREE_CLIENTS = 1;

/** May this workspace take on another client organization? */
export function mayAddClient(plan: string | null | undefined, clientsNow: number): boolean {
  return !isFree(plan) || clientsNow < FREE_CLIENTS;
}

/**
 * The wall, worded for the person hitting it.
 *
 * Deliberately not an upsell. Somebody who reaches this has been working real
 * jobs in here and is trying to put more work in; the honest thing is to say
 * what is happening in a sentence and say who to talk to, not to show them a
 * pricing table with a rocket on it. No figures either: a price belongs in a
 * conversation and in an invoice, not compiled into a client bundle where
 * changing it is a deploy.
 */
export function addClientProblem(
  plan: string | null | undefined, clientsNow: number, contact: string,
): string | null {
  if (mayAddClient(plan, clientsNow)) return null;
  const who = contact.trim() ? ` Ask ${contact.trim()}.` : "";
  return "This workspace came free with the client you were handed, and it covers that one."
    + ` A second client needs a subscription.${who}`;
}

/**
 * May this workspace hand a client to a shop that is NOT on Ridgeline yet?
 *
 * No, on the free tier, and this is the faucet rather than a feature fence.
 * Accepting an invitation mints a workspace. A workspace that could mint
 * another could mint them without end: hand your only client on, and now there
 * are two free workspaces where there was one, then four. Nothing about that
 * chain requires bad faith - one person with a second email address walks it by
 * accident - and every step of it costs the platform a tenant and earns
 * nothing.
 *
 * Sharing with a company already ON the instance stays open, because it creates
 * no workspace: it moves a client between two that already exist, and one of
 * them is paying.
 */
export const mayInviteOffPlatform = (plan: string | null | undefined): boolean => !isFree(plan);

export function invitePlanProblem(plan: string | null | undefined, contact: string): string | null {
  if (mayInviteOffPlatform(plan)) return null;
  const who = contact.trim() ? ` Ask ${contact.trim()}.` : "";
  return "Inviting a shop that is not on Ridgeline opens a workspace for them, which is part of"
    + ` a subscription.${who} You can still hand this client to a company already here.`;
}

/**
 * How many invitations one workspace may have out at once.
 *
 * Not a revenue limit - a paying operator sending these is the behaviour the
 * whole feature wants - but an invitation is an email this platform sends to a
 * stranger on somebody else's say-so, and a surface that will send an unbounded
 * number of those is a spam cannon with our return address on it. High enough
 * that a shop working a real list never sees it.
 */
export const OPEN_INVITES = 25;

export function inviteCountProblem(openNow: number): string | null {
  return openNow >= OPEN_INVITES
    ? `You have ${openNow} invitations still open. Give those a chance to land, or withdraw`
      + " some, before sending more."
    : null;
}

/** What the hand-off page promises somebody about to accept. Read on that page. */
export const FREE_TIER_LINES = [
  "The client you are being handed, and everything on them - systems, maintenance, parts, documents.",
  "Work orders, quotes, invoices and a portal for that client, with no limit and no clock.",
  "Taking on a client of your own is where a subscription starts.",
];
