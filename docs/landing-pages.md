# Landing pages

Merchants build multiple landing pages from admin-managed templates, edit only the
fields a template exposes, preview drafts, and publish immutable revisions. Public
serving is host-based and ready for wildcard DNS, which is a later phase.

## Architecture

```
packages/landing          one template system, shared by every surface
  src/fields.ts           field types + value schemas (zod)
  src/sections.ts         section-type registry: type@version → fields
  src/spec.ts             template spec validation, content validate/resolve
  src/safe.ts, cta.ts     URL / colour / rich-text safety (deny by default)
  src/host.ts             host normalisation, slug rules, reserved names
  src/templates.ts        system templates (Launch, Showcase, Local Business)
  src/react/*             trusted section components + LandingRenderer

packages/db               LandingPageTemplate, LandingPageTemplateVersion,
                          LandingPage, LandingPageRevision, LandingPageHost,
                          LandingAsset
apps/api/src/lib/landing  pages.ts (lifecycle), templates.ts (seed/cache),
                          resolve.ts (host → published page), assets.ts
apps/api routers          landingPages (merchant), adminLandingTemplates
                          (super_admin), publicLanding (unauthenticated)
apps/web                  /dashboard/landing-pages (list, new, editor),
                          /admin/landing-templates, /preview/* (auth only)
apps/sites                public renderer: Host → /lp/<label> → API → render
```

**Trust boundary:** section components are application code. Merchant content is
data. It is validated on write (`validateContent`) and again at render time
(`resolveContent`). It is rendered only through React text nodes, `ctaHref`,
`safeUrl`, validated `#rrggbb` theme tokens, and asset IDs mapped to a configured
base URL. There is no HTML, script, style or iframe input anywhere.

**Versioning:**
- A published `LandingPageTemplateVersion` is immutable: model hooks refuse
  updates. Admin edits always go to a new draft version.
- Pages pin `templateVersionId` and only move to a newer version when the owner
  runs "Update draft".
- System templates are reseeded at API boot. A new version is published only
  when the code spec's hash changes.

**Draft and publish:**
- `saveDraft` does a compare-and-set on `draftRevision`, so a stale editor gets
  `CONFLICT`.
- `publish` allocates a revision number, inserts an immutable
  `LandingPageRevision`, then flips `publishedRevisionId`. Each step is
  conditioned on the same `draftRevision`, so no multi-document transaction is
  needed.
- Only the published revision is ever served.

**Tenancy:** every merchant query filters on `merchantId` from the auth context.
Another tenant's page is indistinguishable from a missing one (`NOT_FOUND`). Images
referenced by content must belong to the page's merchant.

**Slugs:** `LandingPageHost.hostname` is globally unique and stores the label only,
so the root domain can change without a migration. Released slugs are held for
`LANDING_SLUG_HOLD_DAYS` (default 90) against other merchants.

## Local development

```bash
npm run dev:api
npm run dev:web
npm run dev:sites
```

Browsers resolve `*.localhost` to loopback, so after publishing a page with slug
`mybrand` you can open `http://mybrand.localhost:3002`. No DNS or hosts-file
change is needed.

Outside production, `LANDING_ROOT_DOMAIN` defaults to `localhost`. In production
it has no default, so every host returns 404 until the domain phase sets it.

## Environment

| Var | Where | Default |
| --- | --- | --- |
| `LANDING_ROOT_DOMAIN` | api, sites | `localhost` (non-prod), unset (prod → all 404) |
| `LANDING_PUBLIC_URL_PATTERN` | api | `http://{slug}.localhost:3002` (non-prod) |
| `LANDING_SLUG_HOLD_DAYS` | api | `90` |
| `LANDING_MAX_PAGES_PER_MERCHANT` | api | `50` |
| `LANDING_API_URL` | sites | `http://localhost:4000` |
| `LANDING_ASSET_ORIGIN` | sites (CSP `img-src`) | origin of `LANDING_API_URL` |
| `LANDING_ALLOW_INDEXING` | sites | unset → robots.txt disallows everything |

## Deferred to the domain / infrastructure phase

- Buy and choose the landing domain. A separate registrable domain is recommended:
  cookie isolation from `confirmx.ai`, blocklist blast radius, and Meta domain
  verification via the Public Suffix List.
- Wildcard DNS `*.<domain>` and a wildcard TLS certificate.
- Railway `sites` service with the wildcard custom domain and private networking
  to the API.
- Set `LANDING_ROOT_DOMAIN`, `LANDING_PUBLIC_URL_PATTERN`, `LANDING_API_URL`,
  `LANDING_ASSET_ORIGIN`, and optionally `LANDING_ALLOW_INDEXING`.
- Per-host canonical URL, sitemap and final robots policy.
- CDN caching: add `s-maxage` once a CDN keys on Host, then wire purge on
  publish.
- Object storage (S3/R2) for assets, plus image re-encoding and EXIF stripping.
  Content already references assets by ID.
- Custom domains (`LandingPageHost.kind = "custom_domain"`), admin
  moderation/takedown, and CSP nonces.
