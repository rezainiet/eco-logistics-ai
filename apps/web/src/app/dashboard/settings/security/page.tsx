import { SettingsPageHeader } from "@/components/settings/section";
import { SecuritySection } from "../_sections/security-section";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Security · Settings",
};

export default function SecuritySettingsPage() {
  const meta = SETTINGS_BY_KEY.security;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <SecuritySection />
    </>
  );
}
