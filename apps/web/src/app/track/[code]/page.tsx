import type { Metadata } from "next";
import Link from "next/link";
import { fetchPublicTracking } from "./_lib/fetch";
import { formatBdt, safeHexColor, statusPresentation } from "./_lib/status";
import { resolveLang, STRINGS, localizeStatus } from "./_lib/i18n";
import { MerchantHeader } from "./_components/merchant-header";
import { StatusHero } from "./_components/status-hero";
import { Timeline } from "./_components/timeline";
import { SupportActions } from "./_components/support-actions";
import { NotFoundCard } from "./_components/not-found";

interface PageProps {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const result = await fetchPublicTracking(code);
  if (result.kind !== "ok") {
    return {
      title: "Tracking — order not found",
      robots: { index: false, follow: false },
    };
  }
  const presentation = statusPresentation(result.data.status);
  return {
    title: `${presentation.label} — order ${result.data.orderNumber}`,
    description: `Tracking for order ${result.data.orderNumber} from ${result.data.branding.displayName}.`,
    // Tracking links should never be indexed — they're per-order share links.
    robots: { index: false, follow: false },
  };
}

export default async function TrackingPage({ params, searchParams }: PageProps) {
  const { code } = await params;
  const { lang: langParam } = await searchParams;
  const lang = resolveLang(langParam);
  const t = STRINGS[lang];
  const result = await fetchPublicTracking(code);

  if (result.kind === "not_found" || result.kind === "error") {
    // Soft-fail look identical to "not found" — never leak internal errors
    // to anonymous customers. The merchant's ops team will see this in
    // logs/Sentry; the customer just sees a friendly message.
    return <NotFoundCard code={code} lang={lang} />;
  }

  const data = result.data;
  const accent = safeHexColor(data.branding.primaryColor);
  const rawPresentation = statusPresentation(data.status);
  const localized = localizeStatus(
    lang,
    rawPresentation.label,
    rawPresentation.hint,
  );
  const presentation = {
    ...rawPresentation,
    label: localized.label,
    hint: localized.hint,
  };
  const otherLang = lang === "bn" ? "en" : "bn";

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex items-start justify-between gap-3">
          <MerchantHeader
            displayName={data.branding.displayName}
            logoUrl={data.branding.logoUrl}
            primaryColor={accent}
          />
          <Link
            href={`/track/${encodeURIComponent(code)}?lang=${otherLang}`}
            prefetch={false}
            className="mt-1 shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            {t.switchToOther}
          </Link>
        </div>

        <div className="mt-6">
          <StatusHero
            presentation={presentation}
            primaryColor={accent}
            steps={t.steps}
          />
        </div>

        <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            {t.orderDetails}
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">{t.orderId}</dt>
              <dd className="font-mono text-gray-900">{data.orderNumber}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">{t.trackingCode}</dt>
              <dd className="font-mono text-gray-900">{data.trackingNumber}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">{t.cod}</dt>
              <dd className="font-semibold text-gray-900">{formatBdt(data.cod)}</dd>
            </div>
            {data.courier ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">{t.courier}</dt>
                <dd className="capitalize text-gray-900">{data.courier}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">{t.deliveryAddress}</dt>
              <dd className="text-right text-gray-900">{data.maskedAddress}</dd>
            </div>
            {data.estimatedDelivery ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">{t.estimatedDelivery}</dt>
                <dd className="text-gray-900">
                  {new Date(data.estimatedDelivery).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                  })}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            {t.timeline}
          </h2>
          <div className="mt-4">
            <Timeline events={data.events} />
          </div>
        </section>

        <SupportActions
          supportPhone={data.branding.supportPhone}
          supportEmail={data.branding.supportEmail}
          primaryColor={accent}
          lang={lang}
        />

        <footer className="mt-10 text-center text-xs text-gray-400">
          <p>{t.privacyNote}</p>
        </footer>
      </div>
    </main>
  );
}
