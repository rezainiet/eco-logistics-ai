import type { Metadata } from "next";
import { fetchPublicTracking } from "./_lib/fetch";
import { formatBdt, safeHexColor, statusPresentation } from "./_lib/status";
import { MerchantHeader } from "./_components/merchant-header";
import { StatusHero } from "./_components/status-hero";
import { Timeline } from "./_components/timeline";
import { SupportActions } from "./_components/support-actions";
import { NotFoundCard } from "./_components/not-found";

interface PageProps {
  params: Promise<{ code: string }>;
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

export default async function TrackingPage({ params }: PageProps) {
  const { code } = await params;
  const result = await fetchPublicTracking(code);

  if (result.kind === "not_found") {
    return <NotFoundCard code={code} />;
  }
  if (result.kind === "error") {
    // Soft-fail look identical to "not found" — never leak internal errors
    // to anonymous customers. The merchant's ops team will see this in
    // logs/Sentry; the customer just sees a friendly message.
    return <NotFoundCard code={code} />;
  }

  const data = result.data;
  const accent = safeHexColor(data.branding.primaryColor);
  const presentation = statusPresentation(data.status);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
        <MerchantHeader
          displayName={data.branding.displayName}
          logoUrl={data.branding.logoUrl}
          primaryColor={accent}
        />

        <div className="mt-6">
          <StatusHero presentation={presentation} primaryColor={accent} />
        </div>

        <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Order details
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Order ID</dt>
              <dd className="font-mono text-gray-900">{data.orderNumber}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Tracking code</dt>
              <dd className="font-mono text-gray-900">{data.trackingNumber}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Cash on delivery</dt>
              <dd className="font-semibold text-gray-900">{formatBdt(data.cod)}</dd>
            </div>
            {data.courier ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">Courier</dt>
                <dd className="capitalize text-gray-900">{data.courier}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-gray-500">Delivery address</dt>
              <dd className="text-right text-gray-900">{data.maskedAddress}</dd>
            </div>
            {data.estimatedDelivery ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">Estimated delivery</dt>
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
            Timeline
          </h2>
          <div className="mt-4">
            <Timeline events={data.events} />
          </div>
        </section>

        <SupportActions
          supportPhone={data.branding.supportPhone}
          supportEmail={data.branding.supportEmail}
          primaryColor={accent}
        />

        <footer className="mt-10 text-center text-xs text-gray-400">
          <p>
            This is the official tracking page for your order. The address is
            masked for your privacy — only the merchant has the full delivery
            details.
          </p>
        </footer>
      </div>
    </main>
  );
}
