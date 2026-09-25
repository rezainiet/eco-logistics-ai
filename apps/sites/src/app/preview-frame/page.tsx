import { assetBaseUrl, editorOrigins } from "@/lib/config";
import { PreviewFrame } from "./preview-frame";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Preview",
  robots: { index: false, follow: false },
};

/**
 * Editor preview frame (served only on the preview host). Renders whatever
 * draft an allowed dashboard origin posts to it — with the public page's
 * own renderer, CSS and fonts. It fetches nothing and holds no data.
 */
export default function PreviewFramePage() {
  return <PreviewFrame allowedOrigins={editorOrigins()} assetBaseUrl={assetBaseUrl()} />;
}
