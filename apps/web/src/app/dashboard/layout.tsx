import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { DashboardShell } from "@/components/dashboard/shell";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard/orders");

  return (
    <DashboardShell user={{ name: session.user?.name ?? session.user?.email ?? "Merchant" }}>
      {children}
    </DashboardShell>
  );
}
