import { AlertTriangle, Network, ShieldCheck } from "lucide-react";

export interface NetworkSignal {
  merchantCount: number;
  deliveredCount: number;
  rtoCount: number;
  cancelledCount: number;
  rtoRate: number | null;
  firstSeenAt: string | Date | null;
  lastSeenAt: string | Date | null;
  matchedOn: "phone+address" | "phone" | "address" | "none";
}

/**
 * Cross-merchant fraud network indicator.
 *
 * Shown on the fraud-review row (and detail page) when the customer's
 * phone or address has been seen at multiple OTHER merchants. Aggregate
 * only — never reveals which merchants. Hidden when no network evidence
 * exists.
 */
export function NetworkSignalPill({ network }: { network: NetworkSignal | null | undefined }) {
  if (!network || network.merchantCount === 0) return null;

  const rtoPct =
    network.rtoRate !== null ? Math.round(network.rtoRate * 100) : null;

  const tone =
    rtoPct !== null && rtoPct >= 50
      ? "bg-danger-subtle text-danger"
      : rtoPct !== null && rtoPct >= 25
        ? "bg-warning-subtle text-warning"
        : "bg-info-subtle text-info";

  const Icon = rtoPct !== null && rtoPct >= 50 ? AlertTriangle : Network;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
      title={
        rtoPct !== null
          ? `Seen at ${network.merchantCount} other merchants — ${network.rtoCount} RTOs out of ${network.deliveredCount + network.rtoCount} completed`
          : `Seen at ${network.merchantCount} other merchants`
      }
    >
      <Icon className="h-3 w-3" aria-hidden />
      Network: {network.merchantCount}+ merchants
      {rtoPct !== null ? ` • RTO ${rtoPct}%` : null}
    </span>
  );
}

/**
 * Larger detail card variant for the review page right-rail. Includes
 * first-seen / last-seen dates and a short hint about what the signal
 * means + how the merchant can override it.
 */
export function NetworkSignalCard({ network }: { network: NetworkSignal | null | undefined }) {
  if (!network || network.merchantCount === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-3">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          No cross-merchant signal — this fingerprint has not been observed
          at other merchants in the network.
        </div>
      </div>
    );
  }

  const rtoPct =
    network.rtoRate !== null ? Math.round(network.rtoRate * 100) : null;

  return (
    <div className="rounded-md border border-warning/30 bg-warning/8 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        Cross-merchant fraud network
      </div>
      <dl className="mt-2 space-y-1 text-xs text-fg">
        <div className="flex justify-between">
          <dt className="text-fg-muted">Seen at</dt>
          <dd>{network.merchantCount}+ other merchants</dd>
        </div>
        {rtoPct !== null ? (
          <div className="flex justify-between">
            <dt className="text-fg-muted">Failed-delivery rate</dt>
            <dd>
              {rtoPct}% ({network.rtoCount} of {network.deliveredCount + network.rtoCount})
            </dd>
          </div>
        ) : null}
        {network.cancelledCount > 0 ? (
          <div className="flex justify-between">
            <dt className="text-fg-muted">Cancelled</dt>
            <dd>{network.cancelledCount}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-fg-muted">Matched on</dt>
          <dd className="capitalize">{network.matchedOn.replace("+", " + ")}</dd>
        </div>
        {network.lastSeenAt ? (
          <div className="flex justify-between">
            <dt className="text-fg-muted">Last seen</dt>
            <dd>{new Date(network.lastSeenAt).toLocaleDateString("en-GB")}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-2 text-[11px] text-fg-faint">
        Aggregate only — individual merchants are never disclosed. Merchants
        can disable network signals in fraud settings.
      </p>
    </div>
  );
}
