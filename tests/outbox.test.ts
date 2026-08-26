import { describe, expect, it } from "vitest";
import {
  MAX_HOLD_SECONDS, QUIET_SECONDS, batchEmail, batchKey, dueAt, groupHeld, isDue,
} from "@/lib/outbox";
import { holdFor, NOTIFY_KINDS } from "@/lib/inbox";

/**
 * When a held email comes due, and what it says when several do at once.
 *
 * The failure this guards is not "the email looked wrong" - it is "the email
 * never came". A sliding window is one missing floor away from holding
 * somebody's assignment forever, and silence is the one failure mode nobody
 * reports, because there is nothing to report.
 */

const at = (s: string) => new Date(`2026-08-26T${s}Z`);

const held = (over: Partial<Parameters<typeof batchKey>[0]> = {}) => ({
  id: 1, email: "bill@sierra.test", kind: "task_assigned",
  title: 'Joe assigned you "Install new collision cell" on LZ-001',
  href: "/instruments/1", subject: 'LZ-001: assigned "Install new collision cell"',
  body: "<p>one</p>", actor: "Joe", context: "LZ-001", item: "Install new collision cell",
  ...over,
});

describe("when a burst has gone quiet", () => {
  it("waits the quiet window from the moment it was queued", () => {
    expect(dueAt(at("09:00:00"), QUIET_SECONDS)).toEqual(at("09:00:30"));
  });

  it("is not due while the window is still running", () => {
    const row = { sendAfter: at("09:00:30"), sendBy: at("09:05:00") };
    expect(isDue(row, at("09:00:29"))).toBe(false);
    expect(isDue(row, at("09:00:30"))).toBe(true);
  });

  it("SENDS ANYWAY once the deadline arrives, however long the burst runs", () => {
    // The floor under the sliding window. Somebody assigning a task every
    // twenty seconds all afternoon would otherwise hold the first one all
    // afternoon - and an email that never comes is a worse failure than one
    // that comes twice, because nobody ever reports it.
    const stillSliding = { sendAfter: at("17:00:00"), sendBy: at("09:05:00") };
    expect(isDue(stillSliding, at("09:05:00"))).toBe(true);
  });

  it("gives the deadline enough room for a real burst", () => {
    // Long enough that somebody typing out an install list is never cut in
    // half, short enough that a stuck queue is noticed the same morning.
    expect(MAX_HOLD_SECONDS).toBeGreaterThan(QUIET_SECONDS * 4);
    expect(MAX_HOLD_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});

describe("which kinds wait at all", () => {
  it("holds task assignment, because that is the bursty one", () => {
    expect(holdFor("task_assigned")).toMatchObject({ seconds: 30 });
  });

  it("sends everything else at once", () => {
    // Holding a solitary event buys nothing and costs it thirty seconds. A gas
    // going empty happens once and should interrupt at once.
    for (const k of NOTIFY_KINDS) {
      if (k.kind === "task_assigned") continue;
      expect(holdFor(k.kind), k.kind).toBeNull();
    }
  });

  it("does not hold a kind nobody has heard of", () => {
    expect(holdFor("nonsense")).toBeNull();
  });
});

describe("what belongs in one email", () => {
  it("groups by recipient, kind, actor and system together", () => {
    const rows = [
      held({ id: 1, item: "Collision cell" }),
      held({ id: 2, item: "Autosampler" }),
      held({ id: 3, item: "Chiller" }),
    ];
    expect(groupHeld(rows)).toHaveLength(1);
  });

  it("keeps two people's assignments apart", () => {
    expect(groupHeld([held({ id: 1 }), held({ id: 2, email: "sam@sierra.test" })])).toHaveLength(2);
  });

  it("keeps two systems apart rather than summarising them away", () => {
    // "You have 5 notifications" is not a sentence anybody can act on. Two
    // coherent emails beat one vague one - see batchKey.
    expect(groupHeld([held({ id: 1 }), held({ id: 2, context: "LZ-002" })])).toHaveLength(2);
  });

  it("keeps two assigners apart", () => {
    expect(groupHeld([held({ id: 1 }), held({ id: 2, actor: "Sam" })])).toHaveLength(2);
  });
});

describe("what the email says", () => {
  it("leaves a single assignment exactly as it was", () => {
    // The common case must not pay for the burst case. One task is the email
    // it has always been, subject and body untouched.
    const one = held();
    const out = batchEmail([one], "tasks", "https://app.test");
    expect(out.subject).toBe(one.subject);
    expect(out.body).toBe(one.body);
  });

  it("says who, how many and where - once - and then lists the things", () => {
    const rows = [
      held({ id: 1, item: "Install new collision cell" }),
      held({ id: 2, item: "Set up the chiller" }),
      held({ id: 3, item: "Connect the roughing pump" }),
    ];
    const out = batchEmail(rows, "tasks", "https://app.test");
    expect(out.subject).toBe("LZ-001: 3 tasks assigned");
    expect(out.body).toContain("Joe");
    expect(out.body).toContain("3 tasks");
    expect(out.body).toContain("on LZ-001");
    for (const r of rows) expect(out.body).toContain(r.item);
  });

  it("does not repeat the actor and the system on every line", () => {
    // The whole point of coalescing. Five paragraphs each saying "Joe assigned
    // you ... on LZ-001" is the five emails again, in one envelope.
    const rows = [held({ id: 1, item: "A" }), held({ id: 2, item: "B" })];
    const body = batchEmail(rows, "tasks").body;
    expect(body.match(/LZ-001/g) ?? []).toHaveLength(1);
  });

  it("falls back to the inbox sentence for a row with no short form", () => {
    // A blank bullet is worse than a repetitive one.
    const rows = [held({ id: 1, item: "" }), held({ id: 2, item: "B" })];
    expect(batchEmail(rows, "tasks").body).toContain("Install new collision cell");
  });

  it("escapes what people typed", () => {
    const rows = [
      held({ id: 1, item: '<script>alert("x")</script>' }),
      held({ id: 2, item: "B" }),
    ];
    const body = batchEmail(rows, "tasks").body;
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("still reads when there is no system behind the tasks", () => {
    const rows = [held({ id: 1, context: "" }), held({ id: 2, context: "" })];
    const out = batchEmail(rows, "tasks");
    expect(out.subject).toBe("2 tasks assigned to you");
    expect(out.body).not.toContain(" on .");
  });
});
