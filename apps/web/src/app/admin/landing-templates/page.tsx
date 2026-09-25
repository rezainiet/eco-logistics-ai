import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AdminTemplateList } from "@/components/landing/admin-template-list";

/**
 * /admin/landing-templates — page-level guard is a courtesy; every tRPC
 * procedure behind it re-verifies the super_admin scope.
 */
export default async function LandingTemplatesAdminPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/admin/landing-templates");
  if (session.user?.role !== "admin") redirect("/dashboard");
  return <AdminTemplateList />;
}
