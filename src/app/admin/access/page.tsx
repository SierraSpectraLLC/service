import { redirect } from "next/navigation";

// Access & ownership moved into Settings > Admin. Old bookmarks land there.
export default function AccessAdminPage() {
  redirect("/settings/admin");
}
