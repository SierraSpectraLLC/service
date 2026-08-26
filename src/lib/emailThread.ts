// Keeping each edition of a recurring email its OWN conversation - and every
// copy of one edition together.
//
// A digest that goes to five people is already one message with five
// addresses on it; reply-all reaches everybody, which is the point. The
// question this file answers is the other one: does Tuesday's digest sit in
// the same conversation as Monday's, or beside it.
//
// It used to be the same one. Every edition claimed to answer a single
// invented message per engagement, so a month of digests collapsed into one
// running chain and the subject had to stay constant to keep Gmail from
// re-splitting it - the day's numbers rode in the preheader instead. That
// bought tidiness and cost the thing people actually do with a digest: point
// at one morning. "The Tuesday digest" was a scroll position inside a
// conversation rather than a message you could find, forward, or reply to
// without dragging four other days along with it.
//
// So the root now carries the DAY. Each date is its own entity, its subject
// says which date it is, and the two agree - which matters more than it
// looks, because References beats the subject line in most clients: a dated
// subject on a shared root gives you thirty differently-named messages inside
// one conversation, the worst of both.
//
// What the mechanism still buys, now that it is per-day: a digest sent twice
// on one day - a cron run and a hand-pressed "send now", a resend after a
// bounce - lands as one conversation rather than as two loose emails nobody
// can tell apart.
//
// Mail clients thread on two RFC 5322 headers, References and In-Reply-To,
// which name the Message-IDs a message answers. We never see the ids Resend
// generates, so instead every copy of one edition claims to answer the same
// INVENTED message - an id no message ever had. Clients thread on the chain
// whether or not the parent is in the mailbox.

/**
 * The domain to hang invented message ids on. Never resolved or delivered to -
 * it only has to be STABLE for one edition, since a root id that moved
 * between two copies of the same digest would split them apart. Taken from the
 * sending address, which is the one piece of identity every instance already
 * has.
 */
export function mailHost(from: string | undefined, fallback = "digest.invalid"): string {
  const m = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(from ?? "");
  return m ? m[1].toLowerCase() : fallback;
}

/**
 * The invented root one edition's copies answer.
 *
 * `key` names the engagement - "org-5", "internal-2" - so no two clients ever
 * land in the same conversation. `day` is the shop day the edition is for, in
 * ISO, and it is what makes each date its own entity. Omitting it is the old
 * single-chain behaviour and is kept only for callers that genuinely want one
 * running thread; the digest passes a day.
 */
export function threadRootId(key: string, host: string, day = ""): string {
  const safe = `${key}${day ? `.${day}` : ""}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return `<digest.${safe}@${host}>`;
}

/**
 * The headers that put this message in that conversation. Both are set:
 * In-Reply-To is what most clients read, References is what the rest walk,
 * and a message with only one of them threads in some inboxes and not others.
 */
export function threadHeaders(rootId: string): Record<string, string> {
  return { "In-Reply-To": rootId, References: rootId };
}
