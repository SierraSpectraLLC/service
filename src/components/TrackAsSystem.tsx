"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { trackAssetAsSystem } from "@/app/actions";

/**
 * Offered on a unit that sits on no system. One instrument on a bench is still a
 * whole engagement, and a unit alone cannot hold stages, a queue, custody or a
 * sign-off packet - so this gives it a system of its own rather than a second
 * place to keep the same record.
 */
export default function TrackAsSystem({ assetId, suggestion }: { assetId: number; suggestion: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(suggestion);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button className="btn sm accent" style={{ flexShrink: 0 }} onClick={() => setOpen(true)}>
        Track as a system
      </button>
    );
  }

  return (
    <span className="row-2" style={{ display: "inline-flex" }}>
      <input value={tag} onChange={(e) => { setTag(e.target.value); setError(""); }}
        aria-label="System tag" placeholder="U-014" autoFocus
        className="t-small" style={{ width: 110 }} />
      <button className="btn sm accent" disabled={pending || !tag.trim()}
        onClick={() => {
          setError("");
          startTransition(async () => {
            const res = await trackAssetAsSystem(assetId, tag);
            if (res?.error) { setError(res.error); return; }
            if (res?.instrumentId) router.push(`/instruments/${res.instrumentId}`);
          });
        }}>{pending ? "Creating..." : "Create"}</button>
      <button className="btn link t-meta" disabled={pending}
        onClick={() => { setOpen(false); setError(""); }}>cancel</button>
      {error && <span className="t-meta" style={{ color: "var(--t-bad-fg)" }}>{error}</span>}
    </span>
  );
}
