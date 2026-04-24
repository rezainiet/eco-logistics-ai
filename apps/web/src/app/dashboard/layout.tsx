import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { SubscriptionBanner } from "@/components/billing/subscription-banner";
import { Toaster } from "@/components/ui/toast";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard");

  const userLabel = session.user?.name ?? session.user?.email ?? "Merchant";

  return (
    <div className="flex min-h-screen bg-[#0B0E1A]">
      <Sidebar userLabel={userLabel} />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center border-b border-[rgba(209,213,219,0.08)] bg-[#0B0E1A]/80 px-4 py-3 backdrop-blur md:hidden">
          <div className="ml-12 text-sm font-semibold text-[#F3F4F6]">Logistics</div>
        </div>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">
          <SubscriptionBanner />
          {children}
        </div>
      </main>
      <Toaster />
    </div>
  );
}
