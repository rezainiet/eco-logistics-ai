import { SettingsPageHeader } from "@/components/settings/section";
import { WorkspaceSection } from "../_sections/workspace-section";
import { SETTINGS_BY_KEY } from "@/components/settings/nav-config";

export const metadata = {
  title: "Workspace · Settings",
};

export default function WorkspaceSettingsPage() {
  const meta = SETTINGS_BY_KEY.workspace;
  return (
    <>
      <SettingsPageHeader title={meta.label} description={meta.description} />
      <WorkspaceSection />
    </>
  );
}
