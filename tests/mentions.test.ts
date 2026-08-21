import { describe, expect, it } from "vitest";
import { applyMention, matchMentions, mentionQuery, type Candidate } from "../src/lib/mentions";

const PEOPLE: Candidate[] = [
  { name: "Nic Caciappo", email: "nic@labzen.com", org: "LabZen" },
  { name: "Nicholas Romero", email: "nrom@labzen.com", org: "LabZen" },
  { name: "Nick Garrison Jr.", email: "nickg@sierraspectra.com", org: "Sierra Spectra" },
  { name: "Chris Ma", email: "chris@sierraspectra.com", org: "Sierra Spectra" },
  { name: "Bill", email: "bill@sierraspectra.com", org: "Sierra Spectra" },
];

describe("mentionQuery", () => {
  it("finds the token being typed at the caret", () => {
    expect(mentionQuery("@ni", 3)).toEqual({ start: 0, end: 3, text: "ni" });
    expect(mentionQuery("ask @ni", 7)).toEqual({ start: 4, end: 7, text: "ni" });
  });
  it("a bare @ offers everyone rather than nothing", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, end: 1, text: "" });
  });
  it("keeps up with a full name across one space", () => {
    expect(mentionQuery("@Chris Ma", 9)?.text).toBe("Chris Ma");
  });
  it("gives up at a second space - that is a sentence, not a name", () => {
    expect(mentionQuery("@Chris Ma looked", 16)).toBeNull();
  });
  it("an email address is not a mention", () => {
    // The @ is mid-word, so nothing is being mentioned here.
    expect(mentionQuery("joe@sierraspectra.com", 21)).toBeNull();
  });
  it("only reads up to the caret", () => {
    // Caret sits before the @: nothing is being typed yet.
    expect(mentionQuery("hello @nic", 5)).toBeNull();
  });
  it("stops once the token is longer than any name", () => {
    expect(mentionQuery("@" + "a".repeat(40), 41)).toBeNull();
  });
  it("no @ at all is no query", () => {
    expect(mentionQuery("just a comment", 14)).toBeNull();
  });
});

describe("matchMentions", () => {
  it("ranks name-prefix first, then a word inside the name", () => {
    expect(matchMentions(PEOPLE, "ni").map((p) => p.name))
      .toEqual(["Nic Caciappo", "Nicholas Romero", "Nick Garrison Jr."]);
    // "ma" is not a prefix of "Chris Ma", but it starts one of its words.
    expect(matchMentions(PEOPLE, "ma").map((p) => p.name)).toEqual(["Chris Ma"]);
  });
  it("is case-blind and matches on email as a last resort", () => {
    expect(matchMentions(PEOPLE, "NICK").map((p) => p.name)).toEqual(["Nick Garrison Jr."]);
    expect(matchMentions(PEOPLE, "nrom").map((p) => p.name)).toEqual(["Nicholas Romero"]);
  });
  it("an empty query offers everyone, capped", () => {
    expect(matchMentions(PEOPLE, "")).toHaveLength(5);
    expect(matchMentions(PEOPLE, "", 2)).toHaveLength(2);
  });
  it("no match is an empty list, never a fallback to everyone", () => {
    expect(matchMentions(PEOPLE, "zzz")).toEqual([]);
  });
  it("drops duplicate names - one person cannot be two rows to pick from", () => {
    const dupes = [...PEOPLE, { name: "bill", email: "other@x.com", org: "Elsewhere" }];
    expect(matchMentions(dupes, "bill")).toHaveLength(1);
  });
});

describe("applyMention", () => {
  it("replaces the token with the full name and a space", () => {
    const q = mentionQuery("@ni", 3)!;
    expect(applyMention("@ni", q, "Nick Garrison Jr."))
      .toEqual({ text: "@Nick Garrison Jr. ", caret: 19 });
  });
  it("keeps what came before and after, and puts the caret after the name", () => {
    const text = "ask @ni about it";
    const q = mentionQuery(text, 7)!;
    const out = applyMention(text, q, "Chris Ma");
    expect(out.text).toBe("ask @Chris Ma  about it");
    expect(out.text.slice(0, out.caret)).toBe("ask @Chris Ma ");
  });
  it("a name picked from a bare @ still lands complete", () => {
    const q = mentionQuery("@", 1)!;
    expect(applyMention("@", q, "Bill").text).toBe("@Bill ");
  });
});
