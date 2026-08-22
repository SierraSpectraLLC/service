import { quotaLabel, type Quota } from "@/lib/storage";

const BAR: Record<Quota["state"], string> = {
  unlimited: "var(--t-faint-fg)",
  ok: "var(--t-good-fg)",
  warn: "var(--t-warn-fg)",
  full: "var(--t-bad-fg)",
};

/**
 * How full a file store is. Server component - a bar and a sentence, no state.
 *
 * Shown even when there is no ceiling, because "how much are we holding" is
 * worth knowing before anyone is charged for it, and because a meter that
 * appears only once a limit is set would make the limit look like the problem.
 */
export default function StorageMeter({ quota, name, hint, compact = false }: {
  quota: Quota & { storeName?: string };
  /** Whose store this is, for the heading. */
  name?: string;
  hint?: string;
  /**
   * One line in a header rather than a card of its own. A file store that
   * opens on a gauge reads as a dashboard, and how full it is is rarely the
   * question somebody came to the page with.
   */
  compact?: boolean;
}) {
  const label = quotaLabel(quota);
  if (compact) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        title={`${label} used${name ? ` of ${name}'s storage` : ""}`}>
        {quota.limitBytes !== null && (
          <span style={{ width: 44, height: 5, borderRadius: 999, background: "var(--t-neutral-bg)", overflow: "hidden", display: "inline-block" }}
            role="img" aria-label={`${quota.pct}% of file storage used`}>
            <span style={{ display: "block", width: `${Math.max(quota.pct, quota.usedBytes > 0 ? 3 : 0)}%`, height: "100%", background: BAR[quota.state] }} />
          </span>
        )}
        <span className="mut t-small" style={{ color: quota.state === "ok" || quota.state === "unlimited" ? undefined : BAR[quota.state] }}>
          {label}{quota.state === "full" ? " · full" : quota.state === "warn" ? " · low" : ""}
        </span>
      </span>
    );
  }
  return (
    <div>
      <div className="row-2" style={{ alignItems: "baseline", marginBottom: 5 }}>
        <span className="eyebrow">{name ? `${name} · file storage` : "File storage"}</span>
        <span className="t-small" style={{ fontWeight: 700, color: quota.state === "ok" || quota.state === "unlimited" ? "var(--ink)" : BAR[quota.state] }}>
          {label}
        </span>
        {quota.state === "warn" && <span className="t-meta" style={{ color: BAR.warn }}>running low</span>}
        {quota.state === "full" && <span className="t-meta" style={{ color: BAR.full, fontWeight: 700 }}>full - uploads are blocked</span>}
      </div>
      {quota.limitBytes !== null && (
        <div style={{ height: 6, borderRadius: 999, background: "var(--t-neutral-bg)", overflow: "hidden" }}
          role="img" aria-label={`${quota.pct}% of file storage used`}>
          <div style={{ width: `${Math.max(quota.pct, quota.usedBytes > 0 ? 2 : 0)}%`, height: "100%", background: BAR[quota.state] }} />
        </div>
      )}
      {hint && <div className="mut t-meta" style={{ marginTop: 5 }}>{hint}</div>}
    </div>
  );
}
