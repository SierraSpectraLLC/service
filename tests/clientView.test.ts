import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  CARD_EVERYTHING_MAX, CLIENT_STATE, CLIENT_STATES, PM_BADLY_OVERDUE_DAYS, STALE_ANSWER_DAYS,
  STALLED_DAYS, bySeverity, clientState, density, isStalled, medianDays, moveLabel, moveTone,
  needsAttention, queueNeedsThem, rankTodos, sitesOf, standingPill, type ClientTodo,
} from "@/lib/clientView";
import { BLOCKED_STAGE } from "@/lib/stages";

/**
 * The client's product, as executable checks.
 *
 * Two rules carry the whole design. A system's state has to be derivable from
 * what the app already records - anything else would be a number nobody could
 * check. And attention has to scale while inventory does not, or a 34-system
 * account gets a wall instead of an answer.
 */

describe("what a system's state is", () => {
  const sig = (over: Partial<Parameters<typeof clientState>[0]> = {}) =>
    clientState({ openSeverities: [], stages: [], pmDue: false, ...over });

  it("is In service when nothing says otherwise", () => {
    expect(sig()).toBe("ok");
  });

  it("reads Down from an open work order that says Down", () => {
    expect(sig({ openSeverities: ["Down"] })).toBe("down");
    // The severity keys are stored as typed; matching is case-insensitive so a
    // hand-edited row does not silently drop to "In service".
    expect(sig({ openSeverities: ["down"] })).toBe("down");
    expect(sig({ openSeverities: [" DOWN "] })).toBe("down");
  });

  it("reads usable-but-wrong from Degraded", () => {
    expect(sig({ openSeverities: ["Degraded"] })).toBe("attention");
  });

  it("takes the worst open order, not the first", () => {
    expect(sig({ openSeverities: ["Planned", "Degraded", "Down"] })).toBe("down");
    expect(sig({ openSeverities: ["Question", "Degraded"] })).toBe("attention");
  });

  it("ignores severities that say nothing is wrong", () => {
    expect(sig({ openSeverities: ["Planned"] })).toBe("ok");
    expect(sig({ openSeverities: ["Question"] })).toBe("ok");
  });

  it("reports blocked work below usable-but-wrong", () => {
    // A blocked system can often still be run; a degraded one is misbehaving.
    expect(sig({ stages: [BLOCKED_STAGE] })).toBe("blocked");
    expect(sig({ stages: [BLOCKED_STAGE], openSeverities: ["Degraded"] })).toBe("attention");
  });

  it("reports maintenance due only when nothing worse is true", () => {
    expect(sig({ pmDue: true })).toBe("due");
    expect(sig({ pmDue: true, openSeverities: ["Down"] })).toBe("down");
    expect(sig({ pmDue: true, stages: [BLOCKED_STAGE] })).toBe("blocked");
  });

  it("gives every state a label and a tone, worst first", () => {
    const ranks = CLIENT_STATES.map((s) => CLIENT_STATE[s].rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const s of CLIENT_STATES) {
      expect(CLIENT_STATE[s].label.length).toBeGreaterThan(0);
      // No internal vocabulary reaches a client: no stage names, no severity
      // keys, nothing they would have to look up.
      expect(CLIENT_STATE[s].label).not.toMatch(/degraded|stage|queue|blocked \//i);
    }
    expect(CLIENT_STATE.ok.tone).toBe("good");
    expect(CLIENT_STATE.down.tone).toBe("bad");
  });

  it("earns a card for everything that is not In service", () => {
    expect(needsAttention("ok")).toBe(false);
    for (const s of CLIENT_STATES.filter((x) => x !== "ok")) {
      expect(needsAttention(s), s).toBe(true);
    }
  });

  it("sorts the worst into the corner of the eye", () => {
    const order = [...CLIENT_STATES].reverse().sort(bySeverity);
    expect(order).toEqual([...CLIENT_STATES]);
  });
});

describe("whose move it is", () => {
  it("says it in the client's direction, not the shop's", () => {
    // The board says "Ours to move" to a client and means the shop. This is
    // the same fact pointed the other way.
    expect(moveLabel(true, "Sierra Spectra")).toBe("Your move");
    expect(moveLabel(false, "Sierra Spectra")).toBe("With Sierra Spectra");
    expect(moveLabel(true, "Sierra Spectra")).not.toMatch(/ours/i);
  });

  it("colours their move as the one that needs doing", () => {
    expect(moveTone(true)).toBe("warn");
    expect(moveTone(false)).toBe("info");
  });

  it("does not turn a finished job into a chore", () => {
    /* The reported bug, exactly. The shop completed the maintenance on QQQ-6
       and handed it back; the landing announced "Sierra Spectra is waiting on
       you · QQQ-6 is waiting on you" under the words "In service". A queue is
       a position, not an obligation - possession only counts when something
       is pending. */
    expect(queueNeedsThem("ok")).toBe(false);
    for (const s of CLIENT_STATES.filter((x) => x !== "ok")) {
      expect(queueNeedsThem(s), s).toBe(true);
    }
  });

  it("has a third answer for held-and-fine", () => {
    // The condition this replaced tested `state === "ok" && !yourMove`, which
    // is the truth inverted: it said "Nothing pending" about a system the SHOP
    // held and "Your move" about a healthy one the client held.
    expect(standingPill("ok", true, "Sierra Spectra")).toEqual(
      { label: "Nothing pending", tone: "good" });
    expect(standingPill("ok", false, "Sierra Spectra")).toEqual(
      { label: "With Sierra Spectra", tone: "info" });
  });

  it("still says your move when something is actually pending", () => {
    for (const s of CLIENT_STATES.filter((x) => x !== "ok")) {
      expect(standingPill(s, true, "Sierra Spectra").label, s).toBe("Your move");
      expect(standingPill(s, true, "Sierra Spectra").tone, s).toBe("warn");
    }
  });

  it("says who holds it before it says whether it matters", () => {
    // Not theirs is not theirs, whatever state it is in: a system on the
    // bench being repaired is with the shop, not a chore on the client's list.
    for (const s of CLIENT_STATES) {
      expect(standingPill(s, false, "Sierra Spectra").label, s).toBe("With Sierra Spectra");
    }
  });
});

describe("how much to show", () => {
  it("cards everything for a small single-site account", () => {
    expect(density({ systems: 4, sites: 1 })).toBe("cards");
    expect(density({ systems: CARD_EVERYTHING_MAX, sites: 1 })).toBe("cards");
    expect(density({ systems: 0, sites: 0 })).toBe("cards");
  });

  it("groups past a screenful", () => {
    expect(density({ systems: CARD_EVERYTHING_MAX + 1, sites: 1 })).toBe("grouped");
    expect(density({ systems: 34, sites: 1 })).toBe("grouped");
  });

  it("groups on more than one site whatever the count", () => {
    // Two sites is two contexts even at four instruments: a manager standing
    // in one building has no use for the other building's cards.
    expect(density({ systems: 4, sites: 2 })).toBe("grouped");
    expect(density({ systems: 1, sites: 3 })).toBe("grouped");
  });

  it("lets an account override the proxy in both directions", () => {
    expect(density({ systems: 34, sites: 3, override: "cards" })).toBe("cards");
    expect(density({ systems: 2, sites: 1, override: "grouped" })).toBe("grouped");
    expect(density({ systems: 2, sites: 1, override: null })).toBe("cards");
  });

  it("counts sites without counting blanks", () => {
    expect(sitesOf([{ site: "Reno" }, { site: "" }, { site: null }, { site: "Reno" }])).toEqual(["Reno"]);
    expect(sitesOf([{ site: " Hayward " }, { site: "Reno" }])).toEqual(["Hayward", "Reno"]);
    expect(sitesOf([])).toEqual([]);
  });
});

describe("what is waiting on them", () => {
  const todo = (key: string, tone: ClientTodo["tone"], days?: number): ClientTodo =>
    ({ key, tone, title: key, detail: "", href: "/", action: "Open", days });

  it("puts what is costing them today above what will cost them tomorrow", () => {
    const r = rankTodos([todo("a", "warn", 30), todo("b", "bad", 2), todo("c", "warn", 90)]);
    expect(r.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("orders within a tone by how long they have held it", () => {
    const r = rankTodos([todo("new", "bad", 1), todo("old", "bad", 40)]);
    expect(r.map((t) => t.key)).toEqual(["old", "new"]);
  });

  it("does not mutate what it was handed", () => {
    const list = [todo("a", "warn"), todo("b", "bad")];
    rankTodos(list);
    expect(list.map((t) => t.key)).toEqual(["a", "b"]);
  });

  it("has thresholds that mean something", () => {
    expect(STALE_ANSWER_DAYS).toBeGreaterThan(0);
    expect(PM_BADLY_OVERDUE_DAYS).toBeGreaterThan(STALE_ANSWER_DAYS);
  });
});

describe("a queue is a position, not an obligation", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  /* Three surfaces said the same wrong thing about the same fact, which is
     what a rule with three copies does. The rule now lives in one function and
     these check that each surface asks it rather than re-deriving it. */

  it("raises a held system as a chore only when something is pending", () => {
    const src = read("src/lib/clientLandingData.ts");
    expect(src).toMatch(/!s\.queueMine \|\| !queueNeedsThem\(s\.state\)/);
  });

  it("lets a more specific chore own the line", () => {
    /* Gating the queue row on "something is pending" means it now co-occurs
       with whatever made it pending - so a PM fallen due was announced twice,
       once by name and once as "LZ-001 is waiting on you", and a two-item
       list read as four. */
    const src = read("src/lib/clientLandingData.ts");
    expect(src).toMatch(/named\.has\(s\.id\)/);
    expect(src).toMatch(/for \(const p of live\) if \(p\.instrumentId !== null\) named\.add/);
  });

  it("gives the card one pill from one rule", () => {
    const src = read("src/components/ClientLanding.tsx");
    expect(src).toMatch(/standingPill\(s\.state, s\.yourMove, operatorName\)/);
    // The inverted condition this replaced.
    expect(src).not.toMatch(/state === "ok" && !s\.yourMove/);
  });

  it("stops the record using the shop's words about the client's own machine", () => {
    const src = read("src/components/StandingLine.tsx");
    expect(src).toMatch(/clientVoice/);
    expect(src).toMatch(/Nothing is pending on it/);
    // "Ours to move" and "Hand it on" are the shop talking to itself. They
    // survive for staff and must not be the only sentences on offer.
    expect(src).toMatch(/Hand it back/);
    /* Where nothing is pending there is nothing to hand back, so the control
       is Dismiss: the line is a notification that has finished saying its one
       useful thing, and leaving it there forever teaches people to skip the
       top of the record. */
    expect(src).toMatch(/dismissible \?/);
    expect(src).toMatch(/>\s*\{busy \? "Dismissing/);
    expect(src).toMatch(/ackQueueHandback\(instrumentId\)/);
    const page2 = read("src/app/instruments/[id]/page.tsx");
    // Dismissed means gone, not merely quieter.
    expect(page2).toMatch(/!\(handback && inst\.queueAckAt\)/);
    const page = read("src/app/instruments/[id]/page.tsx");
    expect(page).toMatch(/clientVoice=\{!isStaff\}/);
    expect(page).toMatch(/pending=\{somethingPending\}/);
  });
});

describe("reseller pipeline", () => {
  it("calls a unit stalled only when work has actually stopped on it", () => {
    // Thirty days IN a stage is normal for a refurbishment; thirty days
    // BLOCKED is a unit nobody is moving.
    expect(isStalled(BLOCKED_STAGE, STALLED_DAYS)).toBe(true);
    expect(isStalled(BLOCKED_STAGE, STALLED_DAYS - 1)).toBe(false);
    expect(isStalled("Refurbishment", 200)).toBe(false);
  });

  it("takes a median, so one stuck unit does not swallow the picture", () => {
    expect(medianDays([1, 2, 3])).toBe(2);
    expect(medianDays([1, 2, 3, 4])).toBe(3);
    expect(medianDays([2, 4, 6, 400])).toBe(5);
    expect(medianDays([7])).toBe(7);
  });

  it("says nothing rather than zero when there is nothing to average", () => {
    // A pipeline with no completed units has no median. Zero would read as
    // "instant", which is the opposite of the truth.
    expect(medianDays([])).toBeNull();
  });
});

describe("the reseller's own shape", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("counts positions in a process, and never uptime", () => {
    // Uptime is meaningless for a machine that is SUPPOSED to be in pieces -
    // a second reason on top of the one that applies to every account. The
    // word survives in the comment saying so; what must not survive is a
    // figure, so only rendered code is scanned.
    const src = read("src/components/ResellerLanding.tsx");
    expect(src).toMatch(/stage-col/);
    const code = src.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/\{\/\*/.test(l))
      .join("\n");
    expect(code).not.toMatch(/uptime/i);
    expect(code).not.toMatch(/response time/i);
  });

  it("says so rather than showing a zero when a stage has no history", () => {
    const src = read("src/components/ResellerLanding.tsx");
    expect(src).toMatch(/medianDays === null/);
    expect(src).toMatch(/no history yet/);
  });

  it("reads blocked age from the column that is always written", () => {
    // The stage-event log is the general answer, but blocking writes its own
    // column - and blocked age is the one thing this page acts on.
    const src = read("src/lib/clientLandingData.ts");
    expect(src).toMatch(/blockedSince/);
    expect(src).toMatch(/stage === BLOCKED_STAGE/);
  });

  it("keeps listings behind the resale flag", () => {
    const src = read("src/app/listings/page.tsx");
    expect(src).toMatch(/if \(!org\?\.resale\) redirect\("\/"\)/);
    expect(src).toMatch(/isStaffRole\(user\.role\) \|\| user\.orgId === null\) redirect/);
    // Scoped like every other client read.
    expect(src).toMatch(/visibleSystemIds\(user\)/);
  });

  it("gives a reseller a pipeline door and a lab a parts door", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/resells \? "Your pipeline" : "Your lab"/);
    expect(layout).toMatch(/href: "\/listings", label: "Listings"/);
    // The parts store does not vanish for a reseller; it moves one level down.
    expect(layout).toMatch(/resells && isClientOrg \? \[\{ href: "\/store", label: "Parts" \}\]/);
  });
});

describe("no fabricated metric reaches a client", () => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("computes no uptime and no response time anywhere", () => {
    /* There is no service-state history in this schema and no first-response
       capture: no downSince, no outage table, no Down stage. The mockup's
       97.2% and its six-hour median cannot be derived from what exists, and a
       figure a client cannot check and we cannot defend is worse than no
       figure. Both are Phase 4, behind a decision about capture.

       This test is a guard rather than a cleanup - nothing computes them
       today, and the point is that nothing starts to. */
    const offenders: string[] = [];
    for (const f of walk("src")) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (/\buptimePct|\buptimePercent|responseTimeHours|medianResponse|instrumentDays/i.test(line)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the client landing's figures to things that are counted", () => {
    const src = readFileSync("src/components/ClientLanding.tsx", "utf8");
    // The band takes whatever the page hands it, and the page hands it counts.
    expect(src).toMatch(/thisYear\?:/);
    const page = readFileSync("src/app/(dashboard)/page.tsx", "utf8");
    expect(page).toMatch(/closedThisYear/);
    expect(page).not.toMatch(/uptime/i);
  });
});
