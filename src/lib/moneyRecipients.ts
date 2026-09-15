// Who at a client hears about their money.
//
// Written after a first-rung reminder went to a client's entire daily-digest
// list - the lab staff who watch their instruments, and two of our own
// people on the list beside them - because the reminder's audience was
// built by ADDING the digest list to whatever else was set, and on the first
// rung nothing else was. The digest list is people who want to know what is
// blocked on their systems. It is never who pays the bills.
//
// Pure, so the rule is tested as a rule: one destination per mail, in a
// strict order, and an empty answer when nothing is set. The caller records
// "nobody to send it to" rather than guessing.

/**
 * A reminder on an overdue invoice: the rung's escalation contact when the
 * rung names one, else the AP desk, else nobody. Every rung goes to the desk
 * that pays - the first one included - and never to the digest list.
 */
export function reminderRecipients(input: { contactEmail?: string | null; apEmail?: string | null }): string[] {
  const contact = (input.contactEmail ?? "").trim();
  if (contact) return [contact];
  const ap = (input.apEmail ?? "").trim();
  return ap ? [ap] : [];
}

/**
 * A quote: the AP desk when one is set, else the digest list - the people
 * who asked for the work are a fair audience for an offer to do it - and
 * never both.
 */
export function quoteRecipients(input: { apEmail?: string | null; digestList: string[] }): string[] {
  const ap = (input.apEmail ?? "").trim();
  if (ap) return [ap];
  return [...new Set(input.digestList.map((e) => e.trim()).filter(Boolean))];
}
