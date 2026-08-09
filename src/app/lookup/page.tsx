import { redirect } from "next/navigation";

/**
 * Serial lookup folded into search: one box handles both your own records and
 * an exact serial belonging to someone else's workspace. This route stays so
 * bookmarks and older links keep working.
 */
export default async function LookupPage({ searchParams }: { searchParams: Promise<{ sn?: string }> }) {
  const { sn } = await searchParams;
  redirect(sn ? `/search?q=${encodeURIComponent(sn)}` : "/search");
}
