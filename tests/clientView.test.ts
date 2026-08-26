import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  CARD_EVERYTHING_MAX, CLIENT_STATE, CLIENT_STATES, PM_BADLY_OVERDUE_DAYS, STALE_ANSWER_DAYS,
  STALLED_DAYS, bySeverity, clientState, density, isStalled, medianDays, moveLabel, moveTone,
  needsAttention, rankTodos, sitesOf, type ClientTodo,
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
