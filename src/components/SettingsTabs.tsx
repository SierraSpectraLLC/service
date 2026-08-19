import Link from "next/link";

/**
 * Settings, grouped by what a person came to do rather than one flat row of
 * nine look-alike buttons. Four areas:
 *
 *   Workspace       - the instance itself: name, modules, stages, branding.
 *   Catalog         - the equipment reference: models, procedures, part numbers.
 *   Organizations   - who we work with: clients, agreements, service companies.
 *   Access          - the operator's override: people, ownership, visibility.
 *
 * The top row (underline tabs) answers "which area"; the pill row under it
 * answers "which page in it", and only appears when the area has more than one.
 * Both rows render from the same table, filtered by role, so a staff member
 * simply sees fewer entries rather than a different component.
 */

type TabKey = "configuration" | "organizations" | "catalog" | "procedures" | "parts" | "agreements" | "admin" | "tenants" | "activity";

type Tab = { key: TabKey; href: string; label: string; ownerOnly: boolean; platformOnly?: boolean };
type Group = { name: string; tabs: Tab[] };

const GROUPS: Group[] = [
  {
    name: "Workspace",
    tabs: [{ key: "configuration", href: "/settings", label: "Configuration", ownerOnly: true, platformOnly: true }],
  },
  {
    name: "Catalog",
    tabs: [
      { key: "catalog", href: "/settings/catalog", label: "Equipment", ownerOnly: false },
      { key: "procedures", href: "/settings/procedures", label: "Procedures & maintenance", ownerOnly: false },
      // What each part number IS, and the paper behind the work. Curated by
      // staff rather than by the owner alone, like the rest of the catalog.
      { key: "parts", href: "/settings/parts", label: "Parts book", ownerOnly: false },
    ],
  },
  {
    name: "Organizations",
    tabs: [
      { key: "organizations", href: "/settings/organizations", label: "Clients & orgs", ownerOnly: true },
      { key: "agreements", href: "/agreements", label: "Agreements", ownerOnly: false },
      // The instance's tenants - only the company running it has business here.
      { key: "tenants", href: "/settings/tenants", label: "Service companies", ownerOnly: true, platformOnly: true },
    ],
  },
  {
    name: "Access",
    tabs: [
      { key: "admin", href: "/settings/admin", label: "People & ownership", ownerOnly: true },
      // Whether the people we let in ever come in. See lib/loginLog.
      { key: "activity", href: "/settings/activity", label: "Usage", ownerOnly: true },
    ],
  },
];

export default function SettingsTabs({ active, isOwner = true, isPlatform = true }: {
  active: TabKey;
  isOwner?: boolean;
  /**
   * Staff of the operator that runs the instance. Configuration is the instance's
   * own - its name, its modules - so another service company's owner never sees
   * the tab rather than seeing it and being turned away at the door.
   */
  isPlatform?: boolean;
}) {
  const visible = (t: Tab) => (isOwner || !t.ownerOnly) && (isPlatform || !t.platformOnly);
  const groups = GROUPS
    .map((g) => ({ ...g, tabs: g.tabs.filter(visible) }))
    .filter((g) => g.tabs.length > 0);
  const activeGroup = groups.find((g) => g.tabs.some((t) => t.key === active));

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="tabs">
        {groups.map((g) => (
          <Link key={g.name} href={g.tabs[0].href} className={g === activeGroup ? "tab active" : "tab"}>
            {g.name}
          </Link>
        ))}
      </div>
      {activeGroup && activeGroup.tabs.length > 1 && (
        <div className="subtabs">
          {activeGroup.tabs.map((t) => (
            <Link key={t.key} href={t.href} className={t.key === active ? "subtab active" : "subtab"}
              aria-current={t.key === active ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
