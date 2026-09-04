import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NOTIFY_KINDS, mayReceiveKind, notifyKindsFor } from "@/lib/inbox";

/**
 * Which notification switches a person is offered.
 *
 * The preference list was shown whole to everybody. It is not a permission -
 * a preference only MUTES the email on a notification somebody was already
 * going to get, and nothing a client switched on ever subscribed them to
 * anything. But seven of seventeen rows could never fire for a client, which
 * buries the ones that can, and two of the seven told every client of every
 * tenant that their portal use is watched and reported on.
 *
 * Then the same thing one rung up. An engineer was offered "another service
 * company shares a client with us" and "a lead is offered to us" - and was
 * sent both - which told him, switch and mail alike, which companies the
 * owner deals with. Those are the owner's, and so are the two about who is
 * using the portal.
 */

/** The owner's alone: who they deal with, and who is using the portal. */
const OWNER_ONLY = [
  // Another service company offering us a client, and the answer when we
  // offer one. A decision about taking on work from a company the owner
  // deals with - and which companies those are is not the engineers' to read.
  "client_share",
  "lead",
  "sign_in", "usage_report",
  // Our own staff reporting a snag in the software: the owners triage it.
  "bug_report",
];

/** The shop's: every engineer, never a client. */
const HOUSE_ONLY = ["gas_empty", "issue", "pm_request", "renewal", "model_proposal"];

describe("who is offered which switch", () => {
  it("keeps the operator's own concerns off a client's list", () => {
    const client = notifyKindsFor("client_viewer").map((k) => k.kind);
    for (const kind of [...HOUSE_ONLY, ...OWNER_ONLY]) expect(client, kind).not.toContain(kind);
    expect(notifyKindsFor("client_editor")).toEqual(notifyKindsFor("client_viewer"));
  });

  it("keeps the owner's own concerns off an engineer's list", () => {
    const staff = notifyKindsFor("staff").map((k) => k.kind);
    for (const kind of OWNER_ONLY) expect(staff, kind).not.toContain(kind);
    // And loses nothing that is the shop's.
    for (const kind of HOUSE_ONLY) expect(staff, kind).toContain(kind);
    // The owner loses nothing at all.
    expect(notifyKindsFor("owner").map((k) => k.kind)).toEqual(NOTIFY_KINDS.map((k) => k.kind));
  });

  it("hides the two that disclose what the operator watches", () => {
    /* "Somebody signs in to the portal for the first time" and "the weekly
       report of who is using the portal" are the operator's business to
       disclose in their own words, not a checkbox's to leak on their behalf. */
    for (const role of ["client_viewer", "staff"]) {
      const labels = notifyKindsFor(role).map((k) => k.label).join(" | ");
      expect(labels, role).not.toMatch(/signs in to the portal/i);
      expect(labels, role).not.toMatch(/who is using the portal/i);
    }
  });

  it("hides from an engineer the two that name who the owner deals with", () => {
    const labels = notifyKindsFor("staff").map((k) => k.label).join(" | ");
    expect(labels).not.toMatch(/another service company/i);
    expect(labels).not.toMatch(/a lead is offered/i);
  });

  it("keeps every kind a client genuinely receives", () => {
    /* Removing a switch somebody needs is the same failure pointed the other
       way: their email carries on and the way to stop it is gone. */
    const client = notifyKindsFor("client_viewer").map((k) => k.kind);
    for (const kind of [
      "task_assigned", "discussion", "mention", "queue", "message", "drop",
      // The OWNING org rules on access to its own equipment and is the one
      // asked to order parts - both reach them, see actions.ownerAudience.
      "access_request", "parts_request",
      "handoff", "system_assigned",
    ]) expect(client, kind).toContain(kind);
  });

  it("classifies every kind, so a new one cannot slip in unlabelled", () => {
    for (const k of NOTIFY_KINDS) {
      expect(["owner", "house", "all"], k.kind).toContain(k.audience);
    }
    expect(NOTIFY_KINDS.filter((k) => k.audience === "house").map((k) => k.kind).sort())
      .toEqual([...HOUSE_ONLY].sort());
    expect(NOTIFY_KINDS.filter((k) => k.audience === "owner").map((k) => k.kind).sort())
      .toEqual([...OWNER_ONLY].sort());
  });

  it("answers the same question for one kind at a time", () => {
    expect(mayReceiveKind("usage_report", "owner")).toBe(true);
    expect(mayReceiveKind("usage_report", "staff")).toBe(false);
    expect(mayReceiveKind("usage_report", "client_viewer")).toBe(false);
    expect(mayReceiveKind("client_share", "staff")).toBe(false);
    expect(mayReceiveKind("gas_empty", "staff")).toBe(true);
    expect(mayReceiveKind("message", "client_viewer")).toBe(true);
    expect(mayReceiveKind("not_a_kind", "owner")).toBe(false);
  });
});

describe("the door behind the hidden switch", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("refuses to store a preference for a kind you cannot receive", () => {
    /* Hiding the switch is what the inbox does; this is so a hand-made call
       cannot leave a client - or an engineer - holding a preference row for
       the owner's usage report. Absent rather than forbidden - naming the
       kind back would confirm it exists. */
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function setNotificationPref"));
    expect(fn.slice(0, 900)).toMatch(/mayReceiveKind\(kind, u\.role\)/);
    expect(fn.slice(0, 900)).toMatch(/Unknown notification kind/);
  });

  it("filters both surfaces that render the list, by role", () => {
    // The inbox, and the very first screen somebody ever sees.
    /* The switches left the inbox for /account/notifications - the preference
       is not part of reading the mail, and the account menu's one word for it
       used to open the letters. Same filter, its own room. */
    expect(read("src/components/NotificationPrefs.tsx")).toMatch(/notifyKindsFor\(role\)\.map/);
    expect(read("src/app/account/notifications/page.tsx")).toMatch(/role=\{user\.role\}/);
    expect(read("src/app/welcome/page.tsx")).toMatch(/notifyKindsFor\(user\.role\)/);
  });

  it("is a display rule, not the thing that decides delivery", () => {
    /* Worth stating: audience is chosen by each sender. Every house kind
       resolves to houseEmails() and every owner kind to houseOwnerEmails().
       A preference has never been able to subscribe anybody to anything, and
       this change did not make it so. */
    const notify = read("src/lib/notify.ts");
    for (const fn of ["notifyModelProposed", "notifyGasEmpty"]) {
      const body = notify.slice(notify.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 700), fn).toMatch(/houseEmails\(/);
    }
    const first = notify.slice(notify.indexOf("export async function notifyFirstSignIn"));
    expect(first.slice(0, 700)).toMatch(/houseOwnerEmails\(/);
    expect(first.slice(0, 700)).not.toMatch(/[^r]houseEmails\(/);
  });

  it("sends every owner kind to the owners at each place it is sent from", () => {
    /* The senders live in three files, and the way this regresses is a new
       call site copying the house helper from the line above it. */
    const actions = read("src/app/actions.ts");
    for (const fn of ["notifyClientShared", "notifyHandoffJoined", "notifyLeadOffered", "notifyLeadClaimed"]) {
      const at = actions.indexOf(`await ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const call = actions.slice(at, at + 200);
      expect(call, fn).toMatch(/houseOwnerEmails\(/);
      expect(call, fn).not.toMatch(/[^r]houseEmails\(/);
    }
    const usage = read("src/app/api/cron/usage/route.ts");
    expect(usage).toMatch(/houseOwnerEmails\(/);
    expect(usage).not.toMatch(/[^r]houseEmails\(/);
  });
});
