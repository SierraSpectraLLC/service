// The spec sheet, rendered small: shared by the model page's card, the unit
// page's Specs panel and the asset row's fold-out on a system page. Pure
// presentation - no directive, so it stays a server component on server pages
// and rides along in client ones.
import type { Spec } from "@/lib/modelSpecs";

export default function SpecTable({ specs, compact = false }: { specs: Spec[]; compact?: boolean }) {
  if (!specs.length) return null;
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 560 }}>
      <tbody>
        {specs.map((s) => (
          <tr key={s.name}>
            <td className="mut" style={{
              fontSize: compact ? 11 : 12, padding: compact ? "3px 12px 3px 0" : "5px 14px 5px 0",
              borderTop: "1px solid var(--line)", whiteSpace: "nowrap", verticalAlign: "top",
            }}>{s.name}</td>
            <td style={{
              fontSize: compact ? 12 : 13, fontWeight: 600,
              padding: compact ? "3px 0" : "5px 0", borderTop: "1px solid var(--line)",
            }}>{s.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
