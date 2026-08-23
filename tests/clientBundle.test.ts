import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No "use client" module may reach src/db, directly or through any number of
 * hops.
 *
 * src/db/index.ts calls neon(process.env.DATABASE_URL!) at module top level, so
 * merely importing it in the browser throws before a single component renders -
 * and the page dies with an error that names none of this. Neither `tsc` nor
 * `next build` catches it: the types are fine and the server build is fine. The
 * only symptom is opening the page.
 *
 * It happened via lib/stock -> lib/tenancy -> src/db, because a pure inventory
 * rule needed one role predicate that lived in a database-backed module. The
 * fix was to move the predicate somewhere with no imports; this test is what
 * stops the next one, since the tempting import is always a small one.
 */

const SRC = join(process.cwd(), "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
  });

const files = walk(SRC);
const read = (f: string) => readFileSync(f, "utf8");

/** Resolve an "@/..." specifier to a real file on disk. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = join(SRC, spec.slice(2));
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (files.includes(cand)) return cand;
  }
  return null;
}

/**
 * Value imports only. `import type { X }` and `import { type X }` are erased
 * before bundling, so they can point anywhere.
 */
function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)from\s+"(@\/[^"]+)"/g;
  for (const [, typeOnly, clause, spec] of src.matchAll(re)) {
    if (typeOnly) continue;
    const named = clause.trim();
    // `import { type A, type B } from "..."` is entirely erased too.
    if (named.startsWith("{") && named.endsWith("}")) {
      const parts = named.slice(1, -1).split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length && parts.every((p) => p.startsWith("type "))) continue;
    }
    out.push(spec);
  }
  return out;
}

/**
 * A "use server" module is a boundary, not a dependency: Next replaces each
 * exported action with an RPC stub, so nothing behind it is bundled for the
 * browser. That's exactly why every panel here can call app/actions freely.
 */
const isServerModule = (src: string) => /^\s*["']use server["']/.test(src);

/**
 * Every `node:` builtin a module reaches for, statically OR dynamically.
 *
 * The dynamic half was added after `await import("node:crypto")` inside a
 * webhook-signature helper rode into the browser graph on one arithmetic
 * function the client portal wanted. Only the static form was matched, so this
 * guard passed and the dev build died instead - which is exactly backwards
 * from what the test is for. A deferred import is still an import.
 */
function nodeImports(src: string): string[] {
  return [
    ...[...src.matchAll(/import\s+(type\s+)?[\s\S]*?from\s+"(node:[^"]+)"/g)]
      .filter((m) => !m[1]).map((m) => m[2]),
    ...[...src.matchAll(/import\s*\(\s*["'](node:[^"']+)["']\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/require\s*\(\s*["'](node:[^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];
}

/**
 * The import chain from `entry` to something the browser must not have, or null.
 *
 * Two forbidden destinations, found the same way:
 *
 *  - src/db, which opens a connection at module top level;
 *  - any `node:` builtin, which webpack refuses outright - and which in practice
 *    marks a module that also reads secrets. This half was added after a client
 *    component imported one small arithmetic helper out of lib/msgraph and
 *    dragged node:crypto, the Microsoft client secret and the whole Graph client
 *    into the browser graph with it. The build caught that one; the point of a
 *    test is to catch the next one before a build that takes half a minute.
 */
function forbiddenChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; path: string[] }[] = [{ file: entry, path: [entry] }];
  while (stack.length) {
    const { file, path } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file);
    if (file !== entry && isServerModule(src)) continue;
    const node = nodeImports(src);
    if (node.length) return [...path, node[0]];
    for (const spec of valueImports(src)) {
      if (spec === "@/db" || spec.startsWith("@/db/")) {
        // The schema is only table definitions - importing it costs nothing at
        // runtime. src/db itself opens a connection.
        if (spec === "@/db/schema") continue;
        return [...path, spec];
      }
      const next = resolveAlias(spec);
      if (next && !seen.has(next)) stack.push({ file: next, path: [...path, next] });
    }
  }
  return null;
}

const clientFiles = files.filter((f) => /^\s*["']use client["']/.test(read(f)));

describe("client bundle stays off the database and off node builtins", () => {
  it("finds the client components at all (guards against a broken detector)", () => {
    expect(clientFiles.length).toBeGreaterThan(20);
  });

  it.each(clientFiles.map((f) => [f.replace(`${process.cwd()}/`, ""), f]))(
    "%s reaches neither src/db nor a node: builtin",
    (_label, file) => {
      const chain = forbiddenChain(file);
      const pretty = chain?.map((c) => c.replace(`${process.cwd()}/`, "")).join("\n  -> ");
      expect(chain, `client module reaches something server-only:\n  ${pretty}`).toBeNull();
    },
  );
});
