import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SHADOW_REFUSAL, parsePersona, personaCookie } from "@/lib/viewAs";

/**
 * The cookie only names a persona - identity comes from the session - but a
 * malformed or hostile value must never resolve to a usable one.
 *
 * Two kinds now, and the difference is not a degree. A ROLE persona is a shape
 * and stays writable, recorded as the operator. A PERSON persona is an
 * identity - the only thing that reaches somebody's saved layout, their
 * assigned work and their read state - and it cannot write at all.
 */

describe("the role persona, unchanged", () => {
  it("reads an org id and permission level", () => {
    expect(parsePersona("5:editor")).toEqual({ kind: "role", orgId: 5, role: "client_editor" });
    expect(parsePersona("5:viewer")).toEqual({ kind: "role", orgId: 5, role: "client_viewer" });
  });

  it("defaults to editor when the level is absent or unknown", () => {
    expect(parsePersona("7")).toEqual({ kind: "role", orgId: 7, role: "client_editor" });
    expect(parsePersona("7:banana")).toEqual({ kind: "role", orgId: 7, role: "client_editor" });
  });

  it("refuses anything that isn't a real org id", () => {
    expect(parsePersona(undefined)).toBeNull();
    expect(parsePersona("")).toBeNull();
    expect(parsePersona("abc:editor")).toBeNull();
    expect(parsePersona("0:editor")).toBeNull();
    expect(parsePersona(":editor")).toBeNull();
  });

  it("never yields a house role, whatever the cookie says", () => {
    for (const raw of ["5:owner", "5:staff", "5:editor", "5:viewer"]) {
      const p = parsePersona(raw);
      expect(p).not.toBeNull();
      expect(["client_editor", "client_viewer"]).toContain((p as { role: string }).role);
    }
  });
});

describe("the person persona", () => {
  it("reads an address", () => {
    expect(parsePersona("u:bill@sierra.test"))
      .toEqual({ kind: "person", email: "bill@sierra.test" });
  });

  it("normalises the way a typed address arrives", () => {
    expect(parsePersona("u:  Bill@Sierra.TEST "))
      .toEqual({ kind: "person", email: "bill@sierra.test" });
  });

  it("refuses anything that is not an address", () => {
    // Otherwise "u:owner" would resolve to a lookup for nobody, and a persona
    // that resolves to nobody is a persona that resolves to everybody.
    expect(parsePersona("u:")).toBeNull();
    expect(parsePersona("u:notanemail")).toBeNull();
    expect(parsePersona("u")).toBeNull();
  });

  it("round-trips, so the writer and the reader cannot drift", () => {
    for (const p of [
      { kind: "person", email: "bill@sierra.test" },
      { kind: "role", orgId: 3, role: "client_viewer" },
      { kind: "role", orgId: 9, role: "client_editor" },
    ] as const) {
      expect(parsePersona(personaCookie(p))).toEqual(p);
    }
  });
});

describe("standing in a person's shoes is read-only", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("takes their identity outright, which a role persona cannot", () => {
    /* Half of what somebody sees is keyed on WHO THEY ARE rather than on what
       they may do: their saved panel layout, the jobs assigned to them, their
       own read state, the per-person flags on their account. A role persona
       reaches none of it, which is why an engineer's glitch could not be
       reproduced by standing in his organization's shoes. */
    const src = read("src/lib/authz.ts");
    const fn = src.slice(src.indexOf("export const currentUser"));
    expect(fn).toMatch(/persona\.kind === "person"/);
    expect(fn).toMatch(/email: persona\.email, name: persona\.name/);
    // And the role persona still keeps the operator's own identity, which is
    // what lets its banner promise writes are recorded as them.
    expect(fn).toMatch(/email: real\.email, name: real\.name/);
  });

  it("refuses every write, on the one funnel each action passes through", () => {
    /* Enforced in requireUser rather than in the write helpers, because forty
       actions guard themselves and each would have needed remembering. */
    const src = read("src/lib/authz.ts");
    const fn = src.slice(src.indexOf("export async function requireUser"), src.indexOf("export async function requireEditor"));
    expect(fn).toMatch(/await refuseShadowWrites\(\)/);
    const guard = src.slice(src.indexOf("async function refuseShadowWrites"));
    // A page render has no next-action header and must keep rendering - the
    // mode would otherwise show a stack trace instead of the screen it exists
    // to reproduce.
    expect(guard).toMatch(/next-action/);
    expect(guard).toMatch(/if \(!isAction\) return;/);
    expect(SHADOW_REFUSAL).toMatch(/read-only/i);
  });

  it("leaves the way out reachable from inside", () => {
    // setViewAs goes through requireRealOwner, which reads the session behind
    // the persona - otherwise the switch would refuse to switch back.
    const src = read("src/app/actions.ts");
    for (const fn of ["setViewAs", "setViewAsPerson", "viewAsPeople"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 300), fn).toMatch(/requireRealOwner\(\)/);
    }
  });

  it("refuses a persona of your own account", () => {
    // A banner over nothing, that would take your own writing away for free.
    const authz = read("src/lib/authz.ts");
    expect(authz).toMatch(/wanted\.email === real\.email\.trim\(\)\.toLowerCase\(\)/);
    const actions = read("src/app/actions.ts");
    expect(actions).toMatch(/That is you - there is nothing to stand in/);
  });

  it("lets a second operator's owner shadow only their own people", () => {
    /* The platform's owner runs the instance and may shadow anybody on it.
       Another company's engineer is not a second operator's to look through. */
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function setViewAsPerson"));
    expect(fn.slice(0, 2200)).toMatch(/if \(!isPlatformStaff\(tenantViewer\(real\)\)\)/);
  });

  it("reads a refused write as a decline, not as a crash", () => {
    /* Their screen still shows their buttons - that IS their screen - so
       pressing one is an easy mistake, and it should not look like a second
       bug stacked on the one being chased. Recognised by message, so every
       action gets the treatment at once. */
    const src = read("src/app/error.tsx");
    expect(src).toMatch(/error\.message === SHADOW_REFUSAL/);
    expect(src).toMatch(/Nothing can be changed from here/);
    // And it is not filed as an error in the trail: a refusal working as
    // designed is not a failure worth chasing next week.
    expect(src).toMatch(/if \(refused\) return;/);
  });

  it("says which kind is active, because the rules differ", () => {
    const bar = read("src/components/ViewAsBar.tsx");
    expect(bar).toMatch(/Their screen, read-only/);
    expect(bar).toMatch(/Anything you change is still recorded as you/);
  });
});
