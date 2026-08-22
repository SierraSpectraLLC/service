"use client";

import { useRouter } from "next/navigation";

/**
 * The registry's kind and owner pickers. Status lives in the FacetStrip
 * beside this (URL-state, real counts); these two have too many values for
 * facets, so they stay selects - but they write the same URL.
 */
export default function AssetRegistryFilter({ q, kind, status, owner, kinds, owners }: {
  q: string; kind: string; status: string; owner: string;
  kinds: string[]; owners: string[];
}) {
  const router = useRouter();
  const go = (next: { kind?: string; owner?: string }) => {
    const p = new URLSearchParams();
    const merged = { q, kind, status, owner, ...next };
    if (merged.q.trim()) p.set("q", merged.q.trim());
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.status) p.set("status", merged.status);
    if (merged.owner) p.set("owner", merged.owner);
    router.push(`/assets${p.size ? `?${p}` : ""}`);
  };
  return (
    <>
      <select value={kind} aria-label="Filter by kind" onChange={(e) => go({ kind: e.target.value })} className="t-small" style={{ width: "auto" }}>
        <option value="">All kinds</option>
        {kinds.map((k) => <option key={k}>{k}</option>)}
      </select>
      {owners.length > 0 && (
        <select value={owner} aria-label="Filter by owner" onChange={(e) => go({ owner: e.target.value })} className="t-small" style={{ width: "auto" }}>
          <option value="">All owners</option>
          {owners.map((o) => <option key={o}>{o}</option>)}
        </select>
      )}
    </>
  );
}
