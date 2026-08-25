"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { createPurchaseOrder } from "@/app/actions";

/**
 * A purchase order from nothing: name the vendor, pick the room the money
 * belongs to, and get a blank draft to type lines onto. The composers still
 * cover the usual cases - this is for the order that starts as a phone call.
 */
export default function NewPoButton({ rooms, vendors }: {
  rooms: { id: number; name: string }[];
  vendors: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState("");
  const [roomId, setRoomId] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (!rooms.length) return null;
  const problem = !vendor.trim() ? "name the vendor" : !roomId ? "pick the stockroom" : null;

  const create = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = await createPurchaseOrder({
        vendor, stockroomId: roomId, lines: [], allowEmpty: true,
      });
      if (res.error || !res.id) { setError(res.error ?? "That didn't save"); return; }
      toast({ message: `Drafted an order on ${vendor.trim()}` });
      router.push(`/money/purchasing/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm primary" onClick={() => {
        setVendor(""); setRoomId(rooms.length === 1 ? rooms[0].id : 0); setError(""); setOpen(true);
      }}>
        ＋ Order
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm" title="New order"
        context="A blank draft. Lines are typed on the order."
        footer={
          <>
            <DialogStatus error={error} problem={problem} ok="Ready to draft." />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={create} disabled={pending || !!problem}>
              {pending ? "Drafting..." : "Draft it"}
            </button>
          </>
        }>
        <label>Vendor</label>
        <input value={vendor} list="new-po-vendors" autoFocus placeholder="Frit & Ferrule"
          onChange={(e) => setVendor(e.target.value)} style={{ marginBottom: 8 }} />
        <datalist id="new-po-vendors">{vendors.map((v) => <option key={v} value={v} />)}</datalist>
        <label>Whose money</label>
        <select value={roomId || ""} onChange={(e) => setRoomId(parseInt(e.target.value) || 0)}>
          {rooms.length !== 1 && <option value="">Pick the stockroom</option>}
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Dialog>
    </>
  );
}
