import Link from "next/link";

/**
 * Two halves of Settings. Configuration is the instance itself - what it's
 * called, what it runs, the words it uses. Personnel is who's on it. They change
 * on completely different schedules, which is why they aren't one page.
 */
export default function SettingsTabs({ active }: { active: "configuration" | "personnel" }) {
  const tabs = [
    { key: "configuration", href: "/settings", label: "Configuration" },
    { key: "personnel", href: "/settings/personnel", label: "Personnel" },
  ] as const;
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={t.key === active ? "btn sm accent" : "btn sm"}
          style={{ textDecoration: "none" }} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
