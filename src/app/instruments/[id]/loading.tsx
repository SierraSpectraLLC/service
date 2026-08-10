export default function Loading() {
  return (
    <div className="container page">
      <div className="skeleton" style={{ width: 110, height: 13, marginBottom: 12 }} />
      <div className="card">
        <div className="skeleton" style={{ width: 180, height: 12 }} />
        <div className="skeleton" style={{ width: "55%", height: 18, marginTop: 8 }} />
        <div className="skeleton" style={{ width: "80%", height: 13, marginTop: 10 }} />
        <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ width: 74, height: 20, borderRadius: 999 }} />
          ))}
        </div>
      </div>
      {["Parts", "Attachments", "Tasks", "Activity"].map((t) => (
        <div key={t} className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>{t}</div>
          <div className="skeleton" style={{ width: "65%", height: 13 }} />
        </div>
      ))}
    </div>
  );
}
