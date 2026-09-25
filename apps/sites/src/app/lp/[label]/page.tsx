import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingRenderer, assetEnv } from "@ecom/landing/react";
import { indexingAllowed } from "@/lib/config";
import { resolveCurrentHost } from "@/lib/resolve";

// Always resolve against the API: publish/unpublish must take effect
// immediately and one tenant's response must never be reused for another.
export const dynamic = "force-dynamic";

type Props = { params: { label: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolveCurrentHost(params.label);
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
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  };
}

export default async function PublicLandingPage({ params }: Props) {
  const r = await resolveCurrentHost(params.label);
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
  return <LandingRenderer spec={r.spec} content={r.content} env={assetEnv(r.assetBaseUrl)} className="min-h-screen" />;
}
