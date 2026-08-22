import { currentUser } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import SettingsNav, { SettingsCrumb } from "@/components/SettingsNav";

/**
 * The settings shell: one sidebar (drilldown on a phone) and one breadcrumb
 * for every page under /settings, so no settings page carries its own tab
 * row again. Pages keep their own auth guards - this only draws the frame,
 * and draws none at all for a signed-out request on its way to /login.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) return children;
  const isOwner = user.role === "owner";
  const isPlatform = isPlatformStaff(tenantViewer(user));

  return (
    <div className="container settings">
      <div className="settings-shell">
        <SettingsNav isOwner={isOwner} isPlatform={isPlatform} />
        <div className="settings-main">
          <SettingsCrumb />
          {children}
        </div>
      </div>
    </div>
  );
}
