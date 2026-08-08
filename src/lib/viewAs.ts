// "View as" cookie format, kept apart from the session plumbing so the parsing
// rules can be tested without dragging auth into the test environment.
//
// The cookie only names a persona - never an identity - and is honored only
// when the real session belongs to the platform owner (see lib/authz). A
// malformed or hostile value must therefore degrade to "no persona", and the
// level can only ever be one of the two client roles.
import type { Role } from "@/lib/authz";

export const VIEW_AS_COOKIE = "view_as";

export type Persona = { orgId: number; role: Extract<Role, "client_editor" | "client_viewer"> };

/** Cookie format: "<orgId>:<editor|viewer>". Anything else yields null. */
export function parsePersona(raw: string | undefined): Persona | null {
  if (!raw) return null;
  const [id, mode] = raw.split(":");
  const orgId = parseInt(id);
  if (!orgId || isNaN(orgId)) return null;
  return { orgId, role: mode === "viewer" ? "client_viewer" : "client_editor" };
}
