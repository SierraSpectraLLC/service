import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every export of a "use server" module must be an async function.
 *
 * Not a style rule - the bundler enforces it, and it enforces it late. This
 * compiles, typechecks, and passes every test:
 *
 *   export const setQuoteLineDescription = (id: number, text: string) =>
 *     setLineDescription("quote", id, text);
 *
 * It returns a promise, it is the same function to TypeScript, and `next build`
 * refuses it with "Server Actions must be async functions" - which is a broken
 * deploy found by a deploy. The same trick tests/clientBundle.test.ts uses for
 * the other failure `tsc` cannot see: read the source.
 *
 * The fix is always to write it as `export async function`.
 */

const SRC = join(process.cwd(), "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
  });

/** The modules Next turns into server actions: the ones that say so. */
const actionFiles = walk(SRC).filter((f) => {
  const head = readFileSync(f, "utf8").slice(0, 200);
  return /^["']use server["']/m.test(head);
});

describe("server action modules", () => {
  it("are the files that say they are", () => {
    // If this ever finds none, the check below is passing vacuously.
    expect(actionFiles.length).toBeGreaterThan(0);
  });

  for (const file of actionFiles) {
    const name = file.replace(`${process.cwd()}/`, "");
    it(`${name}: every export is an async function`, () => {
      const src = readFileSync(file, "utf8");
      const bad: string[] = [];
      // `export const x = ...` and `export function x` - both legal TypeScript,
      // both refused by the bundler unless the function is async.
      for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+(\w+)\s*[:=]([^\n]*)/gm)) {
        // A type-only export is not a value the bundler has to wrap.
        if (/^export\s+type\b/.test(m[0])) continue;
        if (!/=>\s*$|async\b/.test(m[2])) { bad.push(`${m[1]} - not async`); continue; }
        if (!/\basync\b/.test(m[2])) bad.push(`${m[1]} - arrow, but not async`);
      }
      for (const m of src.matchAll(/^export\s+function\s+(\w+)/gm)) {
        bad.push(`${m[1]} - function, but not async`);
      }
      expect(
        bad,
        `"use server" exports that next build will refuse:\n${bad.join("\n")}\n`
        + `Write each as: export async function <name>(...)`,
      ).toEqual([]);
    });
  }
});
