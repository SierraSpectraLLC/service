import Link from "next/link";

/**
 * Three parts of Settings, split by how often each one changes. Configuration
 * is the instance itself - set up once. Personnel is who's on it - changes
 * weekly. Catalog is the equipment reference - curated forever.
 */
export default function SettingsTabs({ active }: { active: "configuration" | "personnel" | "catalog" }) {
  const tabs = [
    { key: "configuration", href: "/settings", label: "Configuration" },
    { key: "personnel", href: "/settings/personnel", label: "Personnel" },
    { key: "catalog", href: "/settings/catalog", label: "Catalog" },
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
