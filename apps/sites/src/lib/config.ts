/**
 * Runtime configuration for the public renderer.
 *
 * LANDING_ROOT_DOMAIN — parent domain of merchant pages. Production has no
 *   default: until the landing-domain phase sets it, every host 404s.
 *   Development defaults to `localhost`, so `http://mybrand.localhost:3002`
 *   works in any modern browser (*.localhost resolves to loopback) with no
 *   DNS or hosts-file changes.
 * LANDING_API_URL — the ConfirmX API, ideally over private networking.
 */
export function landingRootDomain(): string | null {
  const configured = process.env.LANDING_ROOT_DOMAIN?.trim();
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : "localhost";
}

export function landingApiUrl(): string {
  return (process.env.LANDING_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

/** Search engines are kept out until the production domain phase opts in. */
export function indexingAllowed(): boolean {
  return process.env.LANDING_ALLOW_INDEXING === "true";
}
