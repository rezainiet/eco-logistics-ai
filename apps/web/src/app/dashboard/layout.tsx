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
import { I18nProvider } from "@/lib/i18n";
import { Toaster } from "@/components/ui/toast";
import { Providers } from "@/app/providers";
import { ActivationToaster } from "@/components/onboarding/activation-moments";
import { IncidentBanner } from "@/components/dashboard/incident-banner";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard");

  const userLabel = session.user?.name ?? session.user?.email ?? "Merchant";

  return (
    <Providers>
    <I18nProvider>
      <CommandPaletteProvider>
      <BrandingProvider>
      <TokenRefreshKeeper />
      {/* Activation toaster — fires once-per-merchant celebrations the
          moment Cordon delivers value (first order ingested, first risky
          order detected). Renders nothing visible itself; relies on the
          shared <Toaster /> below. localStorage-gated. */}
      <ActivationToaster />
      <div className="flex min-h-screen bg-surface-base">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar userLabel={userLabel} />
          <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8 md:pt-8">
            {/* Operational incident banner — env-var driven, renders
                only when NEXT_PUBLIC_INCIDENT_BANNER_TEXT is set.
                Critical-level banners are non-dismissible; info /
                warning persist a per-message dismissal in
                localStorage. Sits above all other banners so a real
                incident is the first thing the merchant sees. */}
            <IncidentBanner />
            <DashboardBanners />
            {children}
          </div>
        </main>
        <MobileBottomNav />
        <Toaster />
      </div>
      </BrandingProvider>
    </CommandPaletteProvider>
    </I18nProvider>
    </Providers>
  );
}
