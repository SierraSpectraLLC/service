"use client";

import Link from "next/link";

/**
 * Underline tabs - wraps the existing .tabs/.tab pattern. A tab is a link
 * when it has an href (settings areas, org record tabs) or a button when the
 * caller drives state. The count sits beside the label; `warn` colors it
 * amber when that section wants attention ("Specs 0").
 */
export type TabItem = {
  key: string;
  label: React.ReactNode;
  count?: number;
  warn?: boolean;
  href?: string;
};

export default function Tabs({ items, active, onSelect, ariaLabel }: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  ariaLabel?: string;
}) {
  return (
    <nav className="tabs" aria-label={ariaLabel}>
      {items.map((t) => {
        const cls = `tab${t.key === active ? " active" : ""}`;
        const body = (
          <>
            {t.label}
            {t.count != null && <span className={`tab-n${t.warn ? " warn" : ""}`}>{t.count}</span>}
          </>
        );
        return t.href != null ? (
          <Link key={t.key} href={t.href} className={cls}
            aria-current={t.key === active ? "page" : undefined}>
            {body}
          </Link>
        ) : (
          <button key={t.key} type="button" className={cls}
            aria-current={t.key === active ? "true" : undefined}
            onClick={() => onSelect?.(t.key)}>
            {body}
          </button>
        );
      })}
    </nav>
  );
}
