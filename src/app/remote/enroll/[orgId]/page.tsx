import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { mayEnroll } from "@/lib/remoteAccess";
import { agentDownloads, ensureOrgGroup, NOT_CONFIGURED, remoteConfigured } from "@/lib/remote";
import RemoteInviteLink from "@/components/RemoteInviteLink";

export const dynamic = "force-dynamic";

/**
 * How a machine joins one organization's roster.
 *
 * The engine has a page for this and it is the wrong page to put in front of a
 * client: it wears the engine's name, shows a stock screenshot of somebody else's
 * dialog, and offers tabs for eleven operating systems when an instrument
 * controller runs exactly one. Its download links need no session of their own,
 * though - the group is in the URL and the engine personalizes the binary - so
 * the instructions can be ours and the engine can just serve the file.
 *
 * Staff-only, and audited on open: each of these links is a capability to enroll
 * a machine into this client's roster, which is not something to hand out
 * casually or quietly.
 */
export default async function RemoteEnrollPage({ params }: { params: Promise<{ orgId: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { remote: moduleOn } = await getModules();
  if (!mayEnroll(user, { moduleOn })) redirect("/remote");

  const { orgId } = await params;
  const id = parseInt(orgId);
  if (isNaN(id)) notFound();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, id));
  if (!org) notFound();
  const brand = await getBrand();

  if (!remoteConfigured()) {
    return (
      <div className="container page">
        <h1 style={{ fontSize: 20, marginTop: 0 }}>Enroll a machine</h1>
        <div className="card" style={{ fontSize: 13 }}>{NOT_CONFIGURED}</div>
      </div>
    );
  }

  // Creates the group on first use, or adopts one already carrying this
  // organization's name.
  const group = await ensureOrgGroup(id);
  const downloads = "groupId" in group ? agentDownloads(group.groupId) : [];
  if ("groupId" in group) {
    await audit({
      actor: user.email, entityType: "remote", entityId: id,
      action: `opened enrollment instructions for ${org.name}`,
    });
  }

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Link href="/remote" className="btn sm" style={{ textDecoration: "none" }}>← Machines</Link>
        <h1 style={{ fontSize: 20, margin: 0 }}>Enroll a machine</h1>
        <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{org.name}</span>
      </div>

      {"error" in group && <div className="card" style={{ fontSize: 13, color: "#A32D2D" }}>{group.error}</div>}

      {downloads.length > 0 && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Run it on the machine</div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
              Anything installed from this page joins <b>{org.name}</b>&apos;s machines and nobody else&apos;s.
              Download on the instrument PC itself, or download here and carry it over.
            </div>

            <ol style={{ fontSize: 13, margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              <li>Download the installer below and run it on the PC.</li>
              <li>
                Press <b>Install</b>, not Connect. Install registers a Windows service, so the machine comes back
                on its own after a reboot; Connect lasts only until that window closes.
              </li>
              <li>
                Windows will say the publisher is unrecognized. Choose <b>More info → Run anyway</b>. That warning
                is about the file not being code-signed yet, not about anything being wrong with it.
              </li>
              <li>Close the dialog. The machine appears on the Machines page within a few seconds.</li>
            </ol>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 8 }}>Installers</div>
            {downloads.map((d) => (
              <div key={d.url} style={{
                display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                padding: "8px 0", borderTop: "1px solid var(--line)",
              }}>
                <a href={d.url} className={d.primary ? "btn sm accent" : "btn sm"}
                  style={{ textDecoration: "none", minWidth: 150 }}>{d.label}</a>
                <span className="mut" style={{ fontSize: 11.5 }}>{d.note}</span>
              </div>
            ))}
            <div className="mut" style={{ fontSize: 11, marginTop: 10 }}>
              Each download is built for {org.name} at the moment you click it, so these are not files to keep
              around or forward to another client.
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Or have someone else run it</div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
              A link the client&apos;s own IT can open without a {brand.name} account. It expires in 24 hours and
              carries the same rights as the downloads above, so treat it like a password.
            </div>
            <RemoteInviteLink orgId={id} orgName={org.name} />
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>If the machine is behind a corporate firewall</div>
            <div className="mut" style={{ fontSize: 12 }}>
              The agent only makes outbound connections on 443 and never listens for anything, so it needs no port
              forwarding and no inbound rule. A site that filters by destination needs one entry allowing outbound
              443 to <span className="mono">{(process.env.REMOTE_URL ?? "").replace(/^https?:\/\//, "")}</span>.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
