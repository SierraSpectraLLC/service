"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import SectionRail from "@/components/SectionRail";
import { settingsEntryFor, visibleSettingsGroups } from "@/lib/settingsNav";

/**
 * The settings navigation - the section rail, like every other section.
 *
 * It used to be a third pattern: a 240px sidebar of its own, and on a phone a
 * <details> drilldown, neither of which looked or behaved like the financial
 * rail beside it or the tab rows elsewhere. Settings is a section like the
 * money side of the app is a section, so it gets the section's chrome: a list
 * down the left on a desktop, a sideways chip strip on a phone, the current
 * room filled. Same role filtering as before, so a staff member still sees
 * fewer entries rather than a different component.
 */
export default function SettingsNav({ isOwner, isPlatform, isTrailAdmin = false }: {
  isOwner: boolean;
  isPlatform: boolean;
  /** The one named address that may read the trail. See lib/trail. */
  isTrailAdmin?: boolean;
}) {
  const path = usePathname();
  const groups = visibleSettingsGroups(isOwner, isPlatform, isTrailAdmin);
  const current = settingsEntryFor(path);

  return (
    <SectionRail label="Settings sections" groups={groups.map((g) => ({
      label: g.name,
      entries: g.entries.map((e) => ({
        href: e.href, label: e.label, active: current?.entry.href === e.href,
      })),
    }))} />
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
