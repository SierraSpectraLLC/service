"use client";

import { useState, useTransition } from "react";
import {
  addExpenseCategory, deleteExpenseCategory, loadStarterCategories, renameExpenseCategory,
} from "@/app/actions";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { InlineEdit, Panel } from "@/components/ui";

export type CategoryRow = { id: number; name: string };

/**
 * The expense vocabulary, owned by whoever owns the books. Every name is
 * renameable and deletable because it is THEIR filing system, not ours - the
 * starter set is a shelf a new workspace begins with, and the load button
 * offers the same shelf to one that emptied it or predates it.
 *
 * Rename and delete change the PICKER, never history: a row logged as "Fuel"
 * says Fuel forever, whatever happens to the category afterwards. That rule
 * is what makes delete safe enough to offer without ceremony.
 */
export default function ExpenseCategoriesCard({ rows }: { rows: CategoryRow[] }) {
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ error?: string } | void>, done?: string) => {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res?.error) { setError(res.error); return; }
      if (done) toast({ message: done });
    });
  };

  return (
    <Panel title="Expense categories" count={rows.length}
      hint="What the expense pickers offer. Logged rows keep the name they were filed under.">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {rows.map((c) => (
          <span key={c.id} className="pill neutral" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <InlineEdit value={c.name} label={`category ${c.name}`}
              onSave={(next) => run(() => renameExpenseCategory(c.id, next), "Renamed")} />
            <button className="btn link" aria-label={`Delete ${c.name}`} disabled={pending}
              style={{ color: "var(--t-bad-fg)", fontSize: 12, padding: 0 }}
              onClick={async () => {
                if (!(await confirmDialog({
                  title: `Remove "${c.name}" from the pickers?`,
                  body: "Rows already logged keep the name. Nothing else changes.",
                  action: "Remove category", tone: "bad",
                }))) return;
                run(() => deleteExpenseCategory(c.id), `Removed ${c.name}`);
              }}>×</button>
          </span>
        ))}
        {rows.length === 0 && <span className="mut t-small">No categories - the pickers fall back to Other.</span>}
      </div>
      <div className="row-2" style={{ alignItems: "center" }}>
        <input className="t-body" value={adding} placeholder="Add a category"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && adding.trim()) {
              run(() => addExpenseCategory(adding), `Added ${adding.trim()}`);
              setAdding("");
            }
          }}
          style={{ flex: "0 1 220px" }} />
        <button className="btn sm" disabled={pending || !adding.trim()}
          onClick={() => { run(() => addExpenseCategory(adding), `Added ${adding.trim()}`); setAdding(""); }}>
          Add
        </button>
        <button className="btn sm" disabled={pending}
          title="Adds whichever starter names are missing from the list - including ones removed earlier."
          onClick={() => startTransition(async () => {
            const res = await loadStarterCategories();
            toast({ message: res.added ? `Added ${res.added} starter categor${res.added === 1 ? "y" : "ies"}` : "Nothing missing - the starter set is already here" });
          })}>
          Load the starter set
        </button>
      </div>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
    </Panel>
  );
}
