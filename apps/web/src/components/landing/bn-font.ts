import { Hind_Siliguri } from "next/font/google";

/**
 * Bengali face for the editor's text inputs, so merchants type Bangla in
 * the same typeface the published page uses (the page itself is rendered by
 * apps/sites). Self-hosted by next/font; scoped to the landing screens.
 */
export const editorBnFont = Hind_Siliguri({
  subsets: ["bengali", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-editor-bn",
  display: "swap",
});

/** Classes for an input holding content in `locale`. */
export function localeInputClass(locale: string): string {
  return locale === "bn" ? "[font-family:var(--font-editor-bn),system-ui,sans-serif] leading-relaxed" : "";
}
