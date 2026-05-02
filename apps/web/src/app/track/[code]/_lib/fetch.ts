import "server-only";

/**
 * Server-only fetcher for the public tracking timeline.
 *
 * Calls the API's tRPC endpoint over plain HTTP — we don't need the
 * full @trpc/react-query client here because the page is rendered on
 * the server, has no auth, and never re-fetches. Direct fetch keeps
 * the bundle small and the dependency graph clean.
 */

export interface PublicTrackingEvent {
  at: string;
  status: string;
  description?: string;
  location?: string;
}

export interface PublicTracking {
  orderNumber: string;
  status: string;
  cod: number;
  courier: string | null;
  trackingNumber: string;
  maskedAddress: string;
  estimatedDelivery: string | null;
  events: PublicTrackingEvent[];
  branding: {
    displayName: string;
    logoUrl?: string;
    primaryColor?: string;
    supportPhone?: string;
    supportEmail?: string;
  };
}

function apiBase(): string {
  const fromEnv =
    process.env.PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:4000";
  return fromEnv.replace(/\/$/, "");
}

export type FetchResult =
  | { kind: "ok"; data: PublicTracking }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export async function fetchPublicTracking(code: string): Promise<FetchResult> {
  if (!code || code.length < 4 || code.length > 100) {
    return { kind: "not_found" };
  }
  const url = `${apiBase()}/trpc/tracking.getPublicTimeline?input=${encodeURIComponent(
    JSON.stringify({ code }),
  )}`;
  let res: Response;
  try {
    res = await fetch(url, {
      // 30-second cache mirrors the server-side cached() TTL so a viral
      // share link doesn't hammer the API.
      next: { revalidate: 30 },
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    // tRPC wraps errors as 4xx/5xx with a JSON body we can inspect for the code.
    try {
      const body = (await res.json()) as { error?: { data?: { code?: string } } };
      if (body?.error?.data?.code === "NOT_FOUND") return { kind: "not_found" };
    } catch {
      /* fall through */
    }
    return { kind: "error", message: `upstream returned ${res.status}` };
  }
  let body: { result?: { data?: PublicTracking } };
  try {
    body = (await res.json()) as { result?: { data?: PublicTracking } };
  } catch (err) {
    return { kind: "error", message: `bad upstream JSON: ${(err as Error).message}` };
  }
  const data = body?.result?.data;
  if (!data) return { kind: "error", message: "missing tracking data in upstream response" };
  return { kind: "ok", data };
}
