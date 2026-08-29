import { currentUser } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { maySeeTrail } from "@/lib/trail";
import SettingsNav, { SettingsCrumb } from "@/components/SettingsNav";

/**
 * The settings shell: the section rail and one breadcrumb for every page under
 * /settings, so no settings page carries its own tab row again. The frame is
 * the same `.rail-body` the financial section uses - settings stopped being
 * its own third navigation pattern. Pages keep their own auth guards; this
 * only draws the frame, and draws none at all for a signed-out request on its
 * way to /login.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) return children;
  const isOwner = user.role === "owner";
  const isPlatform = isPlatformStaff(tenantViewer(user));

  return (
    <div className="container settings">
      <div className="rail-body">
        <SettingsNav isOwner={isOwner} isPlatform={isPlatform}
          isTrailAdmin={maySeeTrail(user?.email)} />
        <main className="rail-main">
          <SettingsCrumb />
          {children}
        </main>
      </div>
    </div>
  );
}
