"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * A screen projected on a wall has nobody to press reload. Re-fetches the
 * server render every five minutes - cheap against a derived page, and fresh
 * enough for dates that change a few times a day.
 */
export default function TvRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 5 * 60_000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}
