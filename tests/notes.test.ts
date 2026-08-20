import { describe, expect, it } from "vitest";
import { canDeleteNote, canEditNote, isAuthor } from "../src/lib/notes";

const note = { authorEmail: "jr@labzen.com", author: "jrharris" };
const jr = { email: "JR@LabZen.com", name: "jrharris", isHouse: false };
const bill = { email: "bill@sierraspectra.com", name: "Bill", isHouse: true };
const dana = { email: "dana@labzen.com", name: "Dana", isHouse: false };

describe("isAuthor", () => {
  it("matches on email, case-blind", () => {
    expect(isAuthor(note, jr)).toBe(true);
    expect(isAuthor(note, dana)).toBe(false);
  });
  it("falls back to the display name only when no email was recorded", () => {
    // Comments posted before the column existed stay editable by their author.
    expect(isAuthor({ authorEmail: "", author: "jrharris" }, jr)).toBe(true);
    expect(isAuthor({ authorEmail: "", author: "jrharris" }, dana)).toBe(false);
    // ...and a stored email is never overridden by a matching name.
    expect(isAuthor({ authorEmail: "someone@else.com", author: "Dana" }, dana)).toBe(false);
  });
  it("a blank identity on both sides is nobody, not everybody", () => {
    expect(isAuthor({ authorEmail: "", author: "" }, { email: "", name: "", isHouse: false })).toBe(false);
    expect(isAuthor({ authorEmail: "", author: "  " }, { email: "x@y.com", name: "  ", isHouse: false })).toBe(false);
  });
});

describe("canEditNote", () => {
  it("is the author alone - the house may not rewrite a client's words", () => {
    expect(canEditNote(note, jr)).toBe(true);
    expect(canEditNote(note, bill)).toBe(false);
    expect(canEditNote(note, dana)).toBe(false);
  });
});

describe("canDeleteNote", () => {
  it("the author withdraws their own", () => {
    expect(canDeleteNote(note, jr)).toBe(true);
  });
  it("the house may withdraw anything on a record it is accountable for", () => {
    expect(canDeleteNote(note, bill)).toBe(true);
  });
  it("a colleague at the same company still may not", () => {
    expect(canDeleteNote(note, dana)).toBe(false);
  });
});
