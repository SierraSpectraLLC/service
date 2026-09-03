"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { installServiceCodes } from "@/app/actions";
import { forgetCatalog } from "@/components/PartNumberField";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * The labor and travel numbers the shop quotes off, offered once.
 *
 * A travel zone with an overnight and an hour of LC/MS work are sold off a
 * number the same way a seal is - and typed as free text on every quote, they
 * got a different spelling and a different price each time. These four are the
 * ones the shop named; the rest it adds like any other number.
 *
 * The card is only here while any of them are missing. An offer that stays on
 * the page after it has been taken is an offer somebody takes twice.
 */
export default function ServiceCodesCard({ missing }: {
  missing: { partNumber: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!missing.length) return null;

  const install = () => start(async () => {
    const res = await installServiceCodes();
    if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
    // The book just changed; the next quote line to open must see it.
    forgetCatalog();
    toast({ message: res.added ? `Added ${res.added} service number${res.added === 1 ? "" : "s"}` : "Already there" });
    router.refresh();
  });

  return (
    <Panel
      title="Labor and travel numbers"
      hint={`${missing.length} not in the book yet`}
    >
      <div className="t-body" style={{ marginBottom: 8 }}>
        Hours and trips are quoted off a number too. These land unpriced - what an
        hour or a zone sells for is yours to set, on the number, once.
      </div>
      {missing.map((c) => (
        <div key={c.partNumber} className="row-2"
          style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
          <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)", width: 110 }}>
            {c.partNumber}
          </span>
          <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <button className="btn sm accent" disabled={pending} onClick={install}>
          {pending ? "Adding..." : "Add these to the catalog"}
        </button>
      </div>
    </Panel>
  );
}
