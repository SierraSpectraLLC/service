"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { reportTrail } from "@/app/actions";

/**
 * The browser end of the trail: one row per page opened, one per error thrown.
 *
 * Mounted once in the root layout, and only when the module is on - a page
 * that is not being recorded should not be paying for a component that
 * reports nothing.
 *
 * WHY NOT CLICKS. Every click that matters in this app ends in a navigation or
 * a server action, and a server action that fails throws or returns an error
 * somebody sees. Both leave a footprint here already. A raw click listener
 * would add a row for every stray press on a card, at a hundred times the
 * volume, and none of those rows would say what went wrong - which is the
 * question this exists to answer.
 */
export default function TrailReporter() {
  const path = usePathname();
  const params = useSearchParams();
  // The last route reported, so a re-render does not file the same page twice.
  const last = useRef<string>("");

  useEffect(() => {
    const search = params?.toString() ?? "";
    const here = `${path}?${search}`;
    if (here === last.current) return;
    last.current = here;
    // Fire and forget on purpose: a page must never wait on its own bookkeeping.
    void reportTrail({ kind: "page", route: path ?? "", search }).catch(() => {});
  }, [path, params]);

  useEffect(() => {
    const send = (message: string, detail: string) => {
      void reportTrail({
        kind: "error",
        route: window.location.pathname,
        search: window.location.search,
        message, detail,
      }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => {
      send(
        e.message || "Unknown error",
        // Where it happened beats a stack that has been minified into
        // meaninglessness, so both go and the reader picks.
        `${e.filename ?? ""}:${e.lineno ?? 0}:${e.colno ?? 0}\n${e.error?.stack ?? ""}`.trim(),
      );
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      send(
        (r instanceof Error ? r.message : String(r ?? "")) || "Unhandled promise rejection",
        r instanceof Error ? (r.stack ?? "") : "",
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
