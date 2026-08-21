// Keeping a recurring email in ONE conversation.
//
// A digest that goes to five people is already one message with five
// addresses on it - reply-all reaches everybody, which is the point. What was
// missing is the other half: yesterday's digest and today's arriving as one
// running thread rather than as thirty separate emails that happen to look
// alike.
//
// Mail clients thread on two RFC 5322 headers, References and In-Reply-To,
// which name the Message-IDs a message answers. We never see the ids Resend
// generates, so instead every edition claims to answer the same INVENTED
// message - a stable id per engagement that no message ever had. Clients
// thread on the chain whether or not the parent is in the mailbox, so all of
// them line up as siblings under a root that isn't there.
//
// Gmail needs one thing more: it re-splits a thread when the subject changes,
// so the digest's subject is deliberately constant and the day's numbers ride
// in the preheader, which is the line Gmail shows beside the subject anyway.
// A dated subject and a single chain cannot both be had.

/**
 * The domain to hang invented message ids on. Never resolved or delivered to -
 * it only has to be STABLE, since a root id that moved would start a new
 * thread. Taken from the sending address, which is the one piece of identity
 * every instance already has.
 */
export function mailHost(from: string | undefined, fallback = "digest.invalid"): string {
  const m = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(from ?? "");
  return m ? m[1].toLowerCase() : fallback;
}

/**
 * The invented root every edition of one digest answers. `key` names the
 * engagement - "org-5", "internal-2" - so each conversation is its own chain
 * and no two clients ever land in the same one.
 */
export function threadRootId(key: string, host: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "-");
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
