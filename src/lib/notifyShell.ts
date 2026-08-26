import { appUrl } from "@/lib/appUrl";
import { getBrand } from "@/lib/brand";
import { emailShell, esc } from "@/lib/emailTheme";

/**
 * The envelope every notification leaves in.
 *
 * System notifications are sent by the platform, so they carry its name rather
 * than any one service company's - see lib/brand. The footer points at the
 * inbox because that is where the email switches live, except on the invite,
 * whose recipient has never signed in and has no inbox to manage yet.
 *
 * Its own module because two senders now use it: lib/notify, which sends at
 * once, and lib/outboxData, which sends a burst once it has gone quiet. A
 * held email and an immediate one have to be the same email in every respect
 * but timing, and two copies of an envelope is how they stop being.
 */
export const wrapNotification = async (
  body: string,
  opts: { preheader?: string; prefsFooter?: boolean } = {},
): Promise<string> => {
  const brand = (await getBrand()).name;
  const url = appUrl();
  const footer = `Sent by ${esc(brand)}.${opts.prefsFooter !== false && url
    ? ` <a href="${url}/inbox" style="color:#94A3B8;">Choose which emails you get</a>.`
    : ""}`;
  return emailShell({ brand, preheader: opts.preheader, body, footer });
};
