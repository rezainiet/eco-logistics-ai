import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AdminTemplateEditor } from "@/components/landing/admin-template-editor";

export default async function LandingTemplateAdminDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect(`/login?callbackUrl=/admin/landing-templates/${params.id}`);
  if (session.user?.role !== "admin") redirect("/dashboard");
  return <AdminTemplateEditor templateId={params.id} />;
}
