"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The remote desktop, rendered on our own canvas.
 *
 * What this replaces: an iframe holding the engine's console page, which cost a
 * third-party cookie, a press of somebody else's Connect button, and two of their
 * toolbars. Here the session starts on its own and the controls are ours.
 *
 * How it works, because it looks like more magic than it is:
 *
 *   1. Two scripts from the engine (vendored under public/vendor/meshcentral,
 *      Apache-2.0) decode the desktop stream onto a canvas and encode input back.
 *      Everything hard about pixels and keyboards is theirs and stays theirs.
 *   2. The stream travels browser <-> relay host <-> agent. Nothing of ours is in
 *      the path, exactly as before.
 *   3. Both credentials were minted server-side from the shared key, so there is
 *      no engine session cookie in this browser and no admin call on this path.
 *
 * The one thing the transport needs from a "server" object is `send`, used to ask
 * the host to tell the agent which relay to meet us at. That is the shim below,
 * over a control socket this component opens with its own short-lived token.
 */

type Creds = { relayBase: string; controlUrl: string; relayAuth: string; nodeId: string };

// The engine's scripts expect two globals that its own pages define.
type MeshWindow = Window & {
  Q?: (id: string) => HTMLElement | null;
  urlargs?: Record<string, string>;
  CreateAgentRemoteDesktop?: (canvas: HTMLCanvasElement, scroll: HTMLElement | null) => MeshDesktop;
  CreateAgentRedirect?: (
    server: { send: (o: unknown) => void }, module: MeshDesktop, publicNamePort: string | null,
    authCookie: string, rauthCookie: string | null, domainUrl: string,
  ) => MeshRedirect;
};
type MeshDesktop = {
  State: number;
  onScreenSizeChange?: () => void;
  stopInput?: boolean;
  mousedown: (e: unknown) => void; mouseup: (e: unknown) => void; mousemove: (e: unknown) => void;
  mousewheel: (e: unknown) => void; mousedblclick: (e: unknown) => void;
  handleKeyDown: (e: unknown) => void; handleKeyUp: (e: unknown) => void;
  SendCtrlAltDelMsg: () => void; SendRefresh: () => void;
};
type MeshRedirect = {
  m: MeshDesktop;
  relayBase?: string;
  attemptWebRTC?: boolean;
  onStateChanged?: (sender: unknown, state: number) => void;
  Start: (nodeId: string) => void;
  Stop: () => void;
};

const SCRIPTS = [
  "/vendor/meshcentral/agent-desktop-0.0.2.js",
  "/vendor/meshcentral/agent-redir-ws-0.1.1.js",
];

/** Loads a script once per page, resolving on the load event. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const found = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (found?.dataset.loaded === "yes") { resolve(); return; }
    const el = found ?? document.createElement("script");
    el.addEventListener("load", () => { el.dataset.loaded = "yes"; resolve(); });
    el.addEventListener("error", () => reject(new Error(`couldn't load ${src}`)));
    if (!found) { el.src = src; document.head.appendChild(el); }
  });
}

/** What the four transport states mean to somebody waiting for a desktop. */
const SAYS: Record<number, string> = {
  0: "not connected",
  1: "reaching the support host",
  2: "waiting for the machine to answer",
  3: "connected",
};

export default function RemoteDesktop({ creds, machineName }: { creds: Creds; machineName: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ redirect: MeshRedirect; control: WebSocket } | null>(null);
  const [state, setState] = useState(0);
  const [error, setError] = useState("");
  const [fit, setFit] = useState(true);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (!s) return;
    try { s.redirect.Stop(); } catch { /* already down */ }
    try { s.control.close(); } catch { /* already down */ }
    setState(0);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        for (const src of SCRIPTS) await loadScript(src);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
        return;
      }
      if (cancelled) return;

      const w = window as MeshWindow;
      // Their scripts reach for these; their own pages define them, ours must too.
      if (!w.Q) w.Q = (id: string) => document.getElementById(id);
      if (!w.urlargs) w.urlargs = {};
      const canvas = canvasRef.current;
      if (!canvas || !w.CreateAgentRemoteDesktop || !w.CreateAgentRedirect) {
        setError("The desktop viewer didn't load.");
        return;
      }

      // The control socket exists for one message - "tell that machine to meet me
      // at this relay" - and stays open only because the transport may send more.
      const control = new WebSocket(creds.controlUrl);
      control.onerror = () => { if (!cancelled) setError("Couldn't reach the support host."); };
      control.onclose = () => {
        // A close before the desktop is up means the token was refused; after, it
        // is just the session ending.
        if (!cancelled && sessionRef.current === null) {
          setError((was) => was || "The support host closed the connection.");
        }
      };
      control.onopen = () => {
        if (cancelled) { try { control.close(); } catch { /* fine */ } return; }
        const module = w.CreateAgentRemoteDesktop!(canvas, holderRef.current);
        const redirect = w.CreateAgentRedirect!(
          { send: (o: unknown) => control.send(JSON.stringify(o)) },
          module, null, creds.relayAuth, null, "/",
        );
        // Ours is not the engine's page, so the relay address has to be told,
        // not inferred from the address bar. See the vendor NOTICE.
        redirect.relayBase = creds.relayBase;
        redirect.attemptWebRTC = false;   // relay only; a peer path is a later problem
        redirect.onStateChanged = (_s, st) => { if (!cancelled) setState(st); };
        module.onScreenSizeChange = () => { if (!cancelled) setState((x) => x); };
        sessionRef.current = { redirect, control };
        redirect.Start(creds.nodeId);
      };
    })();

    return () => { cancelled = true; stop(); };
  }, [creds, stop]);

  // Keyboard goes to the machine while the desktop has focus, and nowhere else -
  // otherwise typing in this page would arrive on somebody's instrument PC.
  const focused = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const m = sessionRef.current?.redirect.m;
      if (!m || !focused.current || m.State !== 3) return;
      e.preventDefault();
      m.handleKeyDown(e);
    };
    const up = (e: KeyboardEvent) => {
      const m = sessionRef.current?.redirect.m;
      if (!m || !focused.current || m.State !== 3) return;
      e.preventDefault();
      m.handleKeyUp(e);
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => { document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); };
  }, []);

  const m = () => sessionRef.current?.redirect.m;
  const live = state === 3;

  return (
    <div>
      <div style={{
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        padding: "6px 0", fontSize: 12,
      }}>
        <span aria-hidden style={{
          width: 9, height: 9, borderRadius: 999,
          background: live ? "#2E6B2E" : state === 0 ? "#94A3B8" : "#C08A2E",
        }} />
        <span className="mut">{error ? "" : SAYS[state] ?? "connecting"}</span>
        {error && <span style={{ color: "#A32D2D" }}>{error}</span>}

        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button className="btn sm" disabled={!live} onClick={() => m()?.SendCtrlAltDelMsg()}>
            Ctrl + Alt + Del
          </button>
          <button className="btn sm" disabled={!live} onClick={() => m()?.SendRefresh()}>Redraw</button>
          <button className="btn sm" onClick={() => setFit((f) => !f)}>
            {fit ? "Actual size" : "Fit to window"}
          </button>
          {live && <button className="btn sm" onClick={stop}>Disconnect</button>}
        </span>
      </div>

      {/* tabIndex so the desktop can hold focus: keys only travel while it does. */}
      <div ref={holderRef} tabIndex={0}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
        style={{
          background: "#101418", border: "1px solid var(--line)", borderRadius: 6,
          overflow: "auto", maxHeight: "calc(100vh - 210px)", minHeight: 320,
          outline: "none", display: "flex", justifyContent: "center", alignItems: "flex-start",
        }}>
        <canvas
          ref={canvasRef}
          aria-label={`Remote desktop for ${machineName}`}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => { holderRef.current?.focus(); m()?.mousedown(e.nativeEvent); }}
          onMouseUp={(e) => m()?.mouseup(e.nativeEvent)}
          onMouseMove={(e) => m()?.mousemove(e.nativeEvent)}
          onDoubleClick={(e) => m()?.mousedblclick(e.nativeEvent)}
          onWheel={(e) => m()?.mousewheel(e.nativeEvent)}
          // The decoder maps clicks through canvas.width / clientWidth, so CSS
          // scaling stays honest and the pointer lands where it looks like it does.
          style={fit ? { maxWidth: "100%", height: "auto" } : undefined}
        />
      </div>

      {!live && !error && (
        <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
          If this stays here, the machine is powered off, asleep, or has not checked in since it was last on.
        </div>
      )}
    </div>
  );
}
