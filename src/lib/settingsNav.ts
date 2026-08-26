/**
 * Settings, grouped by what a person came to do rather than one flat row of
 * nine look-alike buttons. Four areas:
 *
 *   Workspace       - the instance itself: name, modules, stages, branding.
 *   Catalog         - the equipment reference: models, procedures, part numbers.
 *   Organizations   - who we work with: clients, agreements, service companies.
 *   Access          - the operator's override: people, ownership, visibility.
 *
 * One table, rendered by SettingsNav as a sidebar (desktop) or a drilldown
 * list (phone), filtered by role - a staff member simply sees fewer entries
 * rather than a different component.
 */
export type SettingsEntry = {
  href: string;
  label: string;
  ownerOnly: boolean;
  platformOnly?: boolean;
  /**
   * One named address, not a role. For the one entry whose contents are other
   * companies' employees moving around their own portal - see lib/trail.
   */
  trailAdminOnly?: boolean;
};
export type SettingsGroup = { name: string; entries: SettingsEntry[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    name: "Workspace",
    entries: [{ href: "/settings", label: "Configuration", ownerOnly: true, platformOnly: true }],
  },
  {
    name: "Catalog",
    entries: [
      { href: "/settings/catalog", label: "Equipment", ownerOnly: false },
      { href: "/settings/procedures", label: "Procedures & maintenance", ownerOnly: false },
      // What each part number IS, and the paper behind the work. Curated by
      // staff rather than by the owner alone, like the rest of the catalog.
      { href: "/settings/parts", label: "Parts catalog", ownerOnly: false },
    ],
  },
  {
    name: "Organizations",
    entries: [
      { href: "/settings/organizations", label: "Clients & orgs", ownerOnly: true },
      // How money works before anybody overrides it per client, and where the
      // books leave for the accountant.
      { href: "/settings/billing", label: "Billing & payments", ownerOnly: true },
      { href: "/settings/agreements", label: "Agreements", ownerOnly: false },
      // The instance's tenants - only the company running it has business here.
      { href: "/settings/tenants", label: "Service companies", ownerOnly: true, platformOnly: true },
    ],
  },
  {
    name: "Access",
    entries: [
      { href: "/settings/admin", label: "People & ownership", ownerOnly: true },
      // Whether the people we let in ever come in. See lib/loginLog.
      { href: "/settings/activity", label: "Usage", ownerOnly: true },
      // Where the errors are. Not a role gate: see lib/trail.
      { href: "/settings/trail", label: "Trail", ownerOnly: true, platformOnly: true, trailAdminOnly: true },
    ],
  },
];

export function visibleSettingsGroups(
  isOwner: boolean, isPlatform: boolean, isTrailAdmin = false,
): SettingsGroup[] {
  return SETTINGS_GROUPS
    .map((g) => ({
      ...g,
      entries: g.entries.filter((e) =>
        (isOwner || !e.ownerOnly)
        && (isPlatform || !e.platformOnly)
        // A door nobody else may open should not be a door they can see.
        && (isTrailAdmin || !e.trailAdminOnly)),
    }))
    .filter((g) => g.entries.length > 0);
}

/** The entry a pathname belongs to: longest matching href wins, so
    /settings/organizations/12 lands on Clients & orgs, not Configuration. */
export function settingsEntryFor(path: string): { group: SettingsGroup; entry: SettingsEntry } | null {
  let best: { group: SettingsGroup; entry: SettingsEntry } | null = null;
  for (const group of SETTINGS_GROUPS) {
    for (const entry of group.entries) {
      const hit = entry.href === "/settings" ? path === "/settings"
        : path === entry.href || path.startsWith(`${entry.href}/`);
      if (hit && (!best || entry.href.length > best.entry.href.length)) best = { group, entry };
    }
  }
  return best;
}
