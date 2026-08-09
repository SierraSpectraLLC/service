/**
 * The portal's own absolute URL, for links that leave the app: emails, QR
 * labels. Empty string when neither APP_URL nor a Vercel production URL is
 * set (local dev) - callers must degrade, not emit half a link.
 */
export const appUrl = () =>
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
