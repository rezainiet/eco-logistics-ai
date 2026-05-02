import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "info" | "success" | "warning" | "danger" | "pending";

const TONE_STYLES: Record<StatusTone, { wrap: string; icon: typeof Info }> = {
  info:    { wrap: "border-info/30 bg-info/8 text-info",       icon: Info },
  success: { wrap: "border-success/30 bg-success/8 text-success", icon: CheckCircle2 },
  warning: { wrap: "border-warning/30 bg-warning/8 text-warning", icon: AlertTriangle },
  danger:  { wrap: "border-danger/30 bg-danger/8 text-danger",   icon: AlertCircle },
  pending: { wrap: "border-fg-muted/30 bg-surface text-fg-muted", icon: Loader2 },
};

interface StatusBannerProps {
  tone: StatusTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

/**
 * Standardised app banner — friendly copy, tone-coloured, optional CTA.
 * Replaces the ad-hoc <div className="rounded-md border…"> blocks scattered
 * around the existing dashboard pages.
 */
export function StatusBanner({ tone, title, children, action }: StatusBannerProps) {
  const { wrap, icon: Icon } = TONE_STYLES[tone];
  return (
    <div className={`flex items-start gap-3 rounded-md border ${wrap} p-3`}>
      <Icon className={`mt-0.5 h-4 w-4 ${tone === "pending" ? "animate-spin" : ""}`} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{title}</div>
        {children ? <div className="mt-0.5 text-fg-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Pre-baked friendly banners for the three failure modes the merchant
 * actually hits in production: SMS, booking, payment.
 */
export function SmsFailureBanner({ phone, error }: { phone?: string; error?: string }) {
  return (
    <StatusBanner tone="danger" title="Confirmation SMS could not be delivered">
      <p>
        We tried to text {phone ?? "the customer"} the order confirmation but
        the carrier rejected it{error ? ` (${error})` : ""}. The order was
        moved to your review queue — call the customer or confirm manually.
      </p>
    </StatusBanner>
  );
}

export function BookingFailureBanner({ courier, error }: { courier?: string; error?: string }) {
  return (
    <StatusBanner tone="danger" title="Auto-booking failed">
      <p>
        We tried to book this order with {courier ?? "the courier"} three
        times{error ? ` (${error})` : ""}. The order is still confirmed — open
        it to retry with another courier or contact your courier KAM.
      </p>
    </StatusBanner>
  );
}

export function PaymentPendingBanner() {
  return (
    <StatusBanner tone="warning" title="Payment under review">
      <p>
        Your payment was submitted and our team is verifying it. You will be
        notified by email when your plan is activated. This usually takes
        under an hour during business hours.
      </p>
    </StatusBanner>
  );
}
