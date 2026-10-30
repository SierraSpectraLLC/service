"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openRemoteTunnel, recordRemoteFileTransfer, recordRemoteFolder, remoteRelayCredential } from "@/app/actions";
import { loadEngine, RELAY_SAYS, type MeshModule, type MeshRedirect } from "@/components/meshEngine";
import {
  checkFolderName, childPath, crumbs, downloadBlock, encodeCommand, formatSize, parentPath, parseCommand, parseListing,
  safeUploadName, UPLOAD_BLOCK, UPLOAD_PRIMING, uploadFrame, type Flavor, type RemoteEntry,
} from "@/lib/remoteFiles";

/**
 * The far machine's files, beside its desktop: browse, copy a file down to
 * this device, send one up from it.
 *
 * Bill asked for it because he couldn't find it and opened UltraViewer to
 * move a data file instead - which is how a shop's engineers drift to a
 * competitor's tool, one small missing thing at a time. So it sits on the
 * viewer's toolbar, not under a menu.
 *
 * Its own relay session (the engine's files protocol, beside the desktop's),
 * set up the same way the desktop's is: a credential minted on the server,
 * the tunnel asked for by the server, both behind the same gate. Every file
 * that moves is written down first (recordRemoteFileTransfer) and does not
 * move if that refuses. The protocol itself is lib/remoteFiles.
 *
 * One transfer at a time, the rest queued - the agent serves one download per
 * session, and a queue makes "copy these five" a single gesture anyway.
 */

type Transfer = {
  key: number;
  direction: "download" | "upload";
  name: string;
  /** Where on the far machine: the file for a download, the folder for an upload. */
  remote: string;
  size: number;
  moved: number;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  error?: string;
  file?: File;
};

/** The download or upload in flight, as the protocol needs to track it. */
type Live =
  | { kind: "download"; key: number; id: number; chunks: Uint8Array[]; got: number }
  | { kind: "upload"; key: number; reqid: number; file: File; sent: number; reading: boolean; finished: boolean };

const isFolder = (e: RemoteEntry) => e.kind !== "file";

function saveBlob(name: string, chunks: Uint8Array[]) {
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[]));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  // Long enough for the browser to have taken it; a phone hands it to a share sheet.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const shortDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function RemoteFiles({ deviceId, machineName, onClose }: {
  deviceId: number; machineName: string; onClose: () => void;
}) {
  const [state, setState] = useState(0);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [flavor, setFlavor] = useState<Flavor | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [folderError, setFolderError] = useState("");
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [clash, setClash] = useState<{ files: File[]; names: string[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The new-folder field: null while closed. */
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  /** A folder just asked for, checked off against the next listing of where it was made. */
  const madeRef = useRef<{ at: string; name: string } | null>(null);

  const redirectRef = useRef<MeshRedirect<MeshModule> | null>(null);
  const reqRef = useRef(0);
  const pathRef = useRef("");
  const flavorRef = useRef<Flavor | null>(null);
  const liveRef = useRef<Live | null>(null);
  const queueRef = useRef<Transfer[]>([]);
  const keyRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const live = state === 3;

  const send = useCallback((cmd: Record<string, unknown>) => {
    const r = redirectRef.current;
    if (r && r.State === 3) r.send(encodeCommand(cmd));
  }, []);

  const list = useCallback((to: string) => {
    reqRef.current += 1;
    pathRef.current = to;
    setPath(to);
    setLoading(true);
    setFolderError("");
    send({ action: "ls", reqid: reqRef.current, path: to });
  }, [send]);

  // ---------------- Transfers ----------------

  const patch = useCallback((key: number, p: Partial<Transfer>) => {
    queueRef.current = queueRef.current.map((t) => (t.key === key ? { ...t, ...p } : t));
    setTransfers(queueRef.current);
  }, []);

  const runNext = useCallback(async () => {
    if (liveRef.current) return;
    const next = queueRef.current.find((t) => t.state === "queued");
    if (!next) return;
    patch(next.key, { state: "running" });
    // Written down first. A transfer the server refuses to record is a
    // transfer that does not happen.
    const target = next.direction === "download" ? next.remote : childPath(next.remote, next.name, flavorRef.current ?? "unix");
    const noted = await recordRemoteFileTransfer(deviceId, { direction: next.direction, path: target, size: next.size })
      .catch(() => ({ error: "Couldn't reach the portal to record the transfer." }));
    if (noted.error) { patch(next.key, { state: "error", error: noted.error }); void runNext(); return; }
    if (next.direction === "download") {
      const id = Math.floor(Math.random() * 1e9);
      liveRef.current = { kind: "download", key: next.key, id, chunks: [], got: 0 };
      send({ action: "download", sub: "start", id, path: next.remote });
    } else {
      reqRef.current += 1;
      liveRef.current = { kind: "upload", key: next.key, reqid: reqRef.current, file: next.file!, sent: 0, reading: false, finished: false };
      send({ action: "upload", reqid: reqRef.current, path: next.remote, name: next.name, size: next.size });
    }
  }, [deviceId, patch, send]);

  const finish = useCallback((p: Partial<Transfer>) => {
    const l = liveRef.current;
    if (!l) return;
    liveRef.current = null;
    patch(l.key, p);
    void runNext();
  }, [patch, runNext]);

  /** Read and send the next upload block, `ahead` more after it if asked. */
  const pump = useCallback(async (ahead: number) => {
    const l = liveRef.current;
    if (!l || l.kind !== "upload" || l.reading || l.finished) return;
    const r = redirectRef.current;
    if (!r) return;
    for (let i = 0; i <= ahead; i++) {
      if (l.sent >= l.file.size) break;
      l.reading = true;
      const end = Math.min(l.sent + UPLOAD_BLOCK, l.file.size);
      const block = new Uint8Array(await l.file.slice(l.sent, end).arrayBuffer());
      l.reading = false;
      if (liveRef.current !== l) return;
      r.send(uploadFrame(block));
      l.sent = end;
      patch(l.key, { moved: end });
    }
    if (l.sent >= l.file.size && !l.finished) {
      l.finished = true;
      send({ action: "uploaddone", reqid: l.reqid });
    }
  }, [patch, send]);

  const onData = useCallback((data: string) => {
    const cmd = parseCommand(data);
    const l = liveRef.current;
    if (!cmd) {
      // File data: a download block.
      if (!l || l.kind !== "download") return;
      const { data: bytes, last } = downloadBlock(data);
      l.chunks.push(bytes);
      l.got += bytes.length;
      patch(l.key, { moved: l.got });
      if (last) {
        const t = queueRef.current.find((x) => x.key === l.key);
        saveBlob(t?.name ?? "download", l.chunks);
        finish({ state: "done", moved: l.got });
      } else {
        send({ action: "download", sub: "ack", id: l.id });
      }
      return;
    }
    const action = cmd.action;
    if (action === "download") {
      if (!l || l.kind !== "download" || Number(cmd.id) !== l.id) return;
      if (cmd.sub === "start") send({ action: "download", sub: "startack", id: l.id });
      else if (cmd.sub === "cancel") finish({ state: "error", error: "The machine couldn't read that file." });
      return;
    }
    if (typeof action === "string" && action.startsWith("upload")) {
      if (!l || l.kind !== "upload" || Number(cmd.reqid) !== l.reqid) return;
      if (action === "uploadstart") {
        if (l.file.size === 0) { l.finished = true; send({ action: "uploaddone", reqid: l.reqid }); }
        else void pump(UPLOAD_PRIMING);
      } else if (action === "uploadack") void pump(0);
      else if (action === "uploaddone") {
        const folder = queueRef.current.find((x) => x.key === l.key)?.remote;
        finish({ state: "done", moved: l.file.size });
        if (folder === pathRef.current) list(pathRef.current);
      } else if (action === "uploaderror") finish({ state: "error", error: "The machine couldn't write that file there." });
      return;
    }
    if (action === "refresh") { list(pathRef.current); return; }
    const listing = parseListing(cmd);
    if (!listing || listing.reqid !== reqRef.current) return;
    setLoading(false);
    // The first answer says what kind of machine this is: only Windows
    // answers the top with its drives.
    if (flavorRef.current === null) {
      const f: Flavor = listing.entries?.some((e) => e.kind === "drive") ? "windows" : "unix";
      flavorRef.current = f;
      setFlavor(f);
      if (f === "unix") { pathRef.current = "/"; setPath("/"); }
    }
    if (listing.entries === null) { setEntries([]); setFolderError("That folder can't be opened - it may not exist, or this account can't read it."); return; }
    setEntries(listing.entries);
    // The agent does not answer a mkdir; the folder showing up is the answer.
    const made = madeRef.current;
    if (made && made.at === listing.path) {
      madeRef.current = null;
      if (!listing.entries.some((e) => e.name === made.name && e.kind === "folder")) {
        setFolderError(`Couldn't make "${made.name}" here - this account may not be allowed to write to this folder.`);
      }
    }
  }, [finish, list, patch, pump, send]);

  // ---------------- The session ----------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cred = await remoteRelayCredential(deviceId).catch(() => ({ error: "Couldn't reach the portal." } as { error: string; viewer?: undefined }));
      if (cancelled) return;
      if (cred.error || !cred.viewer) { setError(cred.error || "Couldn't open the files."); return; }
      let engine;
      try { engine = await loadEngine(); } catch (e) { if (!cancelled) setError((e as Error).message); return; }
      if (cancelled) return;
      const creds = cred.viewer;
      const module: MeshModule = { protocol: 5, xxStateChange: () => {}, ProcessData: (d) => { if (!cancelled) onDataRef.current(d); } };
      // As for the desktop: the transport asks "a server" for the tunnel, and
      // ours is openRemoteTunnel, which checks again, writes it down and asks
      // the host from the server side.
      const server = {
        send: (o: unknown) => {
          const msg = o as { type?: string; value?: string };
          const id = msg.type === "tunnel" && typeof msg.value === "string"
            ? new URLSearchParams(msg.value.split("?")[1] ?? "").get("id") : null;
          if (!id) return;
          openRemoteTunnel(deviceId, id, "files").then(
            (r) => { if (!cancelled && r.error) { setError(r.error); redirect.Stop(); } },
            () => { if (!cancelled) { setError("Couldn't reach the portal to open the files."); redirect.Stop(); } },
          );
        },
      };
      const redirect = engine.CreateAgentRedirect(server, module, null, creds.relayAuth, null, "/");
      redirect.relayBase = creds.relayBase;
      redirect.attemptWebRTC = false;
      redirect.onStateChanged = (_s, st) => {
        if (cancelled) return;
        setState(st);
        if (st === 3) list("");
        if (st === 0 && liveRef.current) finish({ state: "error", error: "The connection closed mid-transfer." });
      };
      redirect.onConsoleMessageChange = () => { if (!cancelled) setNote(redirect.consoleMessage ?? ""); };
      redirectRef.current = redirect;
      redirect.Start(creds.nodeId);
    })();
    return () => {
      cancelled = true;
      try { redirectRef.current?.Stop(); } catch { /* already down */ }
      redirectRef.current = null;
    };
    // One session per open panel; the handlers it calls are reached through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // ---------------- Gestures ----------------

  const enqueue = (items: Omit<Transfer, "key" | "moved" | "state">[]) => {
    const added = items.map((t) => ({ ...t, key: ++keyRef.current, moved: 0, state: "queued" as const }));
    queueRef.current = [...queueRef.current, ...added];
    setTransfers(queueRef.current);
    void runNext();
  };

  const folderCheck = newFolder === null ? null
    : checkFolderName(newFolder, (entries ?? []).map((e) => e.name), flavor ?? "unix");

  /** Written down, then made, then the folder re-read to see that it was. */
  const makeFolder = async () => {
    if (!folderCheck || "error" in folderCheck || folderBusy) return;
    const at = pathRef.current;
    const target = childPath(at, folderCheck.name, flavorRef.current ?? "unix");
    setFolderBusy(true);
    const noted = await recordRemoteFolder(deviceId, target)
      .catch(() => ({ error: "Couldn't reach the portal to record it." }));
    setFolderBusy(false);
    if (noted.error) { setFolderError(noted.error); return; }
    reqRef.current += 1;
    send({ action: "mkdir", reqid: reqRef.current, path: target });
    madeRef.current = { at, name: folderCheck.name };
    setNewFolder(null);
    list(at);
  };

  const download = (e: RemoteEntry) =>
    enqueue([{ direction: "download", name: e.name, remote: childPath(pathRef.current, e.name, flavorRef.current ?? "unix"), size: e.size }]);

  const queueUploads = (files: File[]) => {
    const folder = pathRef.current;
    enqueue(files.flatMap((f) => {
      const name = safeUploadName(f.name);
      return name ? [{ direction: "upload" as const, name, remote: folder, size: f.size, file: f }] : [];
    }));
  };

  /** Files picked or dropped: straight up, unless one would replace a file already there. */
  const offer = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []).filter((f) => safeUploadName(f.name));
    if (!files.length || !live) return;
    // Windows compares names without case; elsewhere case is part of the name.
    const norm = (n: string) => (flavorRef.current === "windows" ? n.toLowerCase() : n);
    const here = new Set((entries ?? []).filter((e) => e.kind === "file").map((e) => norm(e.name)));
    const names = files.map((f) => safeUploadName(f.name)!).filter((n) => here.has(norm(n)));
    if (names.length) setClash({ files, names }); else queueUploads(files);
  };

  const atTop = flavor === null || parentPath(path, flavor) === null;
  const busy = transfers.some((t) => t.state === "running" || t.state === "queued");
  const shown = transfers.slice(-6).reverse();

  return (
    <aside className="rdesk-files" aria-label={`Files on ${machineName}`}
      onDragOver={(e) => { if (live) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); offer(e.dataTransfer.files); }}>
      <div className="rdesk-files-head">
        <div style={{ minWidth: 0 }}>
          <div className="card-title t-body">Files on {machineName}</div>
          <div className="mut t-meta">
            {error || (live ? "Tap a file to copy it here. Upload sends one to this folder." : note || RELAY_SAYS[state])}
          </div>
        </div>
        <button type="button" className="btn sm" onClick={onClose} aria-label="Close files">✕</button>
      </div>

      {live && flavor && (
        <>
          <nav className="rdesk-files-path" aria-label="Folder">
            {crumbs(path, flavor).map((c, i, all) => (
              <span key={c.path + i}>
                {i > 0 && <span className="mut" aria-hidden> › </span>}
                {i === all.length - 1
                  ? <b>{c.label}</b>
                  : <button type="button" className="btn link" onClick={() => list(c.path)}>{c.label}</button>}
              </span>
            ))}
          </nav>
          <div className="rdesk-files-tools">
            <button type="button" className="btn sm" disabled={atTop}
              onClick={() => { const up = parentPath(path, flavor); if (up !== null) list(up); }}>↑ Up</button>
            <button type="button" className="btn sm" onClick={() => list(path)}>Refresh</button>
            <button type="button" className="btn sm" disabled={flavor === "windows" && path === ""}
              title={flavor === "windows" && path === "" ? "Open a drive first" : undefined}
              onClick={() => { setNewFolder(""); setFolderError(""); }}>
              New folder
            </button>
            <button type="button" className="btn sm accent" style={{ marginLeft: "auto" }}
              disabled={flavor === "windows" && path === ""}
              title={flavor === "windows" && path === "" ? "Open a drive first" : undefined}
              onClick={() => inputRef.current?.click()}>
              Upload here
            </button>
            <input ref={inputRef} type="file" multiple hidden aria-label="Files to upload"
              onChange={(e) => { offer(e.target.files); e.target.value = ""; }} />
          </div>
        </>
      )}

      {newFolder !== null && (
        <form className="rdesk-files-new" onSubmit={(e) => { e.preventDefault(); void makeFolder(); }}>
          <input value={newFolder} autoFocus aria-label="New folder name" placeholder="Folder name"
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setNewFolder(null); }} />
          <button type="submit" className="btn sm primary"
            disabled={folderBusy || !folderCheck || "error" in folderCheck}>
            {folderBusy ? "Making…" : "Make it"}
          </button>
          <button type="button" className="btn sm" onClick={() => setNewFolder(null)}>Cancel</button>
          {newFolder.trim() !== "" && folderCheck && "error" in folderCheck && (
            <div className="t-meta" style={{ color: "var(--t-bad-fg)", flexBasis: "100%" }}>{folderCheck.error}</div>
          )}
        </form>
      )}

      {clash && (
        <div className="card tone-warn rdesk-files-clash" role="alertdialog" aria-label="Replace files?">
          <div className="t-small">
            {clash.names.length === 1
              ? <><b>{clash.names[0]}</b> is already in this folder.</>
              : <>{clash.names.length} of these are already in this folder.</>}
            {" "}Replace {clash.names.length === 1 ? "it" : "them"}?
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn sm accent" onClick={() => { queueUploads(clash.files); setClash(null); }}>Replace</button>
            <button type="button" className="btn sm" onClick={() => {
              const keep = clash.files.filter((f) => !clash.names.includes(safeUploadName(f.name)!));
              if (keep.length) queueUploads(keep);
              setClash(null);
            }}>Skip {clash.names.length === 1 ? "it" : "those"}</button>
          </div>
        </div>
      )}

      <div className={`rdesk-files-list${dragging ? " dropping" : ""}`}>
        {live && loading && entries === null && <div className="mut t-small">Reading the folder…</div>}
        {folderError && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{folderError}</div>}
        {live && entries?.length === 0 && !folderError && !loading && <div className="mut t-small">This folder is empty.</div>}
        {live && entries?.map((e) => (
          <button key={e.kind + e.name} type="button" className="rdesk-file"
            onClick={() => (isFolder(e) ? list(childPath(path, e.name, flavor ?? "unix")) : download(e))}
            aria-label={isFolder(e) ? `Open ${e.name}` : `Copy ${e.name} (${formatSize(e.size)}) to this device`}>
            <span aria-hidden className="rdesk-file-icon">{e.kind === "drive" ? "💽" : e.kind === "folder" ? "📁" : "📄"}</span>
            <span className="rdesk-file-name">{e.name}</span>
            <span className="mut t-meta rdesk-file-meta">
              {[
                e.kind === "file" || (e.kind === "drive" && e.size) ? formatSize(e.size) : "",
                e.kind !== "drive" ? shortDate(e.modified) : "",
              ].filter(Boolean).join(" · ")}
            </span>
            {e.kind === "file" && <span className="rdesk-file-go" aria-hidden>↓</span>}
          </button>
        ))}
        {dragging && <div className="rdesk-files-drop">Drop to upload to {path || "this folder"}</div>}
      </div>

      {shown.length > 0 && (
        <div className="rdesk-files-transfers" aria-live="polite">
          {shown.map((t) => (
            <div key={t.key} className="rdesk-transfer">
              <div className="t-small" style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span aria-hidden>{t.direction === "download" ? "↓" : "↑"}</span>
                <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span className="mut t-meta">
                  {t.state === "done" ? (t.direction === "download" ? "Saved" : "Sent")
                    : t.state === "queued" ? "Waiting"
                    : t.state === "error" ? "Failed"
                    : t.state === "cancelled" ? "Cancelled"
                    : `${formatSize(t.moved)} of ${formatSize(t.size)}`}
                </span>
              </div>
              {t.state === "running" && <progress max={Math.max(1, t.size)} value={t.moved} />}
              {t.error && <div className="t-meta" style={{ color: "var(--t-bad-fg)" }}>{t.error}</div>}
            </div>
          ))}
          {busy && <div className="mut t-meta">Keep this open until the copies finish.</div>}
        </div>
      )}
    </aside>
  );
}
