import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { getModules } from "@/lib/flags";
import { deviceWithOrg } from "@/lib/remote";
import { deviceLabel, deviceSubLabel } from "@/lib/deviceName";
import { connectRemoteDevice } from "@/app/actions";
import RemoteDesktop from "@/components/RemoteDesktop";
import RemoteFrame from "@/components/RemoteFrame";

export const dynamic = "force-dynamic";

/**
 * One session, inside the portal.
 *
 * The engine's own console used to be the destination, which meant pressing
 * Connect threw you out of the product and into somebody else's UI wearing
 * somebody else's name. The session itself still runs browser-to-relay - that
 * cannot change and shouldn't, since it is what keeps this off our serverless
 * functions - but there is no reason the person has to look at the relay's
 * furniture to use it.
 *
 * So: our page, our header, and the desktop drawn on our own canvas by
 * RemoteDesktop, which is what makes it usable from a phone - pinch, pan, tap
 * and the phone's own keyboard. `?classic=1` still shows the engine's console in
 * a frame, for the day the newer path misbehaves in front of a customer.
 * Everything that decides whether this is allowed still happens in
 * connectRemoteDevice, once, server-side, before either has anything to load.
 *
 * The one page in the app that does NOT use the standard column. Every other
 * page is text and benefits from a measure; this one is a 16:9 desktop, and a
 * 760px column rendered it postage-stamp sized with black bars above and below
 * on a monitor with room for all of it. Here the window is the layout.
 */
export default async function RemoteSessionPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ classic?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { remote: moduleOn } = await getModules();
  if (!moduleOn) redirect("/");

  const { id } = await params;
  const deviceId = parseInt(id);
  if (isNaN(deviceId)) notFound();

  // Scoped in the lookup itself - see deviceWithOrg. The refusal further down
  // stops the CONNECTION, not the page: the machine's nickname, hostname,
  // client and system render either way, and device ids are sequential, so a
  // signed-in user of any workspace could otherwise walk them and read another
  // company's lab estate off the headings.
  const row = await deviceWithOrg(deviceId, readTenant(user));
  if (!row) notFound();
  const { device } = row;

  const [system] = device.instrumentId === null ? [] : await db
    .select({ externalId: instruments.externalId }).from(instruments)
    .where(eq(instruments.id, device.instrumentId));

  // Permission, consent, audit and token, in that order. A refusal arrives here
  // as plain English and is shown as plain English - this page never renders an
  // empty frame and leaves somebody guessing.
  const classic = (await searchParams).classic === "1";
  const opened = await connectRemoteDevice(deviceId, { embedded: true, viewer: !classic });

  const label = deviceLabel(device.nickname, device.name);
  const host = deviceSubLabel(device.nickname, device.name);

  return (
    <div className="fill-window" style={{ padding: "12px 16px", maxWidth: 2200, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div className="crumb" style={{ margin: 0 }}>
          <Link href="/remote" style={{ textDecoration: "none", color: "inherit" }}>Remote support</Link> ›
        </div>
        <h1 style={{ fontSize: 19, margin: 0 }}>{label}</h1>
        {host && <span className="mono mut t-meta">{host}</span>}
        {row.orgName && (
          <span className="pill info">{row.orgName}</span>
        )}
        {system?.externalId && (
          <Link href={`/instruments/${device.instrumentId}`} className="mut t-small">
            on {system.externalId}
          </Link>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "baseline" }}>
          {!opened.error && (
            <Link href={opened.viewer ? `/remote/${deviceId}?classic=1` : `/remote/${deviceId}`} className="mut t-meta">
              {opened.viewer ? "classic view" : "new viewer"}
            </Link>
          )}
          {/* The console link carries a login token for the engine itself,
              good for its whole window and more than a session needs. The
              viewer's page holds only its single-use relay cookie, so the link
              lives with the classic view. */}
          {!opened.viewer && opened.url && (
            <a href={opened.url} target="_blank" rel="noreferrer" className="mut t-meta">
              open in a new window
            </a>
          )}
        </span>
      </div>

      {opened.error && (
        <div className="card t-body" style={{ color: "var(--t-bad-fg)" }}>{opened.error}</div>
      )}

      {opened.viewer && <RemoteDesktop deviceId={deviceId} creds={opened.viewer} machineName={label} />}
      {!opened.viewer && opened.url && <RemoteFrame src={opened.url} title={`Remote desktop for ${label}`} />}
    </div>
  );
}
