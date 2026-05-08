import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { BrandingPanel } from "@/components/admin/branding-panel";

/**
 * /admin/branding — server-side guard.
 *
 * The actual read/write happens via tRPC procedures that re-verify
 * super_admin scope on each call (see `apps/api/src/server/routers/
 * adminBranding.ts`). This page-level redirect is a friendliness
 * affordance — non-admins shouldn't see a hostile "permission denied"
 * after clicking the link in the sidebar.
 */
export default async function BrandingPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/admin/branding");
  if (session.user?.role !== "admin") redirect("/dashboard");
  return <BrandingPanel />;
}
