"use client";

import { useEffect } from "react";
import { markThreadRead } from "@/app/actions";

/** Marks a thread read once it's on screen, so "N new" badges clear themselves. */
export default function ThreadSeen({ threadId, hasNew }: { threadId: number; hasNew: boolean }) {
  useEffect(() => {
    if (hasNew) void markThreadRead(threadId);
  }, [threadId, hasNew]);
  return null;
}
