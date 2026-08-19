// The dashboard's own skeleton - a metric grid and a list, because that is
// what this page is.
//
// It lives in the (dashboard) route group rather than at the app root, and the
// reason is not cosmetic: a loading.tsx at the root opens a Suspense boundary
// around EVERY route, so the shell (and a 200) flushes before any page can
// call notFound() - which turned every missing URL into a "soft 404", a page
// that says 404 while answering 200. The public equipment pages exist to be
// crawled, so that status has to be true. Keeping the skeleton scoped to the
// page it was drawn for fixes both.
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
