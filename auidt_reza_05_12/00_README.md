# Audit — Reza — 2026-05-12 → 14

This folder is an evidence-based audit of `C:/devs/ecommerce-logistics/`
("ConfirmX" — Bangladesh-first COD operational intelligence SaaS for
Shopify/WooCommerce merchants).

Every claim in these docs is anchored to a file path (and where useful, a line
number). Existing root-level `*.md` audit files at the repo root were NOT
treated as authoritative — they may be stale. The code is the source of truth.

## How to read this folder

Each document is independent. Open only the one you need.

| # | File | When you need it |
|---|------|------------------|
| 01 | `01_PROJECT_ARCHITECTURE.md` | You want the full picture: boot, HTTP surface, tRPC routers, workers, models, flows. |
| 02 | `02_UNFINISHED_WORK.md` | You want the brutal list of what is **stubbed / partial / missing** with file evidence. |
| 03 | `03_SOFT_LAUNCH_READINESS.md` | You are about to deploy. Go/no-go gates across deploy, security, observability, data integrity, compliance. |
| 04 | `04_WHY_MERCHANTS_WONT_USE.md` | You are explaining to investors / co-founders / yourself why adoption will stall today. |
| 05 | `05_TRUST_GAPS_AND_FIXES.md` | You want the concrete list of "what we still need to implement / add so people will trust this." Prioritised. |
| 06 | `06_LOVE_AND_HATE.md` | You want the merchant POV: what they will love, what they will hate. |

## Methodology

- Direct reads of TypeScript in `apps/api/src/`, `apps/web/src/`, `packages/`.
- `git status` + `git log` to find in-flight work.
- The two saved memory rows (`ConfirmX positioning`, `Call stack state 2026-05-13`)
  were used as orientation, then verified in code.
- Multiple parallel Explore agents fanned out across SMS, voice, couriers,
  Shopify/WooCommerce, billing, fraud/intelligence, workers, admin, public
  tracking, env/secrets, observability, GDPR.
- Where the code was ambiguous, the doc says "unclear" instead of guessing.

## What is NOT in this folder

- A re-run of the existing root `*.md` reports (PROJECT_ARCHITECTURE.md,
  MONOREPO_SAAS_MASTER_AUDIT.md, FULL_OPERATIONAL_PRODUCT_AUDIT.md, etc.).
  Those are kept untouched. This folder is a fresh pass.
- Generic SaaS advice. Every recommendation is tied to something that exists
  (or is missing) in this specific repo.
- A roadmap. The "fixes" in `05` are ordered by trust impact, not by sprint.

## Snapshot

- Branch: `main`
- Most recent commit at time of audit: `11be3b6 feat(ops): verify-prod-readiness audit script`
- Uncommitted in-flight work at audit time: SMS provider migration
  (Twilio → SSL Wireless + BulkSMSBD), voice/ subsystem, `confirmation-outcome.ts`,
  `admin-rbac.ts.new`, `audit.ts.new`. See `02_UNFINISHED_WORK.md`.

— Audit performed 2026-05-14.
