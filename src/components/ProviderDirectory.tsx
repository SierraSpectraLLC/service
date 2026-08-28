"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { linkProvider, unlinkProvider } from "@/app/actions";
import { listingLine, search, type ProviderListing } from "@/lib/providerDirectory";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * Finding the other shop, and keeping the ones you work with.
 *
 * Searched in the browser: a directory of service companies on one instance is
 * tens of rows, not thousands, and a round trip per keystroke would be slower
 * than the filter it replaces. The moment this is a real network it becomes a
 * server query with the same lib/providerDirectory rules behind it.
 *
 * The shortlist is one-sided and tells the other company nothing. Consent
 * happens where it matters - at a share, which they approve or refuse.
 */
export default function ProviderDirectory({ listings, linked, notes }: {
  listings: ProviderListing[];
  linked: number[];
  notes: Record<number, string>;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [pending, startTransition] = useTransition();
  const mine = new Set(linked);

  const results = useMemo(() => search(listings, q), [listings, q]);
  const yours = listings.filter((l) => mine.has(l.orgId));

  const add = (orgId: number, name: string) =>
    startTransition(async () => {
      const res = await linkProvider(orgId);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({ message: `${name} added - you can share clients with them` });
      router.refresh();
    });

  const drop = (orgId: number, name: string) =>
    startTransition(async () => {
      const res = await unlinkProvider(orgId);
      if (res?.error) { toast({ message: res.error }); return; }
      toast({ message: `${name} removed` });
      router.refresh();
    });

  const row = (l: ProviderListing, inList: boolean) => (
    <div key={l.orgId} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
      <div className="row-2" style={{ alignItems: "baseline" }}>
        <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{l.name}</span>
        {inList && <Pill tone="info">Yours</Pill>}
        {inList
          ? <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
              onClick={() => drop(l.orgId, l.name)}>remove</button>
          : <button className="btn sm" disabled={pending}
              onClick={() => add(l.orgId, l.name)}>Add</button>}
      </div>
      {listingLine(l) && <div className="mut t-small">{listingLine(l)}</div>}
      {l.blurb && <div className="mut t-small">{l.blurb}</div>}
      {(l.contactName || l.contactEmail || l.website) && (
        <div className="mut t-meta" style={{ marginTop: 2 }}>
          {[l.contactName, l.contactEmail, l.website].filter(Boolean).join(" · ")}
        </div>
      )}
      {notes[l.orgId] && <div className="mut t-meta">{notes[l.orgId]}</div>}
    </div>
  );

  return (
    <>
      <Panel
        title="Your service companies"
        count={yours.length}
        hint="The shops you can share a client with. Adding one is private to you."
        empty="None yet - find one below."
      >
        {yours.map((l) => row(l, true))}
      </Panel>

      <Panel title="Directory" count={listings.length}
        hint="Every shop that has asked to be listed.">
        <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the directory"
          placeholder="LC-MS Seattle, or a company name" />
        <div className="mut t-meta" style={{ marginTop: 4 }}>
          {results.length} of {listings.length} listed {listings.length === 1 ? "company" : "companies"}
        </div>
        {results.map((l) => row(l, mine.has(l.orgId)))}
        {results.length === 0 && (
          <div className="mut t-small" style={{ paddingTop: 10 }}>
            Nothing matches. Companies appear here once they list themselves.
          </div>
        )}
      </Panel>
    </>
  );
}
