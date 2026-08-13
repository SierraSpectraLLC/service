// What to call a lab PC.
//
// A machine arrives carrying whatever Windows called it when it was imaged -
// DESKTOP-39VTF39 - and the engine keeps that name refreshed, because it is the
// hostname and the hostname is the engine's business. It is also useless to an
// engineer picking the right machine off a list: three of them are DESKTOP-
// something and the one that matters is "the Altis PC".
//
// So there are two names and they do different jobs. The nickname is what people
// read; the hostname is what proves you have the right box, and stays visible
// beside it rather than being replaced by it. Pure, because every surface that
// lists a machine has to agree on which one it shows.

/** Windows' own default naming, which carries no information a person can use. */
const AUTO_HOSTNAME = /^(desktop|laptop|win|pc|user|admin|host)[-_]?[a-z0-9]{5,}$/i;

/** The name to put in front of somebody. */
export function deviceLabel(nickname: string, hostname: string): string {
  return nickname.trim() || hostname.trim() || "Unnamed machine";
}

/**
 * The hostname, when it is worth showing as well - which is whenever it is not
 * already the label. Blank means "nothing more to say", so a caller can render
 * it without deciding.
 */
export function deviceSubLabel(nickname: string, hostname: string): string {
  const host = hostname.trim();
  return nickname.trim() && host ? host : "";
}

/**
 * Is this machine still going by a name Windows made up?
 *
 * Used to nudge, once, on a list - not to block anything. A shop that never
 * names its machines should get a hint, not a chore.
 */
export const needsNickname = (nickname: string, hostname: string): boolean =>
  !nickname.trim() && AUTO_HOSTNAME.test(hostname.trim());

/** Trim to something a row can show. Empty clears it back to the hostname. */
export const cleanNickname = (raw: string): string => raw.trim().replace(/\s+/g, " ").slice(0, 60);
