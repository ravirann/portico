import { redirect } from "next/navigation";

/** Member management lives on the Settings page now (its "Members" section)
 *  — this route survives only so old links and muscle memory keep working. */
export default function MembersPage() {
  redirect("/settings#members");
}
