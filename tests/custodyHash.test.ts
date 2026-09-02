import { describe, expect, it } from "vitest";
import { GENESIS, canonical, eventHash, verifyChain, type ChainLink } from "@/lib/custody/hash";
import { closeKindFor, custodianAt, spanAt, spansOf, type CustodyRow } from "@/lib/custody/spans";

/**
 * The chain is worth exactly what it costs to edit around, and its two useful
 * properties are easy to lose by accident: the same event must hash the same on
 * every server (V8 key order is insertion order, and a row read back from
 * Postgres does not come back in the order it went in), and redacting the
 * private half must NOT break it - otherwise a shop is made to choose between
 * an honest record and a verifiable one.
 */

const at = new Date("2026-03-04T12:00:00Z");
const base = {
  kind: "pm", occurredAt: at, authorOrgId: 4,
  procedureKeys: [{ key: "6495c/replace-lamp", state: "done" as const }],
  provenance: { findings: "Lamp replaced.", planned: true },
};

describe("canonical form", () => {
  it("does not care what order the keys arrived in", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ a: { z: 1, y: 2 } })).toBe(canonical({ a: { y: 2, z: 1 } }));
  });

  it("keeps array order, which is content", () => {
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it("treats an unset optional field and an absent one as the same event", () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });

  it("writes dates as one unambiguous string", () => {
    expect(canonical(at)).toBe('"2026-03-04T12:00:00.000Z"');
  });
});

describe("what the hash covers", () => {
  it("changes when anything that travelled changes", () => {
    const h = eventHash(GENESIS, base);
    expect(eventHash(GENESIS, { ...base, kind: "repair" })).not.toBe(h);
    expect(eventHash(GENESIS, { ...base, occurredAt: new Date("2026-03-05T12:00:00Z") })).not.toBe(h);
    expect(eventHash(GENESIS, { ...base, authorOrgId: 5 })).not.toBe(h);
    expect(eventHash(GENESIS, { ...base, provenance: { ...base.provenance, findings: "x" } })).not.toBe(h);
    expect(eventHash(GENESIS, { ...base, procedureKeys: [] })).not.toBe(h);
  });

  it("changes when the link before it changes, which is the whole mechanism", () => {
    expect(eventHash("aaa", base)).not.toBe(eventHash("bbb", base));
  });

  it("is stable across two objects built in different orders", () => {
    const other = {
      provenance: { planned: true, findings: "Lamp replaced." },
      procedureKeys: base.procedureKeys, authorOrgId: 4, occurredAt: at, kind: "pm",
    };
    expect(eventHash(GENESIS, other)).toBe(eventHash(GENESIS, base));
  });
});

describe("verifying a chain", () => {
  const link = (id: number, prev: string, over: Partial<ChainLink> = {}): ChainLink => {
    const e = { id, ...base, prevHash: prev, hash: "", ...over } as ChainLink;
    return { ...e, hash: over.hash ?? eventHash(prev, { ...base, ...over } as typeof base) };
  };

  it("walks a good chain", () => {
    const a = link(1, GENESIS);
    const b = link(2, a.hash!, { kind: "repair" });
    expect(verifyChain([a, b])).toEqual({ ok: true });
  });

  it("names the FIRST broken link, not every link after it", () => {
    // Everything downstream of an edit is broken by arithmetic. Counting would
    // report one edit as forty and bury the row somebody should look at.
    const a = link(1, GENESIS);
    const b = link(2, a.hash!, { kind: "repair" });
    const c = link(3, b.hash!, { kind: "note" });
    const tampered = { ...b, kind: "tune" };
    const got = verifyChain([a, tampered, c]);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.at).toBe(2);
  });

  it("survives a redaction, which is the point of leaving private out", () => {
    // A shop that redacts a customer's site address must not thereby invalidate
    // its own service history.
    const a = link(1, GENESIS);
    const withPrivate = { ...a, private: { site: "Hayward" } } as ChainLink & { private: unknown };
    const redacted = { ...a, private: {} } as ChainLink & { private: unknown };
    expect(verifyChain([withPrivate])).toEqual({ ok: true });
    expect(verifyChain([redacted])).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------

describe("spans of custody", () => {
  const row = (id: number, kind: string, from: number | null, to: number | null, day: string): CustodyRow =>
    ({ id, kind, fromOrgId: from, toOrgId: to, fromName: from ? `org${from}` : "", toName: to ? `org${to}` : "", at: new Date(`${day}T12:00:00Z`) });

  const rows = [
    row(1, "intake", null, 10, "2020-01-01"),
    row(2, "transfer", 10, 11, "2022-06-01"),
    row(3, "transfer", 11, 12, "2024-03-01"),
  ];
  const spans = spansOf(rows, { custodianOrgId: 12, custodianName: "org12" });

  it("numbers spans from one and leaves only the last one open", () => {
    expect(spans.map((s) => [s.n, s.custodianOrgId, s.closeKind]))
      .toEqual([[1, 10, "sealed"], [2, 11, "sealed"], [3, 12, "open"]]);
  });

  it("does not invent a span for the time before the first handoff", () => {
    // Every owned system was backfilled with one intake row, so the stretch
    // before it is the stretch before this platform existed. Somebody's
    // history, and we have none of it.
    expect(custodianAt(spans, new Date("2015-01-01T12:00:00Z"))).toEqual({ orgId: null, name: "" });
    expect(spanAt(spans, new Date("2015-01-01T12:00:00Z"))).toBeNull();
  });

  it("puts a moment in the span that held it", () => {
    expect(custodianAt(spans, new Date("2021-05-05T12:00:00Z")).orgId).toBe(10);
    expect(custodianAt(spans, new Date("2023-01-01T12:00:00Z")).orgId).toBe(11);
    expect(custodianAt(spans, new Date("2030-01-01T12:00:00Z")).orgId).toBe(12);
  });

  it("hands a handoff day to the incoming holder, not the outgoing one", () => {
    // The boundary is the moment the machine moved; work recorded at that
    // instant is the new holder's.
    expect(custodianAt(spans, new Date("2022-06-01T12:00:00Z")).orgId).toBe(11);
  });

  it("lets the instrument pointer win the open span, so a disagreement stays visible", () => {
    // scripts/custody-parity is what reports the disagreement. Silently
    // preferring the handoff chain would hide it.
    const odd = spansOf(rows, { custodianOrgId: 99, custodianName: "org99" });
    expect(odd[odd.length - 1].custodianOrgId).toBe(99);
    expect(odd[0].custodianOrgId).toBe(10);
  });

  it("records house stewardship as a real span rather than a missing one", () => {
    const back = spansOf([...rows, row(4, "release", 12, null, "2025-01-01")], { custodianOrgId: null, custodianName: "house stewardship" });
    expect(back[3].custodianOrgId).toBeNull();
    expect(back[2].closeKind).toBe("sealed");
  });

  it("knows a claim closed a span differently from a sale", () => {
    expect(closeKindFor("claim")).toBe("claimed");
    expect(closeKindFor("transfer")).toBe("sealed");
  });

  it("has no spans at all for a machine nothing has ever been recorded about", () => {
    expect(spansOf([], { custodianOrgId: 7, custodianName: "x" })).toEqual([]);
  });
});
