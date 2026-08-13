// What the installer a client downloads is actually called.
//
// The support host bakes its branding into the agent as it serves it - the
// window title, the Windows service name, the picture, and the file name - from
// settings that live on that host and nowhere in this codebase. Which means the
// portal cannot set them, and, left alone, cannot tell whether they were ever
// set. The way it goes wrong is silent: everything works, and a client is handed
// a file called `meshagent64-Acme.exe` by a company whose name is not MeshAgent.
//
// So we ask the host what it would serve, and read the name off the response.
// The parsing is here, pure, because the interesting cases are all string cases:
// a header the engine percent-encodes, a name that is still the engine's, and a
// host that answered with nothing useful at all.

/** Names the engine ships with. Anything starting like these was never branded. */
const ENGINE_NAMES = /^(meshagent|meshservice|meshcentral|meshcmd|meshosx|meshandroid|meshconsole)/i;

/**
 * The filename out of a `Content-Disposition` header.
 *
 * The engine writes `attachment; filename="<encodeURIComponent(name)>"`, so the
 * value arrives percent-encoded and quoted. Returns "" for anything else, which
 * is the same answer as "we could not tell" and is treated that way.
 */
export function fileNameFromDisposition(header: string | null | undefined): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? "");
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();   // a stray % is not a reason to report nothing
  }
}

/** Is this still the name the engine ships with, rather than the operator's? */
export const isEngineDefaultName = (fileName: string): boolean =>
  ENGINE_NAMES.test(fileName.trim());

export type AgentBranding = {
  /** What the host says it would call the download. */
  fileName: string;
  /** False while the host is still serving the engine's own name. */
  branded: boolean;
};

/** Read a probe's answer. Null when the host could not be asked at all. */
export function brandingFrom(header: string | null | undefined): AgentBranding | null {
  const fileName = fileNameFromDisposition(header);
  if (!fileName) return null;
  return { fileName, branded: !isEngineDefaultName(fileName) };
}
