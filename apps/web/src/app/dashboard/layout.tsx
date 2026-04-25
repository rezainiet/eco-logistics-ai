import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { SubscriptionBanner } from "@/components/billing/subscription-banner";
import { VerifyEmailBanner } from "@/components/billing/verify-email-banner";
import { Toaster } from "@/components/ui/toast";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard");

  const userLabel = session.user?.name ?? session.user?.email ?? "Merchant";

  return (
    <CommandPaletteProvider>
      <div className="flex min-h-screen bg-surface-base">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar userLabel={userLabel} />
          <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
            <SubscriptionBanner />
            <VerifyEmailBanner />
            {children}
          </div>
        </main>
        <Toaster />
      </div>
    </CommandPaletteProvider>
  );
}
