"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { settingsEntryFor, visibleSettingsGroups } from "@/lib/settingsNav";

/**
 * The settings navigation: a 240px sidebar on a desktop, and on a phone a
 * drilldown - one closed row naming where you are, opening to the grouped
 * list. Replaces the two-row tab stack; same role filtering as before, so a
 * staff member sees fewer entries rather than a different component.
 */
export default function SettingsNav({ isOwner, isPlatform }: {
  isOwner: boolean;
  isPlatform: boolean;
}) {
  const path = usePathname();
  const groups = visibleSettingsGroups(isOwner, isPlatform);
  const current = settingsEntryFor(path);

  const list = groups.map((g) => (
    <span key={g.name}>
      <div className="settings-group">{g.name}</div>
      {g.entries.map((e) => (
        <Link key={e.href} href={e.href}
          className={current?.entry.href === e.href ? "active" : undefined}
          aria-current={current?.entry.href === e.href ? "page" : undefined}>
          {e.label}
        </Link>
      ))}
    </span>
  ));

  return (
    <>
      <aside className="settings-side" aria-label="Settings sections">{list}</aside>
      <details className="settings-mobnav">
        <summary>
          Settings{current ? ` · ${current.entry.label}` : ""}
          <span aria-hidden="true">▾</span>
        </summary>
        <nav aria-label="Settings sections">{list}</nav>
      </details>
    </>
  );
}

/** "Settings › Group › Page", derived from the same table - every settings
    page gets its breadcrumb without writing one. */
export function SettingsCrumb() {
  const path = usePathname();
  const current = settingsEntryFor(path);
  if (!current) return null;
  const deeper = path !== current.entry.href;
  return (
    <div className="crumb">
      <Link href={current.group.entries[0]?.href ?? "/settings"}>Settings</Link>
      {" › "}{current.group.name}{" › "}
      {deeper
        ? <><Link href={current.entry.href}>{current.entry.label}</Link>{" › "}<b>…</b></>
        : <b>{current.entry.label}</b>}
    </div>
  );
}
