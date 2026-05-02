import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DashboardHero } from "@/components/onboarding/dashboard-hero";
import { OnboardingChecklist } from "@/components/onboarding/onboarding-checklist";

export const metadata = { title: "Getting started" };

export default async function GettingStartedPage() {
  // Hand the merchant's name to <DashboardHero> at SSR so the greeting
  // doesn't flicker from "Good evening" to "Good evening, Reza" on
  // hydration. The component still calls useSession() to keep the value
  // fresh once the session refreshes.
  const session = await getServerSession(authOptions);
  const initialName =
    session?.user?.name ?? session?.user?.email ?? undefined;

  return (
    <main className="space-y-5">
      <DashboardHero initialName={initialName} />
      <OnboardingChecklist collapseWhenComplete={false} />
    </main>
  );
}
