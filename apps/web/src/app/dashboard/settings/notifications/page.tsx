import { Bell } from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/section";
import { ComingSoon } from "@/components/settings/coming-soon";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Notifications · Settings",
};

export default function NotificationsSettingsPage() {
  const meta = SETTINGS_BY_KEY.notifications;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <ComingSoon
        icon={Bell}
        title="Notification preferences are on the way"
        description="Today every operational alert is hard-coded. Soon you'll choose which events reach you, on which channel, and at what hour of the day."
        bullets={[
          "Past-due payment alerts via email, SMS, or WhatsApp",
          "Fraud-review escalations with custom risk thresholds",
          "Daily and weekly recovery-pipeline digests",
          "Per-courier failure alerts with replay links",
          "Quiet hours and per-channel mute",
        ]}
      />
    </>
  );
}
