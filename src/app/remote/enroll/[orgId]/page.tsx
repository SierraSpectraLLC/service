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
import { agentBranding, agentDownloads, ensureOrgGroup, NOT_CONFIGURED, remoteConfigured } from "@/lib/remote";
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
        <div className="card t-body">{NOT_CONFIGURED}</div>
      </div>
    );
  }

  // Creates the group on first use, or adopts one already carrying this
  // organization's name.
  const group = await ensureOrgGroup(id);
  const downloads = "groupId" in group ? agentDownloads(group.groupId) : [];
  // What the client will actually see on their desktop. Asked of the host rather
  // than assumed, because the branding lives there and nothing here can set it.
  const branding = downloads.length ? await agentBranding() : null;
  if ("groupId" in group) {
    await audit({
      actor: user.email, entityType: "remote", entityId: id,
      action: `opened enrollment instructions for ${org.name}`,
    });
  }

  return (
    <div className="container page">
      <div className="crumb">
        Operations › <Link href="/remote" style={{ textDecoration: "none", color: "inherit" }}>Remote support</Link> › <b>Enroll a machine</b>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Enroll a machine</h1>
        <span className="pill info">{org.name}</span>
      </div>

      {"error" in group && <div className="card t-body" style={{ color: "var(--t-bad-fg)" }}>{group.error}</div>}

      {downloads.length > 0 && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Install on the machine</div>
            <div className="mut t-small" style={{ marginBottom: 14 }}>
              Anything installed from this page joins <b>{org.name}</b>&apos;s machines and nobody else&apos;s.
            </div>

            <ol style={{ fontSize: 13.5, margin: "0 0 12px", paddingLeft: 20, lineHeight: 1.7 }}>
              <li>Download below and run it on the PC.</li>
              <li>Press <b>Install</b>, not Connect - Connect lasts only until the window closes.</li>
              <li>At the publisher warning, choose <b>More info → Run anyway</b>.</li>
            </ol>

            {/* Windows stops this installer three different ways and they look
                alike, so all three are here. The real fix is a signing
                certificate; until then this is the whole of the friction, and
                somebody standing at a lab PC should not have to guess it. */}
            <details style={{ fontSize: 12.5, marginBottom: 16 }}>
              <summary style={{ cursor: "pointer", color: "var(--t-info-fg)" }}>
                Windows blocked it and offered no way through
              </summary>
              <div className="mut" style={{ marginTop: 8, lineHeight: 1.65 }}>
                The installer is unsigned, so it has no reputation with Microsoft. Three separate things stop it and
                they look almost identical:
                <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                  <li>
                    <b>The browser refused the download</b> - Edge or Chrome says it is not commonly downloaded.
                    Open the downloads list, find the file, and choose <b>Keep</b> (Chrome:{" "}
                    <b>⌄ → Keep</b>; Edge: <b>… → Keep → Show more → Keep anyway</b>).
                  </li>
                  <li>
                    <b>The file arrived but will not start</b> - right-click it → <b>Properties</b> → tick{" "}
                    <b>Unblock</b> at the bottom → <b>OK</b>, then run it again.
                  </li>
                  <li>
                    <b>&quot;Windows protected your PC&quot; with no Run anyway</b> - that button is hidden behind{" "}
                    <b>More info</b>. If it genuinely is not there, SmartScreen is set to block without a bypass by
                    policy, and only the site&apos;s own IT can allow it: they can add the file to their allow list, or
                    install it from an elevated PowerShell.
                  </li>
                </ul>
                A renamed installer starts from zero reputation again, so this comes back for a while after the
                support host is rebranded. Code signing is what removes it for good.
              </div>
            </details>

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

            {/* Not decoration: this is the one place the borrowed branding is
                catchable before a client's IT sees it on their own desktop. */}
            {branding && !branding.branded && (
              <div className="t-small" style={{ background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 10px", marginTop: 12 }}>
                <b style={{ color: "var(--t-warn-fg)" }}>The support host has no agent branding set.</b>{" "}
                This downloads as <span className="mono">{branding.fileName}</span>, and installs a window and a
                Windows service under the engine&apos;s name rather than {brand.operatorName || brand.name}&apos;s.
                Fix it on the host - <span className="mono">agentCustomization</span> in{" "}
                <span className="mono">meshcentral-data/config.json</span>, §13 of the remote host setup - then
                restart it. Agents already installed keep the old name until they are reinstalled.
              </div>
            )}
            {branding?.branded && (
              <div className="mut t-meta" style={{ marginTop: 12 }}>
                Downloads under your own name - the host is serving{" "}
                <span className="mono">{branding.fileName}</span>.
              </div>
            )}

            <div className="mut t-meta" style={{ marginTop: 12 }}>
              Outbound 443 only, nothing listening - a site that filters by destination needs one entry for{" "}
              <span className="mono">{(process.env.REMOTE_URL ?? "").replace(/^https?:\/\//, "")}</span>.
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 4 }}>Send it to someone else</div>
            <div className="mut t-small" style={{ marginBottom: 10 }}>
              For a client&apos;s own IT, with no {brand.name} account. Expires in 24 hours and carries the same
              rights as the downloads above.
            </div>
            <RemoteInviteLink orgId={id} orgName={org.name} />
          </div>
        </>
      )}
    </div>
  );
}
