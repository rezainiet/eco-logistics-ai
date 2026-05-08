import { SettingsPageHeader } from "@/components/settings/section";
import { BrandingSection } from "@/components/branding/branding-section";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Branding · Settings",
};

export default function BrandingSettingsPage() {
  const meta = SETTINGS_BY_KEY.branding;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      {/*
        BrandingSection is the existing component shipped under
        components/branding/. It already wraps itself in a Card and
        owns its own save semantics (toast on success, profile
        invalidation). The new shell wraps it without modifying its
        internals — see the "what's NOT changed" notes in
        SETTINGS_UX_AUDIT.md § 10.
      */}
      <BrandingSection />
    </>
  );
}
