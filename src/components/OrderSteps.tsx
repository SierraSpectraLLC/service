import type { Step } from "@/lib/clientOrders";

/** The per-shipment step rail: done, current, still to come. Server-safe. */
export default function OrderSteps({ steps }: { steps: Step[] }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", margin: "10px 0 2px" }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ flex: 1, position: "relative", textAlign: "center" }}>
          {i > 0 && (
            <span aria-hidden style={{
              position: "absolute", top: 5, right: "50%", width: "100%", height: 2,
              background: s.state === "todo" ? "var(--line)" : "var(--t-good-fg)",
            }} />
          )}
          <span aria-hidden style={{
            position: "relative", zIndex: 1, display: "inline-block", width: 12, height: 12,
            borderRadius: "50%", boxSizing: "border-box",
            background: s.state === "done" ? "var(--t-good-fg)" : "#fff",
            border: s.state === "done" ? "2px solid var(--t-good-fg)"
              : s.state === "on" ? "2px solid var(--navy)" : "2px solid var(--line)",
            boxShadow: s.state === "on" ? "0 0 0 3px rgba(23,42,74,.15)" : undefined,
          }} />
          <div className={`t-meta ${s.state === "on" ? "" : "mut"}`}
            style={s.state === "on" ? { fontWeight: 700 } : undefined}>
            {s.label}
            {s.sub && <span className="mut" style={{ display: "block", fontWeight: 400 }}>{s.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
