// Typing "@ni" and being shown who you mean.
//
// Mentions already notified people (lib/notify.parseMentions); what was missing
// was the half that happens while you type. You had to know the name before you
// could write it, which makes an @mention a feature for whoever built the
// directory and nobody else.
//
// This is the pure half: given the text and where the caret is, is an @token
// being typed, who matches it, and what does the box hold once one is picked.
// The component around it (MentionBox) draws the list and moves the selection;
// keeping the rules here means the dropdown and the notifier agree about what
// counts as a mention, and that the tricky part - caret arithmetic - is
// testable without a browser.

export type Candidate = { name: string; email: string; org: string };

/** The token under the caret, when one is being typed. */
export type MentionQuery = {
  /** Index of the "@". */
  start: number;
  /** Index just past the typed token; the caret. */
  end: number;
  /** What was typed after the "@", never including it. */
  text: string;
};

/**
 * How much of a name may be typed before this stops looking like a mention.
 * Long enough for "Chris Ma", short enough that a paragraph containing an
 * email address does not keep a dropdown open to its last character.
 */
const MAX_QUERY = 32;

/**
 * Find the @token the caret sits in, or null.
 *
 * A mention starts at the beginning of the text or after whitespace - never
 * mid-word, so "joe@sierraspectra.com" is an address rather than a mention of
 * "sierraspectra.com". One internal space is allowed, because "Chris Ma" is a
 * name somebody will type in full and a dropdown that gave up at the space
 * would be useless for exactly the names that need it most.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? "" : upto[at - 1];
  if (before && !/\s/.test(before)) return null;
  const typed = upto.slice(at + 1);
  if (typed.length > MAX_QUERY) return null;
  // Letters, digits and the punctuation names actually contain, plus at most
  // one run of spaces - two words is a full name, three is a sentence.
  if (!/^[\p{L}\p{N}._'-]*(?: [\p{L}\p{N}._'-]*)?$/u.test(typed)) return null;
  return { start: at, end: caret, text: typed };
}

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Who matches what has been typed, best first.
 *
 * Ranked the way a person scans: somebody whose name starts with it, then
 * somebody a word of whose name starts with it ("ma" finds "Chris Ma"), then a
 * loose contains. An empty query offers everyone, because typing "@" and
 * looking is how you use this when you cannot remember the spelling at all.
 */
export function matchMentions(people: Candidate[], query: string, limit = 6): Candidate[] {
  const q = norm(query);
  const seen = new Set<string>();
  const uniq = people.filter((p) => {
    const k = norm(p.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!q) return uniq.slice(0, limit);
  const rank = (p: Candidate): number => {
    const n = norm(p.name);
    if (n.startsWith(q)) return 0;
    if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    if (norm(p.email).startsWith(q)) return 3;
    return -1;
  };
  return uniq
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((x) => x.p);
}

/**
 * The text and caret after picking somebody.
 *
 * A trailing space is added so the next word is not glued to the name, and so
 * the mention is complete the moment it is chosen - parseMentions matches on
 * the name, and "@Chris Mahoney" would otherwise sit there half-typed.
 */
export function applyMention(
  text: string, q: MentionQuery, name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, q.start) + inserted + text.slice(q.end),
    caret: q.start + inserted.length,
  };
}
