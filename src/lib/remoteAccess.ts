// Who may reach a lab PC, and whether somebody has to be sitting at it.
//
// Pure on purpose. This module decides real-world capability - taking control of
// a customer's instrument controller - so it is worth being able to argue with
// in a test rather than by clicking a button and hoping.
//
// It replaces "whoever knows the PC's password", which is how this is done today
// with TeamViewer and UltraViewer. That password is the identity: everyone who
// ever needed access still has it, it is probably on a label, nothing is
// revocable without walking to the machine, and no record exists of who
// connected. Every rule below exists to invert one of those.

/** Whether a session needs a human at the far end to say yes. */
export type ConsentMode = "unattended" | "consent";

export type DeviceFacts = {
  /** The organization whose machine this is - stamped when it was enrolled. */
  orgId: number | null;
  /**
   * Staff's explicit answer, overruling the derived one. `null` means "derive
   * it" and is the normal state; `true` forces a prompt, `false` suppresses one.
   */
  consentOverride: boolean | null;
};

/**
 * The system this PC drives, when it is linked to one. `null` when the device
 * stands alone - a bench spare, a machine not yet matched to a record.
 */
export type SystemFacts = {
  /** Who owns the system NOW. Compared against the device's org, below. */
  ownerOrgId: number | null;
  stages: string[];
};

/**
 * Unattended in the warehouse; consent required once the system reaches a
 * customer. The portal already knows the difference, so nobody has to remember
 * to flip a switch:
 *
 *   - `Shipped` on the system means it physically left
 *   - the system's owner no longer matching the org the PC was enrolled under
 *     means it changed hands
 *
 * Deriving it matters more than it sounds. The failure mode of a manual toggle
 * is the sentence you never want to say to an auditor: "we still had silent
 * unattended access to a customer's instrument PC eight months after we sold it
 * to them." Custody moves on a date that is already recorded; access should
 * tighten on the same one.
 *
 * `why` is for the UI - a device showing a padlock should be able to say what
 * put it there.
 */
export function consentModeFor(
  device: DeviceFacts,
  system: SystemFacts | null,
): { mode: ConsentMode; why: string } {
  if (device.consentOverride === true) return { mode: "consent", why: "set by staff" };
  if (device.consentOverride === false) return { mode: "unattended", why: "set by staff" };
  // No linked system means no custody signal either way. An enrolled device is
  // one staff deliberately put there, so the permissive default stands - and the
  // override above is how it gets tightened.
  if (!system) return { mode: "unattended", why: "not linked to a system" };
  if (system.stages.includes("Shipped")) return { mode: "consent", why: "the system has shipped" };
  if ((system.ownerOrgId ?? null) !== device.orgId) {
    return { mode: "consent", why: "the system has changed hands" };
  }
  return { mode: "unattended", why: "the system is still in the shop" };
}

export type Viewer = { role: string; orgId: number | null };

export type Ability = {
  /** The device appears in their list at all. */
  see: boolean;
  /** They may open a session to it. */
  connect: boolean;
  /** They may generate an installer for this organization. */
  enroll: boolean;
  /** They may unlink or delete the device row. */
  unlink: boolean;
  /**
   * Why `connect` is false, in words fit to show someone. Empty when they may
   * connect, or when they cannot even see the device (then there is nothing to
   * explain - the device does not exist as far as they know).
   */
  refusal: string;
};

const DENIED: Ability = { see: false, connect: false, enroll: false, unlink: false, refusal: "" };

const isHouse = (role: string) => role === "owner" || role === "staff";

/**
 * `personaActive` is the owner walking the portal as one of their clients. Such
 * a session may LOOK at the client's remote view - that is the whole point of
 * view-as, and a demo where the button is missing teaches the wrong thing - but
 * it may not connect. Taking control of a customer's PC is a real-world act and
 * belongs to a real identity, not a lens.
 *
 * `orgRemoteEnabled` is the sellable dial: house access is the base product, and
 * a client organization's own editors reaching their own machines is the tier.
 */
export function remoteAbility(
  viewer: Viewer,
  ctx: { moduleOn: boolean; personaActive: boolean },
  device: { orgId: number | null },
  org: { remoteAccessEnabled: boolean },
): Ability {
  if (!ctx.moduleOn) return DENIED;

  if (isHouse(viewer.role)) {
    return {
      see: true, enroll: true, unlink: true,
      connect: !ctx.personaActive,
      refusal: ctx.personaActive ? "Switch back to your own account to connect." : "",
    };
  }

  // A client organization's editors, on their own machines, when the tier is on.
  // Enrollment and removal stay with the house: an installer is a capability to
  // join an organization's device group, and handing that out is our act.
  if (viewer.role === "client_editor" && viewer.orgId !== null && viewer.orgId === device.orgId) {
    if (!org.remoteAccessEnabled) return DENIED;
    return { see: true, connect: true, enroll: false, unlink: false, refusal: "" };
  }

  return DENIED;
}

/**
 * May this person generate an installer for `orgId` at all? Separate from
 * `remoteAbility` because enrollment happens before any device exists, so there
 * is nothing to pass as the device.
 */
export function mayEnroll(viewer: Viewer, ctx: { moduleOn: boolean }): boolean {
  return ctx.moduleOn && isHouse(viewer.role);
}
