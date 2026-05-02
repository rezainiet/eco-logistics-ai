"use client";

import { SessionProvider } from "next-auth/react";
import { getSession } from "next-auth/react";
import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";

/**
 * Custom DOM event fired from the queryCache onError when a tRPC call
 * returns UNAUTHORIZED. <TokenRefreshKeeper> listens, attempts a silent
 * /auth/refresh, and only signs the merchant out if refresh itself fails.
 * Decoupling the dispatch site from the recovery site means we don't need
 * NextAuth's React-only update() inside the queryCache callback.
 */
export const SESSION_UNAUTHORIZED_EVENT = "logistics:session-unauthorized";

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "csrf_token") {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Global query-error fallback. Individual hooks can still override
        // with their own onError; this catches the common case where a page
        // would otherwise sit on the loading skeleton forever.
        queryCache: new QueryCache({
          onError: (err) => {
            const data = (err as { data?: { code?: string } } | null)?.data;
            const code = data?.code;
            if (code === "UNAUTHORIZED") {
              // Hand the recovery off to <TokenRefreshKeeper> — it has the
              // NextAuth update() context we need to push a refreshed
              // apiToken into the session. The keeper attempts a silent
              // refresh first; only if that fails does it sign the merchant
              // out. Either way the queryCache is hands-off after this.
              if (typeof window !== "undefined") {
                window.dispatchEvent(new Event(SESSION_UNAUTHORIZED_EVENT));
              }
              return;
            }
            // FORBIDDEN means the user is authenticated but lacks permission;
            // the procedure-specific UI surfaces that, no global toast.
            if (code === "FORBIDDEN") return;
            const message =
              err instanceof Error
                ? err.message
                : "Something went wrong. Please retry.";
            toast.error("Failed to load", message.slice(0, 200));
          },
        }),
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      })
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/trpc`,
          // Include cookies on cross-origin tRPC calls so the HttpOnly
          // access_token + csrf_token cookies set by /auth/login reach the
          // API. The API's CORS middleware is already set with
          // credentials: true.
          fetch: (url, init) =>
            fetch(url, { ...init, credentials: "include" }),
          async headers() {
            const session = await getSession();
            const csrf = readCsrfCookie();
            const headers: Record<string, string> = {};
            if (session?.apiToken) headers.authorization = `Bearer ${session.apiToken}`;
            // Double-submit CSRF token for cookie-auth mutations. Mirrors
            // the value the API set in the non-HttpOnly csrf_token cookie.
            if (csrf) headers["x-csrf-token"] = csrf;
            return headers;
          },
        }),
      ],
    })
  );

  return (
    <SessionProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </SessionProvider>
  );
}
