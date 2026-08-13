import Link from "next/link";

/**
 * Settings, split by how often each part changes and who tends it.
 * Configuration is the instance itself - set up once. Personnel is who's on it -
 * changes weekly. Catalog is the equipment reference and Procedures is what each
 * piece of equipment gets done to it: both curated forever, by the owner and
 * their staff alike. Admin is the operator's override - every system's ownership
 * and visibility in one place - so it sits last and stays the owner's alone.
 */
export default function SettingsTabs({ active, isOwner = true, isPlatform = true }: {
  active: "configuration" | "personnel" | "catalog" | "procedures" | "admin" | "tenants";
  isOwner?: boolean;
  /**
   * Staff of the operator that runs the instance. Configuration is the instance's
   * own - its name, its modules - so another service company's owner never sees
   * the tab rather than seeing it and being turned away at the door.
   */
  isPlatform?: boolean;
}) {
  const tabs = [
    { key: "configuration", href: "/settings", label: "Configuration", ownerOnly: true, platformOnly: true },
    { key: "personnel", href: "/settings/personnel", label: "Personnel", ownerOnly: true },
    { key: "catalog", href: "/settings/catalog", label: "Catalog", ownerOnly: false },
    { key: "procedures", href: "/settings/procedures", label: "Procedures", ownerOnly: false },
    { key: "admin", href: "/settings/admin", label: "Admin", ownerOnly: true },
    // The instance's tenants - only the company running it has any business here.
    { key: "tenants", href: "/settings/tenants", label: "Service companies", ownerOnly: true, platformOnly: true },
  ] as const;
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
      {tabs.filter((t) => (isOwner || !t.ownerOnly) && (isPlatform || !("platformOnly" in t && t.platformOnly))).map((t) => (
        <Link key={t.key} href={t.href} className={t.key === active ? "btn sm accent" : "btn sm"}
          style={{ textDecoration: "none" }} aria-current={t.key === active ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
