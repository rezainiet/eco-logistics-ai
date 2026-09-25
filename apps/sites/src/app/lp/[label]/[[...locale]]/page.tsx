import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALE_LABELS, type Locale } from "@ecom/landing";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { indexingAllowed } from "@/lib/config";
import { resolveCurrentHost } from "@/lib/resolve";

// Always resolve against the API: publish/unpublish must take effect
// immediately and one tenant's response must never be reused for another.
export const dynamic = "force-dynamic";

type Props = { params: { label: string; locale?: string[] } };

function pathLocale(params: Props["params"]): string | null {
  const seg = params.locale;
  if (!seg || seg.length === 0) return null;
  return seg.length === 1 ? seg[0]! : "-";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolveCurrentHost(params.label, pathLocale(params));
  if (r.kind !== "ok") return { title: "Page not found", robots: { index: false, follow: false } };
  const env = assetEnv(r.assetBaseUrl);
  const ogImage = r.seo.ogImageAssetId ? env.assetUrl(r.seo.ogImageAssetId) : null;
  const favicon = r.seo.faviconAssetId ? env.assetUrl(r.seo.faviconAssetId) : null;
  const index = indexingAllowed() && !r.seo.noindex;
  return {
    title: r.seo.title,
    description: r.seo.description || undefined,
    robots: { index, follow: index },
    openGraph: {
      title: r.seo.ogTitle,
      description: r.seo.ogDescription || undefined,
      type: "website",
      locale: r.locale === "bn" ? "bn_BD" : "en_US",
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  };
}

/** Minimal language switch, shown only when a page is published in several languages. */
function LanguageSwitch({ current, locales, defaultLocale }: { current: Locale; locales: Locale[]; defaultLocale: Locale }) {
  if (locales.length < 2) return null;
  return (
    <nav aria-label="Language" className="flex justify-end gap-1 bg-neutral-100 px-4 py-1.5 text-sm">
      {locales.map((l) => (
        <a
          key={l}
          href={l === defaultLocale ? "/" : `/${l}`}
          lang={l}
          aria-current={l === current ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded px-3 ${l === current ? "bg-white font-semibold shadow-sm" : "text-neutral-600 hover:text-neutral-900"}`}
        >
          {LOCALE_LABELS[l].native}
        </a>
      ))}
    </nav>
  );
}

export default async function PublicLandingPage({ params }: Props) {
  const r = await resolveCurrentHost(params.label, pathLocale(params));
  if (r.kind === "unavailable") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-6 text-center text-neutral-800">
        <div>
          <h1 className="text-2xl font-bold">This page is temporarily unavailable</h1>
          <p className="mt-2 text-neutral-500">Please check back later.</p>
        </div>
      </main>
    );
  }
  if (r.kind !== "ok") notFound();
  return (
    <>
      <LanguageSwitch current={r.locale} locales={r.locales} defaultLocale={r.defaultLocale} />
      <LandingRenderer spec={r.spec} content={r.content} locale={r.locale} env={assetEnv(r.assetBaseUrl)} className="min-h-screen" />
    </>
  );
}
