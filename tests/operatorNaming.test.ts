// Who the app says is doing the work.
//
// getBrand().operatorName is the company that RUNS the instance.
// brandForTenant(t).operatorName is the company whose record it is. They were
// the same thing while there was one operator, and every page that renders "who
// has your equipment", "who is waiting on you", "our own contract" or "<name>
// board" reached for the first one.
//
// The result, on a workspace opened for somebody else: their dashboard read
// "Sierra Spectra is waiting on you", their Files tab was labelled with that
// company, their internal discussion room was named after it, and their
// contracts offered it as the provider. lib/brand already warned about exactly
// this - "a report about another operator's system carrying our name on it
// would be a false statement about who did the work" - and the sign-off pages
// were the only ones that had listened.
//
// So: a page that renders operatorName must resolve it per-tenant. The public
// surfaces are the deliberate exception - they ARE the instance's own face.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Files where getBrand() feeding operatorName is correct, and why. */
const INSTANCE_FACE: Record<string, string> = {
  "src/app/(dashboard)/page.tsx":
    "Keeps getBrand() for the ANONYMOUS landing branch only - that page is the " +
    "instance's public face and names the company that runs it. The signed-in " +
    "path below it resolves brandForTenant(viewTenant(user)).",
  "src/app/equipment/page.tsx":
    "The public catalog index, served to strangers off the instance's own domain.",
  "src/app/equipment/[slug]/page.tsx":
    "A published model's public page - same reason.",
  "src/app/share/[token]/page.tsx":
    "A share link's public view. The token names one record; the page is served " +
    "by the instance and says so.",
  "src/app/drop/[token]/page.tsx":
    "The anonymous upload door, reached with no session at all.",
  "src/app/layout.tsx":
    "The shell's wordmark and title, which are the PRODUCT's - lib/brand is " +
    "explicit that per-tenant white-labelling of the shell is a deliberate " +
    "step beyond this, not an accident of it.",
  "src/lib/storeUsage.ts":
    "storeLimitMb/storeLabel fall back to the brand only when no tenant is " +
    "resolvable at all - the null path, which is platform staff and an " +
    "instance that never named an operator.",
  "src/lib/eodEmail.ts":
    "Composes per-workspace already: it takes tenantOrgId and filters every row " +
    "set through mine() before naming anybody.",
  "src/lib/pmGenerate.ts":
    "Names the scheduler in generated task text, not a party to the work.",
  "src/app/api/calendar/route.ts":
    "The ICS feed is the instance operator's, scoped to settings.operatorOrgId.",
  "src/app/actions.ts":
    "Mixed file. sendEodEmail's house branch and the public-catalog publish gate " +
    "both genuinely mean the instance's operator; neither renders a party name " +
    "to a tenant's screen.",
};

function filesRenderingOperatorName(): string[] {
  let out: string;
  try {
    out = execFileSync("grep", ["-rl", "--include=*.ts", "--include=*.tsx",
      "operatorName", "src/"], { encoding: "utf8" });
  } catch { return []; }
  return out.split("\n").filter(Boolean)
    // Components receive it as a prop; the page that RESOLVES it is what matters.
    .filter((f) => !f.startsWith("src/components/"))
    // The IMPORT, not the string: every file fixed for this carries a comment
    // naming getBrand() as the thing it stopped doing, and matching on the text
    // would flag exactly the files that were put right.
    .filter((f) => /^\s*import\s*\{[^}]*\bgetBrand\b[^}]*\}\s*from\s*"@\/lib\/brand"/m
      .test(readFileSync(f, "utf8")));
}

describe("a page names the workspace whose record it is", () => {
  it("brandForTenant resolves per tenant and falls back to the instance", async () => {
    // Guards the primitive itself, so the static check below cannot be passing
    // over a function that stopped distinguishing anything.
    const src = readFileSync("src/lib/brand.ts", "utf8");
    expect(src).toContain("export const brandForTenant");
    expect(src).toContain("tenantOrgId === null || tenantOrgId === base.operatorOrgId");
  });

  it("every page resolving operatorName from getBrand() is a public surface", () => {
    const unexplained = filesRenderingOperatorName().filter((f) => !(f in INSTANCE_FACE));
    expect(unexplained).toEqual([]);
  });

  it("the exception list has no stale entries", () => {
    const live = new Set(filesRenderingOperatorName());
    expect(Object.keys(INSTANCE_FACE).filter((f) => !live.has(f))).toEqual([]);
  });
});
