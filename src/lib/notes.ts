// Who may change a comment somebody already posted.
//
// The work-order thread is not the shop's private notepad: a client's own
// editors post in it, and the engineer reads what they wrote. That makes the
// permissive rule the task-note thread uses - any editor may edit any note -
// the wrong one here, because it would let one company quietly rewrite
// another's words inside a record both sides rely on.
//
// So: your own words are yours to fix or withdraw, and the house can withdraw
// anything (somebody has to be able to clear what should not stand on a record
// they are accountable for) but never to REWRITE what another person said.
// Deleting leaves the old text in the audit log; editing leaves the old text
// too, and stamps the comment as edited so a reader is never shown a changed
// sentence as though it were the original.
//
// Pure, so the rule is testable without a database and reads the same to the
// button that offers the action and the server that grants it.

export type NoteOwner = {
  /** Empty on comments written before the column existed - see byName. */
  authorEmail: string;
  /** The display name it was posted under, the only handle those rows have. */
  author: string;
};

export type NoteActor = { email: string; name: string; isHouse: boolean };

const same = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Is this actor the person who wrote it?
 *
 * Email decides. Rows predating the email column fall back to the display
 * name, which is how the comments already on the board stay editable by the
 * person who wrote them rather than being frozen by a schema change.
 */
export function isAuthor(note: NoteOwner, actor: NoteActor): boolean {
  if (note.authorEmail.trim()) return same(note.authorEmail, actor.email);
  return same(note.author, actor.name);
}

/** Only the author rewrites their own sentence. */
export const canEditNote = (note: NoteOwner, actor: NoteActor): boolean => isAuthor(note, actor);

/** The author withdraws their own; the house may withdraw anything. */
export const canDeleteNote = (note: NoteOwner, actor: NoteActor): boolean =>
  isAuthor(note, actor) || actor.isHouse;
