import { Lock, Shield } from "lucide-react";

/**
 * Minimal trust strip rendered at the bottom of every dashboard page.
 * Two small chips that reassure merchants their data is handled responsibly,
 * without taking up significant visual real-estate.
 *
 * Hidden on mobile under the bottom-nav area to avoid layout overlap.
 */
export function TrustStrip() {
  return (
    <div
      aria-label="Security and privacy"
      className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-stroke/8 pt-4 text-2xs text-fg-faint"
    >
      <span className="inline-flex items-center gap-1.5">
        <Lock className="h-3 w-3" aria-hidden />
        Secure connection (HTTPS)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Shield className="h-3 w-3" aria-hidden />
        Courier credentials &amp; customer data are encrypted
      </span>
    </div>
  );
}
