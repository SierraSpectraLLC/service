import { describe, expect, it } from "vitest";
import { WHATS_NEW, audienceAllows, latestKey, unseenFor, type WhatsNewEntry } from "../src/lib/whatsNew";

const entry = (key: string, audience: WhatsNewEntry["audience"] = "all"): WhatsNewEntry =>
  ({ key, date: "2026-08-19", title: key, body: "x", audience });

const LIST = [entry("c", "owner"), entry("b", "staff"), entry("a", "all")]; // newest first

describe("audienceAllows", () => {
  it("staff cards are for staff and the owner; owner cards for the owner alone", () => {
    expect(audienceAllows("all", "client_viewer")).toBe(true);
    expect(audienceAllows("staff", "client_editor")).toBe(false);
    expect(audienceAllows("staff", "staff")).toBe(true);
    expect(audienceAllows("staff", "owner")).toBe(true);
    expect(audienceAllows("owner", "staff")).toBe(false);
    expect(audienceAllows("owner", "owner")).toBe(true);
  });
});

describe("unseenFor", () => {
  it("a blank marker means everything the role may see", () => {
    expect(unseenFor(LIST, "owner", "").map((e) => e.key)).toEqual(["c", "b", "a"]);
    expect(unseenFor(LIST, "client_viewer", "").map((e) => e.key)).toEqual(["a"]);
  });

  it("everything at or below the marker stays gone", () => {
    expect(unseenFor(LIST, "owner", "b").map((e) => e.key)).toEqual(["c"]);
    expect(unseenFor(LIST, "owner", "c")).toEqual([]);
  });

  it("a client's marker advances past staff cards they were never shown", () => {
    // Jane dismissed when "c" was newest; a staff-only "d" arriving later must
    // not resurface "a" for her, and "d" itself is not hers to see.
    const later = [entry("d", "staff"), ...LIST];
    expect(unseenFor(later, "client_viewer", "c")).toEqual([]);
  });

  it("an unknown marker (entry later removed) falls back to showing the batch", () => {
    expect(unseenFor(LIST, "client_viewer", "gone-key").map((e) => e.key)).toEqual(["a"]);
  });
});

describe("latestKey", () => {
  it("is the newest entry, and blank on an empty list", () => {
    expect(latestKey(LIST)).toBe("c");
    expect(latestKey([])).toBe("");
  });
});

describe("the real entries", () => {
  it("keys are unique - a duplicate would corrupt everyone's seen marker", () => {
    const keys = WHATS_NEW.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("newest first, dated, and every image lives under /whatsnew/", () => {
    const dates = WHATS_NEW.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const e of WHATS_NEW) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (e.image) expect(e.image).toMatch(/^\/whatsnew\//);
    }
  });
});
