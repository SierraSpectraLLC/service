import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { deviceWithOrg } from "@/lib/remote";
import { deviceLabel, deviceSubLabel } from "@/lib/deviceName";
import { connectRemoteDevice } from "@/app/actions";

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
 * So: our page, our header, their desktop canvas in a frame with their chrome
 * hidden. Everything that decides whether this is allowed still happens in
 * connectRemoteDevice, once, server-side, before the frame has a URL to load.
 *
 * The one page in the app that does NOT use the standard column. Every other
 * page is text and benefits from a measure; this one is a 16:9 desktop, and a
 * 760px column rendered it postage-stamp sized with black bars above and below
 * on a monitor with room for all of it. Here the window is the layout.
 */
export default async function RemoteSessionPage({ params }: { params: Promise<{ id: string }> }) {
  try { await requireUser(); } catch { redirect("/login"); }
  const { remote: moduleOn } = await getModules();
  if (!moduleOn) redirect("/");

  const { id } = await params;
  const deviceId = parseInt(id);
  if (isNaN(deviceId)) notFound();

  const row = await deviceWithOrg(deviceId);
  if (!row) notFound();
  const { device } = row;

  const [system] = device.instrumentId === null ? [] : await db
    .select({ externalId: instruments.externalId }).from(instruments)
    .where(eq(instruments.id, device.instrumentId));

  // Permission, consent, audit and token, in that order. A refusal arrives here
  // as plain English and is shown as plain English - this page never renders an
  // empty frame and leaves somebody guessing.
  const opened = await connectRemoteDevice(deviceId, { embedded: true });

  const label = deviceLabel(device.nickname, device.name);
  const host = deviceSubLabel(device.nickname, device.name);

  return (
    <div className="fill-window" style={{ padding: "12px 16px", maxWidth: 2200, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div className="crumb" style={{ margin: 0 }}>
          <Link href="/remote" style={{ textDecoration: "none", color: "inherit" }}>Remote support</Link> ›
        </div>
        <h1 style={{ fontSize: 18, margin: 0 }}>{label}</h1>
        {host && <span className="mono mut" style={{ fontSize: 11 }}>{host}</span>}
        {row.orgName && (
          <span className="pill info">{row.orgName}</span>
        )}
        {system?.externalId && (
          <Link href={`/instruments/${device.instrumentId}`} className="mut" style={{ fontSize: 12 }}>
            on {system.externalId}
          </Link>
        )}
        {opened.url && (
          <a href={opened.url} target="_blank" rel="noreferrer" className="mut"
            style={{ marginLeft: "auto", fontSize: 11 }}>
            open in a new window
          </a>
        )}
      </div>

      {opened.error && (
        <div className="card" style={{ fontSize: 13, color: "#A32D2D" }}>{opened.error}</div>
      )}

      {opened.url && (
        <iframe
          src={opened.url}
          title={`Remote desktop for ${label}`}
          // Full screen and clipboard are the two the desktop viewer actually
          // asks the browser for; without them a copy-paste into an instrument
          // dialog silently does nothing.
          allow="fullscreen; clipboard-read; clipboard-write"
          // The engine's viewer fits the desktop inside whatever box it is given
          // and letterboxes the rest, so the box wants to be as close to the far
          // machine's own shape as the window allows: the full width, and all the
          // height left over once the header and footer have taken theirs. Taken
          // from the layout rather than subtracted from 100vh, because the header
          // wraps and any constant would be wrong at some window width.
          style={{
            display: "block", width: "100%", flex: "1 1 auto", minHeight: 420,
            border: "1px solid var(--line)", borderRadius: 6, background: "#101418",
          }}
        />
      )}
    </div>
  );
}
