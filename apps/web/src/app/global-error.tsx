"use client";

import { useEffect } from "react";
import { getBrandingSync } from "@ecom/branding";
import { captureException } from "@/lib/telemetry";

/**
 * Synchronous, no-I/O branding read. The global error boundary may run
 * when the database itself is the broken thing — we MUST NOT await any
 * async resolver here. `getBrandingSync()` returns DEFAULT_BRANDING
 * (+ ENV overrides) and never throws; that's exactly the surface this
 * page needs.
 */
const SAAS_BRANDING = getBrandingSync();

/**
 * Last-resort crash screen. Next renders this when an error escapes the
 * root layout itself (font loader failure, providers throw, etc.) — the
 * one place where `app/error.tsx` doesn't reach. Because there's no
 * surrounding layout, this component MUST emit its own <html> + <body>.
 *
 * Kept dependency-free on purpose: the shared layout, fonts, and tokens
 * may all be the thing that broke. Inline styles + system fonts so the
 * page can paint even when nothing else loads.
 *
 * Branding values come from the centralized package's defaults — same
 * lime palette + support email as the rest of the app, but pinned at
 * module load (no DB call) so this page is reliable under any failure.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      tags: { boundary: "global_error", digest: error.digest ?? "none" },
    });
  }, [error]);

  const C = SAAS_BRANDING.colors;
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: C.surfaceBase,
          color: C.fg,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div
          style={{
            maxWidth: 460,
            width: "100%",
            textAlign: "center",
            background: "#111113",
            border: "1px solid #27272A",
            borderRadius: 22,
            padding: 32,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 20,
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: C.brand,
                boxShadow: `0 0 14px ${C.brand}`,
              }}
            />
            <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}>
              {SAAS_BRANDING.name}
            </span>
          </div>
          <h1 style={{ fontSize: 22, lineHeight: 1.2, margin: "0 0 8px" }}>
            Something broke loading the page.
          </h1>
          <p style={{ fontSize: 14, color: "#A1A1AA", margin: "0 0 24px" }}>
            We&apos;ve logged the error. Try again, and if it keeps happening,
            email{" "}
            <a style={{ color: C.brand }} href={`mailto:${SAAS_BRANDING.supportEmail}`}>
              {SAAS_BRANDING.supportEmail}
            </a>.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 11, color: "#71717A", margin: "0 0 16px" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              display: "inline-flex",
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              padding: "0 20px",
              border: 0,
              borderRadius: 10,
              background: C.brand,
              color: C.brandFg,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
