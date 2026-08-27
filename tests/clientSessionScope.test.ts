// A client belongs to the operator that services them - and the session has to
// say so, because null is not a neutral value here.
//
// The session callback set operatorOrgId from the house_members row, which a
// client has none of, so every client session carried null. readTenant returns
// that null; forTenant emits no predicate for it; visibleOrgs returns the whole
// orgs table; directoryOrgIds returns every id on its first line. So the value
// that means "platform staff, no restriction" was being handed to the least
// privileged accounts on the instance.
//
// signInIdentity, twenty lines above the callback in the same file, already
// resolved it correctly. Both halves are pinned here so they cannot drift
// apart again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directoryOrgIds } from "@/lib/directory";

const SIERRA = 1, CASCADE = 2, LABZEN = 3, ELLISON = 4;
const ALL = [
  { id: SIERRA, isOperator: true, tenant: SIERRA },
  { id: CASCADE, isOperator: true, tenant: CASCADE },
  { id: LABZEN, isOperator: false, tenant: SIERRA },
  { id: ELLISON, isOperator: false, tenant: CASCADE },
];

describe("a client's directory is their own operator's, not the instance's", () => {
  it("with a tenant, a client sees their own workspace and no other", () => {
    const ids = directoryOrgIds({ orgId: LABZEN, isHouse: false }, ALL, SIERRA);
    expect(ids).not.toContain(CASCADE);
    expect(ids).not.toContain(ELLISON);
  });

  it("null opens the whole instance - which is why a client must never carry it", () => {
    // Pinning the behaviour rather than endorsing it: null legitimately means
    // "no restriction" for platform staff. The bug was ever giving it to a
    // client, and it lived in the session callback rather than here.
    expect(directoryOrgIds({ orgId: LABZEN, isHouse: false }, ALL, null)).toEqual(
      [SIERRA, CASCADE, LABZEN, ELLISON],
    );
  });
});

describe("the session callback and signInIdentity agree", () => {
  // Static, because the callback is inside the Auth.js config and cannot be
  // called without standing up the whole provider. Both lines are short and
  // distinctive; if either is rewritten this fails and asks for a real look.
  const src = readFileSync("src/auth.ts", "utf8");

  it("signInIdentity resolves a client to the operator that services them", () => {
    expect(src).toContain("operatorOrgId: org?.parentOrgId ?? null");
  });

  it("the session callback resolves a client the same way", () => {
    // The staff line above it stays `house?.orgId ?? null`; this is the branch
    // that runs when role is neither owner nor staff.
    expect(src).toMatch(
      /\}\).operatorOrgId = org\?\.parentOrgId \?\? null;/,
    );
  });

  it("the client branch sets it INSIDE the non-staff block", () => {
    // Guards against the fix being hoisted somewhere it would overwrite the
    // staff value with null again.
    const block = src.slice(src.indexOf('if (role !== "owner" && role !== "staff") {'));
    expect(block.slice(0, block.indexOf("\n      }"))).toContain("org?.parentOrgId ?? null");
  });
});
