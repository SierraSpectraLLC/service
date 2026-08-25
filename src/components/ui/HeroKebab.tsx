"use client";

import Dropdown from "@/components/Dropdown";

export type HeroKebabItem = { label: string; href?: string; onClick?: () => void; tone?: "bad" };

/**
 * The record hero's overflow menu. Serializable items (links) can come from a
 * server page; `arrange` adds the "Rearrange panels" entry, which reaches the
 * PanelLayout on the page through a window event so the toggle can live here
 * instead of as a standing button above the panels.
 */
export const ARRANGE_EVENT = "ridgeline:arrange";
/** Same channel, for flipping the page between its two shapes. */
export const LAYOUT_EVENT = "ridgeline:layout";

export default function HeroKebab({ items = [], arrange = false, layoutMode, menuLabel = "Page actions" }: {
  items?: HeroKebabItem[];
  arrange?: boolean;
  /**
   * The shape this page is in right now, when it has two. Present, the menu
   * offers the OTHER one - a server page can pass the current mode because it
   * already read the saved arrangement, and the flip itself rides the event.
   */
  layoutMode?: "rail" | "bands";
  menuLabel?: string;
}) {
  const all: HeroKebabItem[] = [
    ...items,
    ...(layoutMode ? [{
      label: layoutMode === "rail" ? "Use the band layout" : "Use the rail layout",
      onClick: () => window.dispatchEvent(new Event(LAYOUT_EVENT)),
    }] : []),
    ...(arrange ? [{ label: "Rearrange panels", onClick: () => window.dispatchEvent(new Event(ARRANGE_EVENT)) }] : []),
  ];
  if (all.length === 0) return null;
  return (
    <Dropdown label={<span aria-hidden="true">⋯</span>} ariaLabel={menuLabel} summaryClass="kebab">
      {all.map((a) =>
        a.href ? (
          <a key={a.label} href={a.href} style={a.tone === "bad" ? { color: "var(--t-bad-fg)" } : undefined}>
            {a.label}
          </a>
        ) : (
          <button key={a.label} type="button" onClick={a.onClick}
            style={a.tone === "bad" ? { color: "var(--t-bad-fg)" } : undefined}>
            {a.label}
          </button>
        ),
      )}
    </Dropdown>
  );
}
