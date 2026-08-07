"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AssetRegistryFilter({ q, kind, status, kinds, statuses }: {
  q: string; kind: string; status: string; kinds: string[]; statuses: string[];
}) {
  const router = useRouter();
  const [text, setText] = useState(q);
  const go = (next: { q?: string; kind?: string; status?: string }) => {
    const p = new URLSearchParams();
    const merged = { q: text, kind, status, ...next };
    if (merged.q?.trim()) p.set("q", merged.q.trim());
    if (merged.kind) p.set("kind", merged.kind);
    if (merged.status) p.set("status", merged.status);
    router.push(`/assets${p.size ? `?${p}` : ""}`);
  };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
      <input value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go({ q: text }); }}
        placeholder="Serial, model, system..." style={{ flex: "1 1 160px", fontSize: 13 }} />
      <select value={kind} onChange={(e) => go({ kind: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
        <option value="">All kinds</option>
        {kinds.map((k) => <option key={k}>{k}</option>)}
      </select>
      <select value={status} onChange={(e) => go({ status: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
        <option value="">All statuses</option>
        {statuses.map((s) => <option key={s}>{s}</option>)}
      </select>
    </div>
  );
}
