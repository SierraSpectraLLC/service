"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { recordLibraryFiles } from "@/app/actions";
import CloudBrowser from "./CloudBrowser";
import { fmtBytes } from "@/lib/storage";
import type { CloudItem } from "@/lib/cloudItems";

/**
 * An outside file store, on the page where files live.
 *
 * This is where the Microsoft connection is made and unmade. It used to live in
 * the PDF studio, which is where somebody first wanted it, but a connection to
 * a company's document store is a filing decision rather than a studio setting:
 * it outlives any one packet, everyone in the shop shares the folders it reaches,
 * and this is the page a person opens when the question is "where are our
 * documents". The studio still browses it - it just no longer owns it.
 *
 * Copying, not linking. A file added here is fetched from Microsoft, stored in
 * this org's own store and charged to its quota, and from then on it is a file
 * this portal holds: it can be filed onto a system, put in a packet, and read
 * years later by somebody with no Microsoft account at all. Pointing at the
 * original instead would make the whole service history depend on a folder
 * somebody else can rename.
 */
export default function CloudLibraryCard({ account, brokenReason, note: handshake = "", full }: {
  account: string;
  brokenReason: string;
  /** What the last Microsoft handshake reported, off the query string. */
  note?: string;
  /** Storage is at the ceiling - taking a copy is exactly what it cannot do. */
  full: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const bring = async (item: CloudItem) => {
    setError(""); setNote(""); setBusy(item.name);
    try {
      // Through this app's own route, never straight from Microsoft: the access
      // token belongs on the server, and this way the browser holds nothing that
      // outlives the tab.
      const q = new URLSearchParams({ item: item.id, drive: item.driveId });
      const res = await fetch(`/api/cloud/file?${q}`);
      if (!res.ok) throw new Error((await res.text()) || `Microsoft would not send ${item.name}`);
      const blob = await res.blob();
      const put = await upload(item.name, blob, { access: "public", handleUploadUrl: "/api/upload" });
      const rec = await recordLibraryFiles([
        { fileName: item.name, url: put.url, size: blob.size, description: "" },
      ]);
      if (rec?.error) throw new Error(rec.error);
      setNote(`${item.name} (${fmtBytes(blob.size)}) filed ✓`);
      router.refresh();
    } catch (e) {
      // Named, not swallowed: a copy that silently did not happen looks exactly
      // like one that did until somebody goes looking for the file.
      setError(`${item.name}: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card">
      {/* The account is not repeated here: the browser prints it below, next to
          the disconnect it belongs with. */}
      <div className="card-title">OneDrive, Teams and SharePoint</div>
      {handshake && (
        <div className="t-small" style={{ marginTop: 6, color: handshake === "connected" ? "var(--t-good-fg)" : "var(--t-bad-fg)" }}>
          {handshake === "connected" ? "Connected ✓" : handshake}
        </div>
      )}
      {busy && <div className="mut t-small" style={{ marginTop: 6 }}>Copying {busy}...</div>}
      {note && <div className="t-small" style={{ marginTop: 6, color: "var(--t-good-fg)", fontWeight: 700 }}>{note}</div>}
      {error && <div className="t-small" style={{ marginTop: 6, color: "var(--t-bad-fg)" }}>{error}</div>}
      {full && account && (
        <div className="t-small" style={{ marginTop: 6, color: "var(--t-bad-fg)" }}>
          Storage is full - remove a file or raise the limit before copying more in.
        </div>
      )}
      <CloudBrowser
        account={account} brokenReason={brokenReason}
        manage pdfOnly={false} addLabel="+ copy in"
        disabled={!!busy || full}
        onAdd={(i) => { void bring(i); }} />
    </div>
  );
}
