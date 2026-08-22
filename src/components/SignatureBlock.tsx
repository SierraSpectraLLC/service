import type { SignatureRow } from "@/components/SignoffPanel";

/**
 * The signature area of a printed sign-off packet. Each recorded signature
 * prints as a signed line - name, title, account, timestamp and meaning - so
 * the paper says who released the instrument and on what basis. The client's
 * line stays blank: their acceptance is theirs to give, in ink or in their own
 * portal session, not something the operator can fill in for them.
 */
export default function SignatureBlock({ signatures, operatorName, clientName }: {
  signatures: SignatureRow[];
  operatorName: string;
  clientName: string;
}) {
  return (
    <div style={{ marginTop: 32, breakInside: "avoid" }}>
      <div className="eyebrow" style={{ margin: "0 0 8px" }}>Signatures</div>

      {signatures.map((s) => (
        <div key={s.id} style={{ marginBottom: 16, breakInside: "avoid" }}>
          {/* The name in script over a rule reads as a signature on paper. */}
          <div style={{
            fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontStyle: "italic",
            color: "var(--navy)", borderBottom: "1px solid var(--ink)", paddingBottom: 2,
          }}>
            {s.signerName}
          </div>
          <div className="row-2 t-meta" style={{ marginTop: 4 }}>
            <b>{operatorName}</b>
            {s.signerTitle && <span>{s.signerTitle}</span>}
            <span className="mono">{s.signedBy}</span>
            <span style={{ marginLeft: "auto" }}>{s.when}</span>
          </div>
          <div className="t-meta" style={{ marginTop: 2 }}>
            {s.meaning} - {s.snapshot.tasksDone} of {s.snapshot.tasksTotal} tasks complete
            {s.snapshot.requiredTests.length > 0 && (
              <>, mandatory tests evidenced: {s.snapshot.requiredTests.map((t) => t.title).join(", ")}</>
            )}
          </div>
          {s.note && <div className="t-meta" style={{ marginTop: 2, fontStyle: "italic" }}>{s.note}</div>}
          {s.stale && (
            <div style={{ fontSize: 10, marginTop: 2, color: "var(--t-warn-fg)" }}>
              Record amended after signing; this signature covers the packet as it stood on {s.when}.
            </div>
          )}
        </div>
      ))}

      {signatures.length === 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ borderBottom: "1px solid var(--ink)", height: 36 }} />
          <div style={{ fontSize: 11, marginTop: 4 }}>{operatorName} - signature / date</div>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <div style={{ borderBottom: "1px solid var(--ink)", height: 36 }} />
        <div style={{ fontSize: 11, marginTop: 4 }}>{clientName} - accepted by / date</div>
      </div>
    </div>
  );
}
