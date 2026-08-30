"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { startRestorationChecklist, tickRestorationChecklistItem } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import type { ChecklistView } from "@/lib/restorationData";

/**
 * One stage's checklist: frozen items, each tick stamped with who and when -
 * the row is the record, which is why these are rows and not a text blob.
 * Until instantiated, a single quiet invitation; the template is chosen
 * server-side (workspace's own beats built-in, category match beats generic).
 */
export default function RestorationChecklistCard({ projectId, stage, title, eyebrow, data, canEdit }: {
  projectId: number;
  stage: string;
  title: string;
  eyebrow: string;
  data: ChecklistView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ error?: string } | void>) =>
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) { toast({ message: res.error, tone: "bad" }); return; }
      router.refresh();
    });

  return (
    <section className="card">
      <h2 className="card-title">{title} <span className="eyebrow">{eyebrow}</span></h2>
      {data === null ? (
        canEdit ? (
          <button className="addrow" disabled={pending}
            onClick={() => act(() => startRestorationChecklist(projectId, stage))}>
            + Start the checklist — items freeze from the template
          </button>
        ) : (
          <div className="mut t-body">No checklist was run at this stage.</div>
        )
      ) : (
        data.items.map((i) => i.heading ? (
          <div className="chk heading" key={i.id}>{i.text}</div>
        ) : (
          <label className="chk" key={i.id}>
            <input type="checkbox" checked={i.checkedAt !== null} disabled={!canEdit || pending}
              onChange={() => act(() => tickRestorationChecklistItem(i.id, i.checkedAt === null))} />
            {i.text}
            <span className="who">{i.checkedAt !== null ? i.checkedBy : "—"}</span>
          </label>
        ))
      )}
    </section>
  );
}
