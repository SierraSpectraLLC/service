"use client";

import { useEffect, useState } from "react";

/**
 * The confirmation an action owes: `toast({ message: "Saved procedure" })`
 * after the server action lands. Five seconds, stacking, bottom-right on a
 * desktop and bottom-centre on a phone (globals.css owns that), with room
 * for one Undo. ToastHost is mounted once in layout.tsx; the module-level
 * function reaches it directly, so a call site adds one line.
 */
export type ToastOptions = {
  message: string;
  /** Default is the quiet navy; "bad" for a failure someone must notice. */
  tone?: "bad";
  undo?: () => void;
};

type Entry = ToastOptions & { id: number };

const LIFE_MS = 5000;

let queue: Entry[] = [];
let nextId = 1;
let notify: (() => void) | null = null;

export function toast(opts: ToastOptions) {
  queue = [...queue, { ...opts, id: nextId++ }];
  notify?.();
}

export function ToastHost() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    notify = () => setEntries(queue);
    if (queue.length) setEntries(queue);
    return () => { notify = null; };
  }, []);

  useEffect(() => {
    if (entries.length === 0) return;
    const t = setTimeout(() => {
      queue = queue.slice(1);
      setEntries(queue);
    }, LIFE_MS);
    return () => clearTimeout(t);
  }, [entries]);

  const dismiss = (id: number) => {
    queue = queue.filter((e) => e.id !== id);
    setEntries(queue);
  };

  if (entries.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {entries.map((e) => (
        <div key={e.id} className={`toast${e.tone === "bad" ? " bad" : ""}`}>
          <span>{e.message}</span>
          {e.undo && (
            <button type="button" className="toast-undo"
              onClick={() => { e.undo?.(); dismiss(e.id); }}>
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
