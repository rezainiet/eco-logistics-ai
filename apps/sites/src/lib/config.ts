/**
 * Runtime configuration for the public renderer.
 *
 * LANDING_ROOT_DOMAIN — parent domain of merchant pages. Production has no
 *   default: until the landing-domain phase sets it, every host 404s.
 *   Development defaults to `localhost`, so `http://mybrand.localhost:3002`
 *   works in any modern browser (*.localhost resolves to loopback) with no
 *   DNS or hosts-file changes.
 * LANDING_PREVIEW_HOST — host that serves the editor preview frame.
 *   Development default `preview.localhost` ("preview" is a reserved slug,
 *   so no merchant can claim it). Production: unset until configured.
 * LANDING_EDITOR_ORIGINS — comma-separated dashboard origins allowed to
 *   embed the preview frame and post drafts to it.
 * LANDING_API_URL — the ConfirmX API, ideally over private networking.
 */
const isProd = process.env.NODE_ENV === "production";

export function landingRootDomain(): string | null {
  const configured = process.env.LANDING_ROOT_DOMAIN?.trim();
  if (configured) return configured;
  return isProd ? null : "localhost";
}

export function previewHost(): string | null {
  const configured = process.env.LANDING_PREVIEW_HOST?.trim();
  if (configured) return configured;
  return isProd ? null : "preview.localhost";
}

export function editorOrigins(): string[] {
  const raw = process.env.LANDING_EDITOR_ORIGINS?.trim();
  const list = raw ? raw.split(",") : isProd ? [] : ["http://localhost:3001"];
  return list.map((o) => o.trim().replace(/\/+$/, "")).filter((o) => /^https?:\/\/[^/\s]+$/.test(o));
}

export function landingApiUrl(): string {
  return (process.env.LANDING_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

/** Where images are served from (the API's asset route). */
export function assetBaseUrl(): string {
  const origin = (process.env.LANDING_ASSET_ORIGIN ?? landingApiUrl()).replace(/\/+$/, "");
  return `${origin}/api/landing-assets`;
}

/** Search engines are kept out until the production domain phase opts in. */
export function indexingAllowed(): boolean {
  return process.env.LANDING_ALLOW_INDEXING === "true";
}
