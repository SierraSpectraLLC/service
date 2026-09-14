// Optional modules, per instance. The Google-sheet tracker, EOD client report
// and daily digest grew out of one operator's workflow - other instances run
// without them, so their nav entries, pages and crons all consult this.
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

export type Modules = {
  sheetSync: boolean; eod: boolean; digest: boolean; remote: boolean; publicCatalog: boolean;
  /** Record pages opened and errors thrown. Off by default - see lib/trail. */
  trail: boolean;
  /**
   * The talk: the Discussions board, the Discussion panel on a system, the
   * Comments card on a work order, and person-to-person Messages. Off by
   * default. They were built as one operator's way of keeping the
   * conversation on the record, and on a shop that runs its conversations
   * elsewhere they are two icons and two cards that never get used.
   */
  discussions: boolean;
};

export const getModules = cache(async (): Promise<Modules> => {
  try {
    const [s] = await db.select({
      sheetSync: appSettings.sheetSyncEnabled, eod: appSettings.eodEnabled, digest: appSettings.digestEnabled,
      remote: appSettings.remoteEnabled, publicCatalog: appSettings.publicCatalogEnabled,
      trail: appSettings.trailEnabled, discussions: appSettings.discussionsEnabled,
    }).from(appSettings).where(eq(appSettings.id, 1));
    return {
      sheetSync: s?.sheetSync ?? false, eod: s?.eod ?? false, digest: s?.digest ?? false,
      remote: s?.remote ?? false, publicCatalog: s?.publicCatalog ?? false,
      trail: s?.trail ?? false, discussions: s?.discussions ?? false,
    };
  } catch {
    return { sheetSync: false, eod: false, digest: false, remote: false, publicCatalog: false, trail: false, discussions: false };
  }
});
