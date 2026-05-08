import { Users } from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/section";
import { ComingSoon } from "@/components/settings/coming-soon";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Team & access · Settings",
};

export default function TeamSettingsPage() {
  const meta = SETTINGS_BY_KEY.team;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <ComingSoon
        icon={Users}
        title="Team & access controls are on the way"
        description="Today every workspace has a single login. Soon you'll be able to invite teammates, assign roles, and audit who did what — without losing the simplicity of single-user setups."
        bullets={[
          "Invite teammates by email with role-scoped access",
          "Roles for Operations, Finance, Read-only, and Owner",
          "Recent access events and active session list",
          "SSO via Google Workspace and Microsoft 365",
        ]}
      />
    </>
  );
}
