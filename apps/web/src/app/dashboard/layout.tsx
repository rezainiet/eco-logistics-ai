import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { DashboardBanners } from "@/components/billing/dashboard-banners";
import { BrandingProvider } from "@/components/branding/branding-provider";
import { TokenRefreshKeeper } from "@/components/auth/token-refresh-keeper";
import { MobileBottomNav } from "@/components/dashboard/mobile-bottom-nav";
import { TrustStrip } from "@/components/dashboard/trust-strip";
import { I18nProvider } from "@/lib/i18n";
import { Toaster } from "@/components/ui/toast";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard");

  const userLabel = session.user?.name ?? session.user?.email ?? "Merchant";

  return (
    <I18nProvider>
      <CommandPaletteProvider>
      <BrandingProvider>
      <TokenRefreshKeeper />
      <div className="flex min-h-screen bg-surface-base">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar userLabel={userLabel} />
          <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8 md:pt-8">
            <DashboardBanners />
            {children}
            <TrustStrip />
          </div>
        </main>
        <MobileBottomNav />
        <Toaster />
      </div>
      </BrandingProvider>
    </CommandPaletteProvider>
    </I18nProvider>
  );
}
