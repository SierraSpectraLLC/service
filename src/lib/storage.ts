// What an organization's file store holds, and how full it is. Pure: the
// queries live in lib/storeUsage, the UI in components/StorageMeter.
//
// A store is not a folder. An organization's files are:
//
//   - its shelf - documents belonging to no system or unit, uploaded to its own
//     library (attachments.org_id)
//   - the paperwork on every system and unit it OWNS (derived, not stamped)
//
// The second half is why a store grows when a system joins a roster and shrinks
// when it's handed on: the files follow the equipment, because that is what the
// client is actually being given. Nothing is copied or moved when custody
// changes - only the answer to "whose store is this in".
//
// Usage counts DISTINCT STORED FILES, not rows. One library document filed onto
// four units is one file billed once; charging four times for one upload would
// be indefensible, and lib/deleteBlobs already refcounts the same way.

export const MB = 1024 * 1024;

/** 0 means no ceiling - what every org that predates the column was given. */
export const UNLIMITED = 0;

/** Presets for the Settings picker. Plain numbers, so any value stays valid. */
export const STORAGE_TIERS = [
  { mb: 1024, label: "1 GB" },
  { mb: 5120, label: "5 GB (default)" },
  { mb: 25600, label: "25 GB" },
  { mb: 102400, label: "100 GB" },
  { mb: UNLIMITED, label: "No limit" },
] as const;

export type Quota = {
  usedBytes: number;
  /** null when there is no ceiling. */
  limitBytes: number | null;
  /** 0-100, clamped. 0 when unlimited - there is no "portion of infinity". */
  pct: number;
  /** null when unlimited. Never negative: over-quota reads as 0 left. */
  remainingBytes: number | null;
  state: "unlimited" | "ok" | "warn" | "full";
};

/** Warn before the wall, so a 200MB tune file isn't the first sign of trouble. */
const WARN_AT = 0.85;

export function quotaFor(usedBytes: number, limitMb: number): Quota {
  const used = Math.max(0, Math.round(usedBytes));
  if (limitMb <= UNLIMITED) {
    return { usedBytes: used, limitBytes: null, pct: 0, remainingBytes: null, state: "unlimited" };
  }
  const limitBytes = limitMb * MB;
  const pct = Math.min(100, Math.round((used / limitBytes) * 100));
  const remainingBytes = Math.max(0, limitBytes - used);
  return {
    usedBytes: used, limitBytes, pct, remainingBytes,
    state: used >= limitBytes ? "full" : used >= limitBytes * WARN_AT ? "warn" : "ok",
  };
}

/**
 * Can this store take `addBytes` more? Checked before an upload starts, so the
 * refusal costs a round trip instead of a 90MB transfer. An org exactly at its
 * limit is full; one byte over is not a rounding argument worth having.
 */
export function fits(usedBytes: number, addBytes: number, limitMb: number): boolean {
  if (limitMb <= UNLIMITED) return true;
  return usedBytes + Math.max(0, addBytes) <= limitMb * MB;
}

/** "0 B", "812 KB", "3.4 MB", "1.2 GB" - one rule, everywhere it's shown. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

/** "3.4 MB of 5 GB" / "3.4 MB (no limit)" - the meter's one-line summary. */
export function quotaLabel(q: Quota): string {
  return q.limitBytes === null
    ? `${fmtBytes(q.usedBytes)} stored (no limit)`
    : `${fmtBytes(q.usedBytes)} of ${fmtBytes(q.limitBytes)}`;
}

/** The message a refused upload should carry - names the shortfall, not just "no". */
export function overQuotaMessage(storeName: string, q: Quota, addBytes: number): string {
  const over = q.limitBytes === null ? 0 : q.usedBytes + addBytes - q.limitBytes;
  return `${storeName} is out of file storage - ${quotaLabel(q)} used, and this needs ${fmtBytes(addBytes)} more`
    + (over > 0 ? ` (${fmtBytes(over)} over). Remove some files or raise the limit in Settings.` : ".");
}
