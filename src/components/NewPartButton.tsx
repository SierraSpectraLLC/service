"use client";

import { useState } from "react";
import { catalogBook } from "@/app/actions";
import PartDialog, { type PartDraft } from "@/components/PartDialog";
import { toast } from "@/components/ui/Toast";

/**
 * Catalog a number from wherever you are standing.
 *
 * Asked for from the quote builder: "if a part isn't available, let me add it
 * quickly while building the quote." The alternative was leaving the draft,
 * finding Settings > Parts, typing the number, and coming back to find the
 * line still unwritten - which is how a number ends up typed as free text
 * instead, and how the same seal acquires its fourth spelling.
 *
 * It opens the SAME form the parts catalog opens (PartDialog), not a smaller
 * one beside it. Two forms for one thing drift: one gets the alias field, the
 * other gets the photo, and which you got depended on which page you were on.
 * What this adds is only the fetch - the module types, models and makers the
 * form needs arrive on the click, so a page that never opens it never pays.
 */
export default function NewPartButton({ seed, label = "＋ New part number", onSaved }: {
  /** What is already typed, so the form opens filled in rather than blank. */
  seed?: Partial<PartDraft>;
  label?: string;
  /** The number that was written, for the field that sent somebody here. */
  onSaved?: (partNumber: string) => void;
}) {
  const [book, setBook] = useState<{
    assetTypes: string[]; modelsByType: Record<string, string[]>; makers: string[]; today: string;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (book) { setOpen(true); return; }
    setBusy(true);
    try {
      setBook(await catalogBook());
      setOpen(true);
    } catch {
      toast({ message: "Could not open the part form", tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void start()}>
        {busy ? "Opening..." : label}
      </button>
      {open && book && (
        <PartDialog
          seed={seed}
          assetTypes={book.assetTypes} modelsByType={book.modelsByType}
          makers={book.makers} today={book.today}
          onClose={() => setOpen(false)}
          onSaved={(partNumber) => onSaved?.(partNumber)} />
      )}
    </>
  );
}
