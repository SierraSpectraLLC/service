import Link from "next/link";

/**
 * Four parts of Settings, split by how often each changes and who tends it.
 * Configuration is the instance itself - set up once, owner only. Personnel is
 * who's on it - changes weekly, owner only. Catalog is the equipment reference
 * and Procedures is what each piece of equipment gets done to it - both
 * curated forever, by the owner and their staff alike.
 */
export default function SettingsTabs({ active, isOwner = true }: {
  active: "configuration" | "personnel" | "catalog" | "procedures";
  isOwner?: boolean;
}) {
  const tabs = [
    { key: "configuration", href: "/settings", label: "Configuration", ownerOnly: true },
    { key: "personnel", href: "/settings/personnel", label: "Personnel", ownerOnly: true },
    { key: "catalog", href: "/settings/catalog", label: "Catalog", ownerOnly: false },
    { key: "procedures", href: "/settings/procedures", label: "Procedures", ownerOnly: false },
  ] as const;
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
      {tabs.filter((t) => isOwner || !t.ownerOnly).map((t) => (
        <Link key={t.key} href={t.href} className={t.key === active ? "btn sm accent" : "btn sm"}
          style={{ textDecoration: "none" }} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
