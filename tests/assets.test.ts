import { describe, it, expect } from "vitest";
import { assetAttention } from "@/lib/stages";
import { mergeAssetHistory } from "@/lib/assetHistory";
import { formatHours } from "@/lib/hours";

const d = (s: string) => new Date(s);

describe("assetAttention", () => {
  it("flags only Needs attention and Down", () => {
    expect(assetAttention("Needs attention")).toBe(true);
    expect(assetAttention("Down")).toBe(true);
    for (const s of ["In service", "Spare", "Decommissioned"]) expect(assetAttention(s)).toBe(false);
  });
});

describe("mergeAssetHistory", () => {
  it("merges all four sources newest-first with system attribution", () => {
    const lines = mergeAssetHistory(
      [{ kind: "installed", instrumentId: 1, detail: "into G-010", actor: "Joe", at: d("2026-01-09") },
       { kind: "moved", instrumentId: 2, detail: "G-010 -> U-001", actor: "Joe", at: d("2026-07-24") }],
      [{ title: "Flow calibration", state: "Done", instrumentId: 1, createdAt: d("2026-03-10"), completedAt: d("2026-03-12") }],
      [{ name: "Pump seal kit", status: "Installed", instrumentId: 2, createdAt: d("2026-07-28") }],
      [{ person: "Bill", minutes: 90, note: "seal swap", instrumentId: 2, createdAt: d("2026-07-27") }],
      formatHours,
    );
    expect(lines.map((l) => l.kind)).toEqual(["part", "time", "event", "task", "event"]);
    expect(lines[0].instrumentId).toBe(2);
    expect(lines[3].text).toBe("✓ Flow calibration");
    expect(lines[1].text).toBe("1.5 h — Bill");
  });
  it("keeps work the asset owns on its own, with no system attribution", () => {
    const lines = mergeAssetHistory(
      [],
      [{ title: "Bench refurb", state: "Open", instrumentId: null, createdAt: d("2026-08-01"), completedAt: null }],
      [{ name: "Pump seal kit", status: "Installed", instrumentId: null, createdAt: d("2026-08-02") }],
      [], formatHours,
    );
    expect(lines.map((l) => l.instrumentId)).toEqual([null, null]);
    expect(lines[0].text).toBe("Pump seal kit");
    expect(lines[1].text).toBe("Bench refurb");
  });

  it("uses completion time for done tasks and creation time for open ones", () => {
    const lines = mergeAssetHistory(
      [],
      [{ title: "Open task", state: "Open", instrumentId: 1, createdAt: d("2026-07-01"), completedAt: null },
       { title: "Done later", state: "Done", instrumentId: 1, createdAt: d("2026-06-01"), completedAt: d("2026-07-15") }],
      [], [], formatHours,
    );
    expect(lines[0].text).toBe("✓ Done later");
    expect(lines[1].detail).toBe("Open");
  });
});
