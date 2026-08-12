import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { deviceWithOrg } from "@/lib/remote";
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

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <Link href="/remote" className="btn sm" style={{ textDecoration: "none" }}>← Machines</Link>
        <h1 style={{ fontSize: 20, margin: 0 }}>{device.name || "Remote session"}</h1>
        {row.orgName && (
          <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{row.orgName}</span>
        )}
        {system?.externalId && (
          <Link href={`/systems/${device.instrumentId}`} className="mut" style={{ fontSize: 12 }}>
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
          title={`Remote desktop for ${device.name || "this machine"}`}
          // Full screen and clipboard are the two the desktop viewer actually
          // asks the browser for; without them a copy-paste into an instrument
          // dialog silently does nothing.
          allow="fullscreen; clipboard-read; clipboard-write"
          style={{
            display: "block", width: "100%", height: "max(420px, calc(100vh - 190px))",
            border: "1px solid var(--line)", borderRadius: 6, background: "#101418",
          }}
        />
      )}
    </div>
  );
}
