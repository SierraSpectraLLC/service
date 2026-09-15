import { redirect } from "next/navigation";

/**
 * The brief's URL for a pay link. The code already had one: a share link is
 * the credential, the org on its row is the authorization, and /share/[token]
 * is where a client with no login reads the invoice and pays it by card or
 * bank transfer. One door, so this is a sign pointing at it rather than a
 * second room with its own lock.
 */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  redirect(`/share/${encodeURIComponent(token)}`);
}
