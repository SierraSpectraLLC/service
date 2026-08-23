// The hold has to REFUSE something, not decorate a banner.
//
// This is a source scan, in the style of tests/tenantStamp.test.ts, and for the
// same reason: the failure it catches compiles, typechecks and renders
// perfectly. Every surface showed "On hold", the owner override demanded a
// written reason and wrote an audited row - and not one line of that was read
// by any code that could refuse anything. The engineer still got assigned and
// still drove.
//
// So the test is not "does the rule return the right string" (tests/credit.ts
// covers that) but "is the rule actually consulted at the moments that commit
// somebody to a drive".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_ACTIONS } from "@/lib/credit";

const src = readFileSync(join(process.cwd(), "src/app/actions.ts"), "utf8");

/** The body of one exported action, from its signature to the next export. */
function body(fn: string): string {
  const at = src.indexOf(`export async function ${fn}(`);
  if (at < 0) throw new Error(`no action named ${fn}`);
  const rest = src.slice(at + fn.length);
  const end = rest.search(/\nexport (async )?function |\nexport const /);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The three moments a person or a day gets committed:
 *
 *   openWorkOrder    filing a job WITH somebody already on it
 *   updateWorkOrder  putting a name on a job that had none
 *   setWorkOrderState moving it into work
 */
const COMMIT_POINTS = ["openWorkOrder", "updateWorkOrder", "setWorkOrderState"];

describe("the credit hold is enforced where the drive is committed", () => {
  for (const fn of COMMIT_POINTS) {
    it(`${fn} consults the hold`, () => {
      expect(body(fn)).toContain("creditRefusal(");
    });

    it(`${fn} returns the refusal rather than logging it`, () => {
      // A guard whose answer is computed and then dropped is the same bug in a
      // more convincing costume.
      const b = body(fn);
      const calls = [...b.matchAll(/const (\w+) = await creditRefusal\([^)]*\);/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const name of calls) {
        expect(b).toMatch(new RegExp(`if \\(${name}\\) return \\{ error: ${name} \\};`));
      }
    });
  }

  it("the guard itself reads the standing and the rule", () => {
    const at = src.indexOf("async function creditRefusal(");
    expect(at).toBeGreaterThan(-1);
    const head = src.slice(at, src.indexOf("\n}", at));
    expect(head).toContain("creditFor(");
    expect(head).toContain("holdRefusal(");
    // A lookup that throws must not become the reason a down instrument goes
    // unattended: the guard degrades to allowing the work.
    expect(head).toContain(".catch(() => null)");
  });

  it("does not refuse anything else on a held account", () => {
    // Filing without a name, resolving and closing all stay open. Blocking
    // them would corrupt the record rather than protect the money.
    for (const fn of ["resolveWorkOrder", "deleteWorkOrder", "addWorkOrderNote", "logTime", "logExpense"]) {
      expect(body(fn)).not.toContain("creditRefusal(");
    }
  });

  it("gates on the CHANGE, so a held job stays editable", () => {
    // Renaming an order that already has somebody on it must not be refused -
    // only newly committing a person is.
    expect(body("updateWorkOrder")).toContain('next.assignee && next.assignee !== wo.assignee');
    expect(body("setWorkOrderState")).toContain('move.next === "active" && wo.state !== "active"');
  });

  it("covers every action the rule knows about", () => {
    for (const action of HELD_ACTIONS) {
      expect(src).toContain(`creditRefusal(`);
      expect(src).toMatch(new RegExp(`creditRefusal\\([^)]*"${action}"\\)`));
    }
  });
});
