import { redirect } from "next/navigation";

// Checkout item definitions moved into Settings > Procedures, next to the
// maintenance templates they parallel. Old bookmarks land there.
export default function CheckoutPage() {
  redirect("/settings/procedures");
}
