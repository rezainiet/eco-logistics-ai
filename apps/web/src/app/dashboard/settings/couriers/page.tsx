import { SettingsPageHeader } from "@/components/settings/section";
import { CouriersSection } from "../_sections/couriers-section";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Couriers · Settings",
};

export default function CouriersSettingsPage() {
  const meta = SETTINGS_BY_KEY.couriers;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <CouriersSection />
    </>
  );
}
