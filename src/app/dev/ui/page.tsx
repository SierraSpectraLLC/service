import { notFound } from "next/navigation";
import DevUiGallery from "@/components/dev/DevUiGallery";

/**
 * The living component inventory: every kit piece with fixture props, each
 * dialog reachable by ?d= key (see DevUiGallery for the list). Development
 * only - a production build 404s here, so nothing fixture-shaped can ever
 * be mistaken for the app.
 */
export const dynamic = "force-dynamic";

export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DevUiGallery />;
}
