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
 */

const HOUSE_ONLY = [
  "gas_empty", "issue", "pm_request", "renewal",
  "model_proposal", "sign_in", "usage_report",
];

describe("who is offered which switch", () => {
  it("keeps the operator's own concerns off a client's list", () => {
    const client = notifyKindsFor(false).map((k) => k.kind);
    for (const kind of HOUSE_ONLY) expect(client, kind).not.toContain(kind);
    // Staff lose nothing.
    expect(notifyKindsFor(true).map((k) => k.kind)).toEqual(NOTIFY_KINDS.map((k) => k.kind));
  });

  it("hides the two that disclose what the operator watches", () => {
    /* "Somebody signs in to the portal for the first time" and "the weekly
       report of who is using the portal" are the operator's business to
       disclose in their own words, not a checkbox's to leak on their behalf. */
    const labels = notifyKindsFor(false).map((k) => k.label).join(" | ");
    expect(labels).not.toMatch(/signs in to the portal/i);
    expect(labels).not.toMatch(/who is using the portal/i);
  });

  it("keeps every kind a client genuinely receives", () => {
    /* Removing a switch somebody needs is the same failure pointed the other
       way: their email carries on and the way to stop it is gone. */
    const client = notifyKindsFor(false).map((k) => k.kind);
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
      expect(["house", "all"], k.kind).toContain(k.audience);
    }
    expect(NOTIFY_KINDS.filter((k) => k.audience === "house").map((k) => k.kind).sort())
      .toEqual([...HOUSE_ONLY].sort());
  });

  it("answers the same question for one kind at a time", () => {
    expect(mayReceiveKind("usage_report", true)).toBe(true);
    expect(mayReceiveKind("usage_report", false)).toBe(false);
    expect(mayReceiveKind("message", false)).toBe(true);
    expect(mayReceiveKind("not_a_kind", true)).toBe(false);
  });
});

describe("the door behind the hidden switch", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("refuses to store a preference for a kind you cannot receive", () => {
    /* Hiding the switch is what the inbox does; this is so a hand-made call
       cannot leave a client holding a preference row for the operator's usage
       report. Absent rather than forbidden - naming the kind back would
       confirm it exists. */
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function setNotificationPref"));
    expect(fn.slice(0, 900)).toMatch(/mayReceiveKind\(kind, isStaffRole\(u\.role\)\)/);
    expect(fn.slice(0, 900)).toMatch(/Unknown notification kind/);
  });

  it("filters both surfaces that render the list", () => {
    // The inbox, and the very first screen somebody ever sees.
    expect(read("src/components/InboxPanel.tsx")).toMatch(/notifyKindsFor\(isStaff\)\.map/);
    expect(read("src/app/welcome/page.tsx")).toMatch(/notifyKindsFor\(isStaffRole\(user\.role\)\)/);
  });

  it("is a display rule, not the thing that decides delivery", () => {
    /* Worth stating: audience is chosen by each sender, and every house kind
       resolves to houseEmails(). A preference has never been able to subscribe
       anybody to anything, and this change did not make it so. */
    const notify = read("src/lib/notify.ts");
    for (const fn of ["notifyFirstSignIn", "notifyModelProposed", "notifyGasEmpty"]) {
      const body = notify.slice(notify.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 700), fn).toMatch(/houseEmails\(/);
    }
  });
});
