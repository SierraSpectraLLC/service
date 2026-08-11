import { quotaLabel, type Quota } from "@/lib/storage";

const BAR: Record<Quota["state"], string> = {
  unlimited: "#94A3B8",
  ok: "#2E6B2E",
  warn: "#8A5410",
  full: "#A32D2D",
};

/**
 * How full a file store is. Server component - a bar and a sentence, no state.
 *
 * Shown even when there is no ceiling, because "how much are we holding" is
 * worth knowing before anyone is charged for it, and because a meter that
 * appears only once a limit is set would make the limit look like the problem.
 */
export default function StorageMeter({ quota, name, hint }: {
  quota: Quota & { storeName?: string };
  /** Whose store this is, for the heading. */
  name?: string;
  hint?: string;
}) {
  const label = quotaLabel(quota);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
        <span className="eyebrow">{name ? `${name} · file storage` : "File storage"}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: quota.state === "ok" || quota.state === "unlimited" ? "var(--ink)" : BAR[quota.state] }}>
          {label}
        </span>
        {quota.state === "warn" && <span style={{ fontSize: 11, color: BAR.warn }}>running low</span>}
        {quota.state === "full" && <span style={{ fontSize: 11, color: BAR.full, fontWeight: 700 }}>full - uploads are blocked</span>}
      </div>
      {quota.limitBytes !== null && (
        <div style={{ height: 6, borderRadius: 999, background: "#E2E8F0", overflow: "hidden" }}
          role="img" aria-label={`${quota.pct}% of file storage used`}>
          <div style={{ width: `${Math.max(quota.pct, quota.usedBytes > 0 ? 2 : 0)}%`, height: "100%", background: BAR[quota.state] }} />
        </div>
      )}
      {hint && <div className="mut" style={{ fontSize: 11, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}
