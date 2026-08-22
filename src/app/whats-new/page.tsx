import { redirect } from "next/navigation";
import { currentUser } from "@/lib/authz";
import { WHATS_NEW, audienceAllows } from "@/lib/whatsNew";

export const dynamic = "force-dynamic";

const mdY = (iso: string) => {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x));
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

/**
 * The changelog as a page: everything the overlay ever showed, re-readable.
 * The overlay appears once and is gone for good - which is right for an
 * announcement and wrong for a reference, so this is the reference.
 */
export default async function WhatsNewPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const entries = WHATS_NEW.filter((e) => audienceAllows(e.audience, user.role));

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="crumb"><b>What&apos;s new</b></div>
      <div className="page-head">
        <h1 className="page-title">What&apos;s new in Baseline</h1>
      </div>
      {entries.map((e) => (
        <div key={e.key} className="card" style={{ overflow: "hidden", padding: 0 }}>
          {e.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.image} alt="" style={{ width: "100%", display: "block", borderBottom: "1px solid var(--line)" }} />
          )}
          <div style={{ padding: "14px 18px" }}>
            <div className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{mdY(e.date)}</div>
            <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--navy)", marginBottom: 6 }}>{e.title}</div>
            <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>{e.body}</p>
            {e.href && <a href={e.href} className="btn link" style={{ fontSize: 12, paddingLeft: 0 }}>Take a look →</a>}
          </div>
        </div>
      ))}
      {entries.length === 0 && <div className="mut" style={{ fontSize: 13 }}>Nothing yet.</div>}
    </div>
  );
}
