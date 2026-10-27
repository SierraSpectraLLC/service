"use client";

/**
 * The engine's two browser scripts (vendored under public/vendor/meshcentral,
 * Apache-2.0), loaded once a page and shared by everything that opens a relay
 * session: the desktop (RemoteDesktop) and the machine's files (RemoteFiles).
 *
 * Their scripts reach for a few globals the engine's own pages define. They
 * are defined here, once, the same way - see the vendor NOTICE.
 */

export type MeshDesktop = {
  State: number;
  ScreenWidth: number;
  ScreenHeight: number;
  onScreenSizeChange: (() => void) | null;
  send: (bytes: string) => void;
  SendKeyMsgKC: (action: number, kc: number, extended?: boolean) => void;
  SendKeyUnicode: (action: number, code: number) => void;
  SendCtrlAltDelMsg: () => void;
  SendRefresh: () => void;
};

/**
 * What the transport needs from a session module: the engine's protocol number
 * and somewhere to hand what arrives. The desktop decoder is one; the files
 * panel builds its own (a plain object, as the engine's console does).
 */
export type MeshModule = { protocol: number; xxStateChange?: (s: number) => void; ProcessData?: (data: string) => void };

export type MeshRedirect<M = MeshDesktop> = {
  m: M;
  State: number;
  relayBase?: string;
  attemptWebRTC?: boolean;
  consoleMessage?: string | null;
  onStateChanged: ((sender: unknown, state: number) => void) | null;
  onConsoleMessageChange: (() => void) | null;
  Start: (nodeId: string) => void;
  Stop: () => void;
  /** Bytes as-is: a binary string, or a typed array for file data. */
  send: (data: string | Uint8Array) => void;
};

export type MeshEngine = {
  CreateAgentRemoteDesktop: (canvas: HTMLCanvasElement, scroll: HTMLElement | null) => MeshDesktop;
  CreateAgentRedirect: <M>(
    server: { send: (o: unknown) => void }, module: M, publicNamePort: string | null,
    authCookie: string, rauthCookie: string | null, domainUrl: string,
  ) => MeshRedirect<M>;
};

type MeshWindow = Window & Partial<MeshEngine> & {
  urlargs?: Record<string, string>;
  ShortToStr?: (x: number) => string;
  encode_utf8?: (s: string) => string;
  decode_utf8?: (s: string) => string;
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
    el.addEventListener("error", () => reject(new Error("The remote viewer didn't load.")));
    if (!found) { el.src = src; document.head.appendChild(el); }
  });
}

/** The engine's constructors, with the globals their scripts expect in place. */
export async function loadEngine(): Promise<MeshEngine> {
  for (const src of SCRIPTS) await loadScript(src);
  const w = window as MeshWindow;
  if (!w.urlargs) w.urlargs = {};
  if (!w.ShortToStr) w.ShortToStr = (x: number) => String.fromCharCode((x >> 8) & 0xff, x & 0xff);
  // common-0.0.1.js's pair, which the transport's sendText calls.
  if (!w.encode_utf8) w.encode_utf8 = (s: string) => unescape(encodeURIComponent(s));
  if (!w.decode_utf8) w.decode_utf8 = (s: string) => decodeURIComponent(escape(s));
  if (!w.CreateAgentRemoteDesktop || !w.CreateAgentRedirect) throw new Error("The remote viewer didn't load.");
  return { CreateAgentRemoteDesktop: w.CreateAgentRemoteDesktop, CreateAgentRedirect: w.CreateAgentRedirect };
}

/** What the transport's states mean to somebody waiting. */
export const RELAY_SAYS: Record<number, string> = {
  0: "Not connected",
  1: "Reaching the support host…",
  2: "Waiting for the machine to answer…",
  3: "Connected",
};
