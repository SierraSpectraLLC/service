"use client";

import { useState, useTransition } from "react";
import { runAssetCheckout } from "@/app/actions";

/** Generate this asset's checkout tasks + tests on demand - for a spare being
 *  refurbished for resale, with no system to trigger them. */
export default function RunCheckoutButton({ assetId }: { assetId: number }) {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button className="btn sm" disabled={pending}
        onClick={() => startTransition(async () => {
          const res = await runAssetCheckout(assetId);
          if (res.error) setMsg({ text: res.error, error: true });
          else setMsg({ text: `Added ${res.created} checkout item${res.created === 1 ? "" : "s"}`, error: false });
          setTimeout(() => setMsg(null), 5000);
        })}>
        {pending ? "Running..." : "Run checkout"}
      </button>
      {msg && <span style={{ fontSize: 11, fontWeight: 700, color: msg.error ? "#A32D2D" : "#2E6B2E" }}>{msg.text}</span>}
    </span>
  );
}
