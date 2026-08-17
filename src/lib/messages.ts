// Direct messages: naming a conversation, counting what's unread, and deciding
// who may be in one.
//
// Pure. The actions hand in rows; this decides what they mean, so the same
// answers hold on the server and in the browser.

export type ThreadMemberLike = { email: string; name: string; orgName: string; leftAt?: string | null };

const shortName = (m: ThreadMemberLike) => (m.name.trim() || m.email.split("@")[0]);

/**
 * What a thread is called in a list.
 *
 * A named group keeps its name. Everything else is named by WHO IS IN IT,
 * excluding the reader - "Jane" rather than "You and Jane", because a list of
 * conversations is read by scanning for a person. Past three, it counts the
 * rest rather than wrapping onto a second line.
 */
export function threadTitle(
  title: string, members: ThreadMemberLike[], meEmail: string, max = 3,
): string {
  if (title.trim()) return title.trim();
  const others = members
    .filter((m) => m.email.toLowerCase() !== meEmail.toLowerCase() && !m.leftAt)
    .map(shortName);
  if (!others.length) return "Just you";
  if (others.length <= max) return others.join(", ");
  return `${others.slice(0, max).join(", ")} +${others.length - max}`;
}

/** Unread = messages after your last read, never counting your own. */
export function unreadCount(
  messages: { authorEmail: string; createdAt: string }[],
  lastReadAt: string | null,
  meEmail: string,
): number {
  const me = meEmail.toLowerCase();
  return messages.filter((m) =>
    m.authorEmail.toLowerCase() !== me && (!lastReadAt || m.createdAt > lastReadAt)).length;
}

/**
 * Who may this person start a conversation with?
 *
 * The directory already answers "whose logins may this viewer see" - their own
 * organization's and those of the organizations they work with. Messaging
 * borrows that answer exactly, so a client can reach the engineer on their
 * system and never a stranger on another client's.
 */
export function messageableFrom<T extends { email: string }>(directory: T[], meEmail: string): T[] {
  const me = meEmail.toLowerCase();
  const seen = new Set<string>();
  return directory.filter((d) => {
    const e = d.email.trim().toLowerCase();
    // A domain-wildcard allowlist entry ("@lab.com") is a rule about who may
    // sign in, not a person - there is nobody at the other end of it to write
    // to, and mail to it would bounce.
    if (!e || e.startsWith("@") || !e.includes("@") || e === me || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
}

/** A message body worth sending: something, and not a novel. */
export const MAX_MESSAGE = 4000;
export function cleanBody(body: string): { error: string } | { body: string } {
  const b = body.trim();
  if (!b) return { error: "Write something first" };
  if (b.length > MAX_MESSAGE) return { error: `Keep it under ${MAX_MESSAGE} characters` };
  return { body: b };
}

/**
 * Group consecutive messages by the same author so a back-and-forth reads as a
 * conversation rather than as a stack of identical name labels. A gap of more
 * than an hour starts a new group even from the same person: the second
 * message is a new thought, not a continuation.
 */
export type Msg = { id: number; authorEmail: string; authorName: string; body: string; createdAt: string; deletedAt?: string | null };
export function groupMessages(messages: Msg[], gapMinutes = 60): Msg[][] {
  const out: Msg[][] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    const sameAuthor = prev && prev.authorEmail.toLowerCase() === m.authorEmail.toLowerCase();
    const close = prev && (Date.parse(m.createdAt) - Date.parse(prev.createdAt)) <= gapMinutes * 60_000;
    if (sameAuthor && close) last.push(m);
    else out.push([m]);
  }
  return out;
}
