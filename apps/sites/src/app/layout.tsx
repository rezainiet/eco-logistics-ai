import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Hind_Siliguri, Noto_Serif_Bengali } from "next/font/google";
import { isLocale } from "@ecom/landing";
import { resolveCurrentHost } from "@/lib/resolve";
import "./globals.css";

/**
 * Bengali web fonts, self-hosted by next/font (no request to Google at
 * runtime). The renderer's font stacks reference these variables, so the
 * public page, the editor preview and the admin template preview — all
 * rendered by this app — use exactly the same faces.
 *   Hind Siliguri      — Bangla sans (UI, headings, e-commerce)
 *   Noto Serif Bengali — Bangla serif (editorial / premium templates)
 */
const bnSans = Hind_Siliguri({
  subsets: ["bengali", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--lp-font-bn-sans",
  display: "swap",
});

const bnSerif = Noto_Serif_Bengali({
  subsets: ["bengali"],
  weight: ["400", "600", "700"],
  variable: "--lp-font-bn-serif",
  display: "swap",
});

async function documentLang(): Promise<string> {
  const h = headers();
  const label = h.get("x-lp-label");
  const pathLocale = h.get("x-lp-locale") || null;
  if (!label) return "en";
  const r = await resolveCurrentHost(label, pathLocale);
  if (r.kind === "ok") return r.locale;
  return isLocale(pathLocale) ? pathLocale : "en";
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await documentLang();
  return (
    <html lang={lang} className={`${bnSans.variable} ${bnSerif.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
