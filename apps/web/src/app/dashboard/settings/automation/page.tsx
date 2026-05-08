import { SettingsPageHeader } from "@/components/settings/section";
import { AutomationModePicker } from "@/components/automation/automation-mode-picker";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Automation · Settings",
};

export default function AutomationSettingsPage() {
  const meta = SETTINGS_BY_KEY.automation;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      {/*
        AutomationModePicker is the existing component shipped under
        components/automation/. It owns its own card chrome and tRPC
        wiring. Bringing it into the new IA without touching its
        internals matches the constraint "must not break tRPC
        contracts" — same procedures, same component, new URL.
      */}
      <AutomationModePicker />
    </>
  );
}
