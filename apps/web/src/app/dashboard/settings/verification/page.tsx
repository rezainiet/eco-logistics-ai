import { SettingsPageHeader } from "@/components/settings/section";
import { VerificationRules } from "@/components/settings/verification-rules";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Verification rules · Settings",
};

export default function VerificationSettingsPage() {
  const meta = SETTINGS_BY_KEY.verification;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <VerificationRules />
    </>
  );
}
