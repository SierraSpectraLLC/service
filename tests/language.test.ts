// The app is written in American English, and the browser has to be told.
//
// This looks like a nicety and is not. A document's language tag is what a
// browser picks its SPELLCHECK DICTIONARY from, and a bare "en" leaves the
// choice to whatever variant the machine prefers - so an American shop typing
// an American word into its own work order gets it underlined in red, and the
// engineer who "fixes" it ships "utilising" to a client.
//
// A source scan rather than a render test, for the same reason as
// tests/tenantStamp: the failure compiles, renders and looks perfect. Nobody
// notices until somebody is typing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p)
      : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });

const files = walk("src");

/** Every `<html ...>` open tag this codebase writes, with its file. */
const htmlTags = files.flatMap((f) => {
  const src = readFileSync(f, "utf8");
  return [...src.matchAll(/<html\b[^>]*>/g)].map((m) => ({ file: f, tag: m[0] }));
});

describe("every document this app produces declares its language", () => {
  it("finds the ones there are, so the test cannot pass by finding none", () => {
    // The app shell, the two email shells and the preview wrapper. If this
    // number changes, a new document was added - and it needs a tag too.
    expect(htmlTags.length).toBeGreaterThanOrEqual(4);
  });

  it("tags every one of them en-US, never a bare en", () => {
    const wrong = htmlTags
      .filter((h) => !/lang="en-US"/.test(h.tag))
      .map((h) => `${h.file}: ${h.tag}`);
    expect(wrong, `documents without lang="en-US":\n${wrong.join("\n")}`).toEqual([]);
  });
});

describe("the copy the app ships is American too", () => {
  // Only the spellings that actually appear in this domain's vocabulary, and
  // only in text a person reads - a British spelling in a comment is somebody
  // else's business, and "colour" is a word this codebase uses in prose about
  // design on purpose.
  const BRITISH = [
    ["utilis", "utiliz"], ["organis", "organiz"], ["recognis", "recogniz"],
    ["authoris", "authoriz"], ["apologis", "apologiz"], ["labour", "labor"],
    ["licence", "license"], ["catalogue", "catalog"], ["enquir", "inquir"],
    ["fulfil\\b", "fulfill"], ["colour", "color"], ["centre", "center"],
  ] as const;

  // NOT on the list, deliberately: "cancelled". It is the work order's and the
  // purchase order's stored STATE, spelled that way in the database since the
  // first migration, and every label that reads it matches. Renaming copy to
  // "canceled" while the column says otherwise buys nothing and invites a
  // mismatch somebody has to debug.

  /**
   * What a person actually reads. Comments come out - they are ours, not the
   * app's - and so does anything welded into an identifier: `canOrganise` is a
   * prop name, and a word boundary is what tells it apart from the sentence
   * that says "organise". Nobody spellchecks a prop.
   */
  const readable = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const [bad, good] of BRITISH) {
    it(`says "${good}", not "${bad.replace(/\\b/, "")}"`, () => {
      const re = new RegExp(`\\b${bad}`, "i");
      const hits = files.filter((f) => re.test(readable(readFileSync(f, "utf8"))));
      expect(hits, `British spelling "${bad}" in:\n${hits.join("\n")}`).toEqual([]);
    });
  }
});
