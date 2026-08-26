// "View as" cookie format, kept apart from the session plumbing so the parsing
// rules can be tested without dragging auth into the test environment.
//
// Two shapes, and the difference between them is the whole design.
//
// A ROLE persona answers "what does a client editor see" - a shape, not a
// person. It is what the operator has always had, and it stays writable:
// anything changed under it is recorded as the operator, which is what the
// banner over it promises.
//
// A PERSON persona answers "what does BILL see", which is a different and
// harder question, because half of what a person sees is keyed on WHO THEY ARE
// rather than on what they may do: their saved panel layout, the jobs assigned
// to them, their own read state, the per-person flags on their account. A role
// persona reproduces none of that, which is why an engineer's glitch could not
// be reproduced by standing in his organization's shoes.
//
// So a person persona takes their identity outright - and gives up writing in
// exchange. See lib/authz: every action refuses while one is active. That is
// not a limitation to work around, it is the point. Diagnosing somebody's
// screen should not be able to approve a quote in their name, and an operator
// who genuinely needs to act has their own account one click away.
import type { Role } from "@/lib/authz";

export const VIEW_AS_COOKIE = "view_as";

export type Persona =
  | { kind: "role"; orgId: number; role: Extract<Role, "client_editor" | "client_viewer"> }
  | { kind: "person"; email: string };

/**
 * Cookie format: "<orgId>:<editor|viewer>" for a role, "u:<email>" for a
 * person. Anything else yields null.
 *
 * The role form is unchanged, so a cookie set before people existed still
 * parses to exactly what it always did.
 */
export function parsePersona(raw: string | undefined): Persona | null {
  if (!raw) return null;
  const [head, ...rest] = raw.split(":");
  if (head === "u") {
    // An address can hold no colon, so the tail is rejoined rather than [1].
    const email = rest.join(":").trim().toLowerCase();
    return email.includes("@") ? { kind: "person", email } : null;
  }
  const orgId = parseInt(head);
  if (!orgId || isNaN(orgId)) return null;
  return { kind: "role", orgId, role: rest[0] === "viewer" ? "client_viewer" : "client_editor" };
}

/** The cookie value for a persona. The inverse of parsePersona. */
export const personaCookie = (p: Persona): string =>
  p.kind === "person" ? `u:${p.email}` : `${p.orgId}:${p.role === "client_viewer" ? "viewer" : "editor"}`;

/**
 * What a refused write says while a person persona is active.
 *
 * Here rather than in lib/authz so it can be read without dragging the session
 * plumbing along - same reason the parser lives here.
 */
export const SHADOW_REFUSAL =
  "Read-only while viewing as somebody else. Go back to your own account to change anything.";
