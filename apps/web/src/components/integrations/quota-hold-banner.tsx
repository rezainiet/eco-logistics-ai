import Link from "next/link";
import { ArrowUpRight, Inbox, Loader2, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { quotaHoldBanner, UPGRADE_HREF, type OrderQuotaLike } from "@/lib/integrations/quota-hold";

/**
 * Orders held because the monthly order quota is used up: what happened,
 * that nothing is lost, and the next step — upgrade while there's no room,
 * replay once there is. Presentational; the Issues page owns the data.
 */
export function QuotaHoldBanner({
  heldCount,
  quota,
  onReplay,
  replaying,
}: {
  heldCount: number;
  quota: OrderQuotaLike | null | undefined;
  onReplay: () => void;
  replaying: boolean;
}) {
  const banner = quotaHoldBanner(heldCount, quota);
  if (!banner) return null;
  const tone =
    banner.tone === "success" ? "border-success/30 bg-success-subtle text-success" : "border-warning/30 bg-warning-subtle text-warning";
  return (
    <div className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between ${tone}`} data-quota-hold={banner.tone}>
      <div className="flex min-w-0 items-start gap-2">
        <Inbox className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">{banner.title}</p>
          <p className="text-xs text-fg-muted">{banner.body}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {banner.showUpgrade ? (
          <Link
            href={UPGRADE_HREF}
            className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:bg-brand/90"
          >
            Upgrade plan
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
        {banner.showReplay ? (
          <Button size="sm" onClick={onReplay} disabled={replaying}>
            {replaying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="mr-1.5 h-3.5 w-3.5" />}
            Replay held orders
          </Button>
        ) : null}
      </div>
    </div>
  );
}
