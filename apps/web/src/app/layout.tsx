import type { Metadata } from "next";
import { ReactNode } from "react";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Root layout — html/body shell ONLY. NO providers here.
 *
 * Fonts: self-hosted via next/font/google. Each declares a CSS variable
 * exposed on <html>, so stylesheets can reference `var(--font-inter)`,
 * `var(--font-serif)`, `var(--font-mono)` without any external Google Fonts
 * request, eliminating the render-blocking link and the 90+ font-face
 * declarations that came with the hosted CSS.
 *
 * Providers (SessionProvider, TRPCProvider, QueryClientProvider) live one
 * level down inside the layouts that need them: dashboard, admin, (auth),
 * reset-password. The marketing surface stays free of auth/tRPC weight.
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

export const metadata: Metadata = {
  title: "Ecommerce Logistics",
  description: "Unified logistics management platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${serif.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
