import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { audit } from "@/lib/audit";
import { currentUser, myTenantOrgId } from "@/lib/authz";
import { exchangeCode, graphBaseUrl, graphConfig } from "@/lib/msgraph";
import { open, sameSecret } from "@/lib/secretBox";
import { saveConnection } from "@/lib/cloudStore";
import { HANDSHAKE_COOKIE } from "../connect/route";

export const dynamic = "force-dynamic";

/** Back to the studio, saying what happened, rather than to a blank page. */
const back = (note: string) =>
  NextResponse.redirect(`${graphBaseUrl()}/pdf?cloud=${encodeURIComponent(note)}`);

/**
 * Where Microsoft sends somebody back to.
 *
 * Everything here is a check on a request that arrived from outside. In order:
 * the person is still signed in; the handshake cookie is ours and readable; the
 * state matches the one we issued; and the account finishing this is the account
 * that started it. Only then is a code worth spending.
 *
 * A refusal at any point is a redirect carrying plain English, not a status
 * code - the person is in a browser, mid-task, and has no way to read a 400.
 */
export async function GET(req: Request) {
  const cfg = graphConfig();
  if (!cfg) return back("unconfigured");

  const jar = await cookies();
  const raw = jar.get(HANDSHAKE_COOKIE)?.value;
  jar.delete(HANDSHAKE_COOKIE);          // one attempt per handshake, always

  const u = await currentUser();
  if (!u) return back("signin");

  const url = new URL(req.url);
  // Microsoft says no by redirecting here with a reason, not by failing to.
  const denied = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (denied) return back(denied.split("\n")[0].slice(0, 200));

  const started = open(raw ?? "");
  if (!started) return back("expired");
  let issued: { state?: string; verifier?: string; email?: string } = {};
  try { issued = JSON.parse(started); } catch { return back("expired"); }

  const state = url.searchParams.get("state") ?? "";
  if (!issued.state || !sameSecret(issued.state, state)) return back("mismatch");
  // The connection is filed under an email, so the wrong one here files somebody
  // else's OneDrive under this account.
  if (issued.email !== u.email) return back("wrongaccount");

  const code = url.searchParams.get("code") ?? "";
  if (!code || !issued.verifier) return back("nocode");

  const tokens = await exchangeCode(cfg, code, issued.verifier);
  if ("error" in tokens) return back(tokens.error.slice(0, 200));
  if (!tokens.refreshToken) return back("nooffline");

  const saved = await saveConnection(u.email, myTenantOrgId(u), tokens);
  if (saved.error) return back(saved.error.slice(0, 200));

  await audit({
    actor: u.email, entityType: "cloud", entityId: 0,
    action: "connected a Microsoft account for OneDrive and SharePoint",
  });
  return back("connected");
}
