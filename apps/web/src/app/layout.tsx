import type { Metadata } from "next";
import { ReactNode } from "react";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import {
  buildRootMetadata,
  getBrandingSync,
  renderBrandingCss,
} from "@ecom/branding";
import "./globals.css";

/**
 * Root layout — html/body shell ONLY. NO providers here.
 *
 * Fonts: self-hosted via next/font/google. Each declares a CSS variable
 * exposed on <html>, so stylesheets can reference `var(--font-inter)`,
 * `var(--font-serif)`, `var(--font-mono)` without any external Google
 * Fonts request, eliminating the render-blocking link and the 90+
 * font-face declarations that came with the hosted CSS.
 *
 * Providers (SessionProvider, TRPCProvider, QueryClientProvider) live
 * one level down inside the layouts that need them: dashboard, admin,
 * (auth), reset-password. The marketing surface stays free of auth/tRPC
 * weight.
 *
 * Branding: this layout reads `getBrandingSync()` (defaults + ENV
 * overrides — no DB, no async, SSR-safe under any failure mode) and
 * (a) builds Next.js Metadata via `buildRootMetadata`, and (b) injects
 * a `<style>` block with the brand CSS variables. globals.css ships
 * the same defaults as a static fallback so the page is coherent even
 * if this layout never ran. Live admin edits propagate via the deeper
 * dashboard / admin layouts which read the DB-backed resolver.
 */

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  variable: "--font-serif",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const _branding = getBrandingSync();

export const metadata: Metadata = buildRootMetadata(_branding, {
  publicWebUrl: process.env.NEXT_PUBLIC_WEB_URL,
}) as Metadata;

const _brandingCss = renderBrandingCss(_branding);

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${serif.variable} ${mono.variable}`}
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: _brandingCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
