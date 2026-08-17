// Which module a support unit serves.
//
// A roughing pump, a chiller, an N2 generator: each is a serviceable unit in
// its own right - own serial, own procedures, own failures - that belongs to
// one module rather than to the stack at large. assets.serves_asset_id says
// which. It is a POINTER, not a parent, and the difference is the whole design:
//
//   - Nothing is nested. The pump stays a first-class asset on the system, so
//     every list, count, permission check and move keeps working untouched.
//   - Depth is one, always. A thing that serves cannot itself be served, which
//     is what stops a tree appearing the first time somebody points two units
//     at each other.
//   - Many may serve one. A triple-quad has a fore-line pump and an interface
//     pump; a hierarchy could express that only by making the pumps siblings
//     under a parent, which is the relationship reversed.
//
// Pure. The actions hand in rows and act on the answers, so the same rules hold
// on the server and in the picker.

export type ServeLike = {
  id: number;
  instrumentId: number | null;
  servesAssetId: number | null;
};

/** Everything pointing at this module, in the order the rows came in. */
export function serversOf<T extends ServeLike>(assetId: number, all: T[]): T[] {
  return all.filter((a) => a.servesAssetId === assetId);
}

/** True when anything points at this unit - i.e. it is the served end. */
export const isServed = (assetId: number, all: ServeLike[]): boolean =>
  all.some((a) => a.servesAssetId === assetId);

/**
 * The modules this unit may be pointed at.
 *
 * On the same system, not itself, and not something that is itself serving
 * another module. The last clause is what keeps depth at one: a pump serves the
 * mass spec, and nothing serves the pump.
 */
export function serveCandidates<T extends ServeLike>(self: ServeLike, all: T[]): T[] {
  if (self.instrumentId === null) return [];
  return all.filter((a) =>
    a.id !== self.id
    && a.instrumentId === self.instrumentId
    && a.servesAssetId === null);
}

/**
 * May this unit be pointed at that one, and if not, why not in a sentence
 * somebody can act on.
 *
 * `null` target always passes - clearing a link is never wrong, and a refusal
 * would leave somebody stuck with a link they can see is nonsense.
 */
export function checkServes(
  self: ServeLike, targetId: number | null, all: ServeLike[],
): { ok: true; servesAssetId: number | null } | { ok: false; error: string } {
  if (targetId === null) return { ok: true, servesAssetId: null };
  if (targetId === self.id) return { ok: false, error: "A unit can't serve itself." };
  const target = all.find((a) => a.id === targetId);
  if (!target) return { ok: false, error: "That module isn't on this system." };
  if (self.instrumentId === null) {
    return { ok: false, error: "Install this unit on a system first - what it serves is a fact about a system." };
  }
  if (target.instrumentId !== self.instrumentId) {
    return { ok: false, error: "It can only serve a module on the same system." };
  }
  // One level, both ways. Stated as two refusals rather than one, because the
  // two mean genuinely different things to the person reading them.
  if (target.servesAssetId !== null) {
    return { ok: false, error: "That module already serves something else - a support unit can't have one of its own." };
  }
  if (isServed(self.id, all)) {
    return { ok: false, error: "Something already serves this unit, so it can't also serve a module." };
  }
  return { ok: true, servesAssetId: targetId };
}

/**
 * What a move or a detach does to the links around a unit.
 *
 * A serves link never crosses a system, so leaving one breaks every link at
 * both ends - EXCEPT the servers being brought along, which is the whole point
 * of offering to bring them. `bringing` is filtered against who actually serves
 * this unit, so a stale id from the browser can't drag an unrelated asset.
 */
export function moveFallout(
  assetId: number, all: ServeLike[], bringing: number[] = [],
): {
  /** Servers that travel with it and keep their link. */
  bring: number[];
  /** Servers left behind, whose link has to be cleared. */
  orphan: number[];
  /** True when the unit itself was serving something it is now leaving. */
  clearOwn: boolean;
} {
  const servers = serversOf(assetId, all).map((a) => a.id);
  const wanted = new Set(bringing);
  const self = all.find((a) => a.id === assetId);
  return {
    bring: servers.filter((id) => wanted.has(id)),
    orphan: servers.filter((id) => !wanted.has(id)),
    clearOwn: !!self && self.servesAssetId !== null,
  };
}

/** "fore-line", trimmed and bounded. Blank is the ordinary case. */
export const cleanRole = (role: string): string => role.trim().slice(0, 40);

/**
 * How one unit is named in a list of its stack-mates.
 *
 * The serial is in there because a system with two identical mass specs is
 * ordinary, and picking which one a pump serves out of two options reading
 * "Mass Spec · Thermo Altis" is picking at random.
 */
export function unitLabel(a: { kind: string; model: string; serial: string }): string {
  return [a.kind, a.model, a.serial && `SN ${a.serial}`].filter(Boolean).join(" · ") || "Unit";
}

/**
 * How a served module reads its supporting units, e.g.
 * "2 roughing pumps: nXDS15i (fore-line), nXDS15i (interface)".
 */
export function servesLine(
  servers: { kind: string; model: string; serial: string; servesRole: string }[],
): string {
  return servers
    .map((s) => {
      const name = s.model || s.serial || s.kind;
      return s.servesRole ? `${name} (${s.servesRole})` : name;
    })
    .join(", ");
}
