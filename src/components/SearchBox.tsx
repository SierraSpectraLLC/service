"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const go = () => router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  return (
    <div className="row-2">
      <input className="t-body" value={q} autoFocus onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        placeholder="Serial, PO, part, task, note, system..." style={{ flex: 1 }} />
      <button className="btn sm accent" onClick={go} disabled={q.trim().length < 2}>Search</button>
    </div>
  );
}
