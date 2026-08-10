export default function Loading() {
  return (
    <div className="container page">
      <div className="metric-grid" style={{ marginBottom: 14 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="skeleton" style={{ width: "70%", height: 12 }} />
            <div className="skeleton" style={{ width: 34, height: 26, marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="skeleton" style={{ height: 30, width: "60%", marginBottom: 12, borderRadius: 999 }} />
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ padding: "13px 14px", borderBottom: "1px solid var(--line)" }}>
            <div className="skeleton" style={{ width: `${85 - i * 6}%`, height: 13 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
