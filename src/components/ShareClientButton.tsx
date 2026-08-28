"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { shareClient } from "@/app/actions";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * Hand this client to another service company.
 *
 * The sibling of the fleet brief above it, and deliberately a different act:
 * a brief is a page somebody READS, this puts the client into their workspace
 * to WORK. So it names what would be copied, says plainly what would not, and
 * says that they have to accept - all before the button, because the thing
 * people get wrong about this feature is assuming it already happened.
 */
export default function ShareClientButton({ orgId, orgName, systems, providers }: {
  orgId: number;
  orgName: string;
  systems: number;
  providers: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const toggle = (id: number) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  const send = () =>
    startTransition(async () => {
      setError("");
      const res = await shareClient(orgId, { toOrgIds: picked, note });
      if (res.error) { setError(res.error); return; }
      toast({ message: `Offered to ${res.sent} ${res.sent === 1 ? "company" : "companies"} - waiting on them` });
      setPicked([]); setNote("");
      router.push("/network");
    });

  return (
    <Panel
      title="Hand this client over"
      hint="A copy lands in their workspace once they accept. Different from sharing the fleet above, which is only a page they read."
    >
      {providers.length === 0 ? (
        <div className="mut t-small">
          No service companies on your list yet. Find them in{" "}
          <a href="/network">Service companies</a> first.
        </div>
      ) : (
        <>
          <div className="mut t-small" style={{ marginBottom: 8 }}>
            {orgName} and its {systems} system{systems === 1 ? "" : "s"} - names, sites, models and
            serials. <b>Not</b> your contracts, rates, invoices, notes or work history.
          </div>
          {providers.map((p) => (
            <label key={p.id} className="t-body"
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <input type="checkbox" className="check" checked={picked.includes(p.id)}
                disabled={pending} onChange={() => toggle(p.id)} />
              {p.name}
            </label>
          ))}

          <label style={{ marginTop: 10 }}>A line for them</label>
          <input value={note} aria-label="Note to them" disabled={pending}
            placeholder="you take the Alameda site, we keep Hayward"
            onChange={(e) => setNote(e.target.value)} />

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <button className="btn accent" disabled={pending || picked.length === 0 || systems === 0}
              onClick={send}>
              {pending ? "Offering..." : `Offer to ${picked.length || "..."}`}
            </button>
            {error && <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</span>}
          </div>
          <div className="mut t-meta" style={{ marginTop: 8 }}>
            Nothing is written into their workspace until somebody there accepts. The copy is a
            snapshot taken now - it does not update afterwards, and neither does theirs.
          </div>
        </>
      )}
    </Panel>
  );
}
