import Link from "next/link";
import { LifeBuoy, Mail, MessageCircle, Activity } from "lucide-react";
import { getBrandingSync } from "@ecom/branding";

/**
 * Persistent support surface for the dashboard.
 *
 * The audit (04 §10, 06 B8, 05 Tier 1.5) flags that support is invisible:
 * a Bangladeshi merchant whose automation looks stuck at 11 PM has no
 * obvious "who do I message" path — only a fire-and-forget feedback form
 * with no promised reply. For a 10–20 merchant private beta, a visible
 * WhatsApp + email + status line with an honest response expectation is
 * one of the highest trust-per-effort changes available.
 *
 * Server component, zero I/O: `getBrandingSync()` is defaults + ENV only.
 * The WhatsApp number is ENV-driven so it can differ per deploy without a
 * code change; if unset we fall back to the support page link rather than
 * render a dead button.
 */
export function SupportFooter() {
  const brand = getBrandingSync() as {
    supportEmail?: string;
    supportUrl?: string;
    statusPageUrl?: string;
  };
  const supportEmail = brand.supportEmail ?? "support@confirmx.ai";
  const supportUrl = brand.supportUrl ?? "https://confirmx.ai/support";
  const statusUrl = brand.statusPageUrl;

  const waDigits = (process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP ?? "").replace(
    /[^\d]/g,
    "",
  );
  const whatsappHref = waDigits
    ? `https://wa.me/${waDigits}`
    : supportUrl;

  return (
    <footer className="mt-10 border-t border-stroke/10 pt-5">
      <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-fg-muted">
          <LifeBuoy className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
          <span>
            Private-beta support — we usually reply within a few hours during
            Dhaka business hours (Sun–Thu).
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-fg hover:text-brand"
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            WhatsApp
          </a>
          <a
            href={`mailto:${supportEmail}`}
            className="inline-flex items-center gap-1.5 font-medium text-fg hover:text-brand"
          >
            <Mail className="h-4 w-4" aria-hidden />
            {supportEmail}
          </a>
          {statusUrl ? (
            <Link
              href={statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-fg-muted hover:text-fg"
            >
              <Activity className="h-4 w-4" aria-hidden />
              System status
            </Link>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
