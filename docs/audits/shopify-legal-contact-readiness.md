# Legal / contact readiness status (Shopify-submission scope)

**Generated:** 2026-05-09
**Scope:** what we own in-repo vs. what ops must verify externally
before the Public Distribution Unlisted submission.

This is **not** an engineering checklist — most items here are
external infrastructure (DNS, mail servers, registered legal entity).
The doc captures the precise hand-off: every blocker, the file or
external system that owns it, and the verification step.

---

## 0. TL;DR

**Five external-infra items must be true before submission, plus
one in-repo placeholder swap.**

| # | Item | Owner | Blocking? |
|---|---|---|---|
| L1 | `legalName` placeholder swapped to registered entity | brand/legal | YES |
| L2 | `support@confirmx.ai` mailbox accepts mail | ops | YES (reviewers test) |
| L3 | `privacy@confirmx.ai` mailbox accepts mail | ops | YES (reviewers test) |
| L4 | `confirmx.ai` SPF/DKIM/DMARC configured | ops | YES (deliverability) |
| L5 | `confirmx.ai` resolves to a real homepage | ops | YES (Partner Dashboard cross-check) |
| L6 | `support@`/`privacy@` linked correctly across UI surfaces | engineering | DERIVED (auto-tracked via `branding`) |

L1 unblocks L6 automatically — every UI surface reads from
`@ecom/branding`. Fixing the placeholder propagates everywhere.

---

## 1. Branding contact fields (the source of truth)

`packages/branding/src/defaults.ts` defines five email addresses + a
homepage URL:

```ts
{
  legalName: "ConfirmX Technologies Ltd.",   // PLACEHOLDER
  homeUrl: "https://confirmx.ai",
  statusPageUrl: "https://status.confirmx.ai",
  supportEmail: "support@confirmx.ai",
  privacyEmail: "privacy@confirmx.ai",
  salesEmail: "sales@confirmx.ai",
  helloEmail: "hello@confirmx.ai",
  noReplyEmail: "no-reply@confirmx.ai",
  email: {
    senderName: "ConfirmX",
    senderAddress: "no-reply@confirmx.ai",
    replyTo: "support@confirmx.ai",
    ...
  },
}
```

Every rendered surface reads these values:

| Surface | Field consumed |
|---|---|
| Privacy page §9 Contact | `privacyEmail` |
| Privacy page intro | `legalName`, `name` |
| Terms page intro | `legalName`, `name` |
| Terms § 9 Limitation of liability | `legalName.toUpperCase()` |
| Terms § 12 Contact | `supportEmail` |
| Email `From:` header | `email.senderName <email.senderAddress>` (or `EMAIL_FROM` env override) |
| Email `Reply-To:` header | `email.replyTo` |
| Email footer | `email.footer` |
| Email "Need a hand?" line | `email.supportLine` |
| Stripe customer portal | `legalName` (passed via Stripe metadata) |
| `/global-error.tsx` last-resort screen | `supportEmail` |
| Marketing footer "Contact" | `supportEmail` |

**Net: one find-and-replace in `defaults.ts` updates every rendered
surface.**

## 2. Per-blocker verification

### L1 — Legal entity

**Where:** `packages/branding/src/defaults.ts:26` `legalName`.

**Current:** `"ConfirmX Technologies Ltd."` (placeholder per
`TODO[brand]`).

**Must be:** the legal entity registered to operate the platform.
Reviewers cross-check this against:
- The Partner-Dashboard "Developer name" field
  (`shopify-listing-wording.md` Install consent screen).
- The privacy and terms pages' opening paragraph and the all-caps
  Limitation-of-liability clause in Terms §9.
- Any invoices the merchant receives via Stripe.

**Verification:** after the swap, search:
`grep -rn "ConfirmX Technologies Ltd" .` should return the
`defaults.ts` line and zero hard-coded references elsewhere
(branding flows are parametric).

### L2 — `support@confirmx.ai`

**Where rendered:**
- Terms page §12.
- Email `Reply-To:` header on every transactional email.
- Marketing footer.
- `/global-error.tsx` last-resort fallback (offers the email if
  reset fails).
- Branding `email.replyTo`.

**Reviewer test:** Shopify reviewers send a delivery test to the
support email during review. A bounce or undeliverable failure is
review-failing.

**Ops checklist:**
- [ ] Mailbox provisioned (Gmail Workspace / Zoho / Fastmail / etc.).
- [ ] Inbound delivery tested from a non-confirmx address.
- [ ] Outbound reply tested.
- [ ] At least one human (or shared inbox + on-call rotation)
      monitors during review week.
- [ ] Auto-responder NOT configured to bounce / delay during review
      window — reviewers want to see a human reply within 24h.

### L3 — `privacy@confirmx.ai`

**Where rendered:**
- Privacy page §9 Contact.
- Branding `privacyEmail`.

**Reviewer test:** same as support — delivery is tested.

**Ops checklist:**
- [ ] Mailbox provisioned.
- [ ] Inbound + outbound tested.
- [ ] Routes to either the same shared support inbox OR a dedicated
      privacy/DPO inbox per BD / EU GDPR posture.

### L4 — Email deliverability (SPF / DKIM / DMARC)

**Why it matters:** ConfirmX sends transactional email from
`no-reply@confirmx.ai` via Resend (`apps/api/src/lib/email.ts`).
Without SPF / DKIM aligned to the sending domain, Gmail / Outlook /
ProtonMail will mark messages as spam or quarantine them. Reviewers
sign up with a personal email; if the verification email never lands
in the inbox, they cannot test the install path.

**External verification (DNS records):**
- [ ] **SPF** — `confirmx.ai` TXT includes the Resend sending
      origin: `v=spf1 include:_spf.resend.com ~all` (verify against
      Resend's current docs at
      <https://resend.com/docs/dashboard/domains/introduction>).
- [ ] **DKIM** — Resend issues per-domain DKIM keys; published as
      CNAME records on the domain's DNS.
- [ ] **DMARC** — at minimum `v=DMARC1; p=none; rua=mailto:dmarc@confirmx.ai`
      so failures are reported but not blocked. Tighter `p=quarantine`
      or `p=reject` is preferable post-launch but starts with `p=none`
      to avoid blocking real reviewer mail during the warm-up period.
- [ ] Verify via <https://dmarc.postmarkapp.com/> or `dig` that all
      three resolve correctly.
- [ ] Send a test email to a Gmail account; inspect headers
      (`Authentication-Results`) to confirm `spf=pass`, `dkim=pass`,
      `dmarc=pass`.

**Anchor:** the API code uses `RESEND_API_KEY` (env). When unset, no
mail is sent — falls back to stdout dev log. This is correct dev
posture; production must have the key set AND DNS records published.

### L5 — `https://confirmx.ai` resolves to a real homepage

**Why it matters:** the Partner-Dashboard "Homepage URL" field
points here; reviewers click through. The domain is also referenced
in `defaults.ts` `homeUrl`, in OG metadata, in transactional email
footers.

**Ops checklist:**
- [ ] `confirmx.ai` DNS resolves.
- [ ] Serves a marketing landing OR redirects to
      `app.confirmx.ai` (acceptable; reviewers don't care about the
      shape, just that something coherent lands).
- [ ] HTTPS valid (no cert warning).
- [ ] Page references "ConfirmX" consistently (no leftover Cordon
      branding from a prior tenant of the domain).

**`status.confirmx.ai` (LOW PRIORITY):** referenced in
`defaults.ts` `statusPageUrl`. If the subdomain doesn't resolve,
the link is broken but not review-blocking. Either ship a stub
status page OR remove the field from rendered surfaces (it's only
shown in operational alert emails for now).

### L6 — UI surfaces auto-track

**Engineering owns:** confirming after L1–L5 that every rendered
surface reads from `@ecom/branding` (no hard-coded fallbacks).

| Surface | Source field | Hard-coded fallback? |
|---|---|---|
| Privacy / Terms intros | `_brand.legalName` | No — uses `getBrandingSync()` |
| Privacy §9 / Terms §12 contact | `_brand.privacyEmail` / `_brand.supportEmail` | No |
| Marketing footer | `_brand.supportEmail` | No |
| Email From / Reply-To | `_brand.email.*` | `EMAIL_FROM` env can override |
| `/global-error.tsx` | `_brand.supportEmail` | No (uses `getBrandingSync()` synchronously) |
| Sidebar / Topbar wordmark | `_brand.name` | No |

**Verified clean:** no `support@confirmx.ai` or `privacy@confirmx.ai`
or `ConfirmX Technologies Ltd` literal appears anywhere outside
`defaults.ts` (and the audit docs).

## 3. Privacy / Terms — completeness check

`apps/web/src/app/legal/privacy/page.tsx`:

| Section | Status |
|---|---|
| Last-updated date | dynamic via `new Date().toISOString().split("T")[0]` — dev convenience. **Should be replaced with the actual policy review date** before submission. |
| § 1 What data we collect | COMPLETE — covers merchants, connected platforms, telemetry |
| § 2 Why | COMPLETE |
| § 3 Sharing | COMPLETE — names sub-processors |
| § 4 Retention | COMPLETE |
| § 5 Rights | COMPLETE — Shopify GDPR webhooks documented |
| § 6 Security | COMPLETE — AES-256, audit log, role-based access |
| § 7 Children | COMPLETE |
| § 8 Changes | COMPLETE |
| § 9 Contact | COMPLETE — physical-address line is OPTIONAL TODO |

`apps/web/src/app/legal/terms/page.tsx`:

| Section | Status |
|---|---|
| Last-updated date | same dynamic-date issue |
| § 1 The Service | COMPLETE |
| § 2 Account & security | COMPLETE (sampled — file truncated above) |
| § 9 Limitation of liability | uses `_brand.legalName.toUpperCase()` — auto-tracks the entity |
| Governing law / jurisdiction | OPTIONAL TODO per inline comment |

**Pre-submit item:** flip the dynamic last-updated date to a static
policy-review date (no auto-bump) before the Partner-Dashboard form
is submitted. Reviewers reading the policy on different days will
otherwise see different "last updated" dates.

## 4. The "last-updated" date pattern (P-7 polish, optional)

The dynamic `new Date()` rendering in privacy + terms is a known
dev convenience. Two options when ready:

1. **Manual bump (recommended for now):** replace with a literal
   string like `Last updated: 2026-05-15`. Audit when the policy
   actually gets reviewed by counsel.
2. **Const + import:** declare `const POLICY_LAST_UPDATED = "2026-05-15"`
   in each file's top-of-module. Easier to find/grep in future
   audits.

This is **NOT a Shopify-review blocker** — reviewers don't
fingerprint the page across days. Listed here only for closeout
discipline.

## 5. Findings table

| # | Finding | Severity | Owner | Anchor |
|---|---|---|---|---|
| L1 | `legalName` placeholder | BLOCKING | brand/legal | `packages/branding/src/defaults.ts:26` |
| L2 | `support@confirmx.ai` mailbox unverified | BLOCKING | ops | external infra |
| L3 | `privacy@confirmx.ai` mailbox unverified | BLOCKING | ops | external infra |
| L4 | SPF/DKIM/DMARC unverified | BLOCKING | ops | DNS + Resend |
| L5 | `confirmx.ai` homepage resolution unverified | BLOCKING | ops | DNS |
| L6 | UI surfaces auto-track from branding | DERIVED | — | verified clean |
| L7 | Privacy/Terms `last-updated` dynamic-date pattern | LOW | engineering | privacy + terms pages |
| L8 | `status.confirmx.ai` may not resolve | LOW | ops | DNS |
| L9 | Optional physical-address line in privacy §9 | OPTIONAL | brand/legal | `privacy/page.tsx:250` |

## 6. Recommended sequence

1. **Brand/legal** confirms registered legal entity → swap `defaults.ts`
   `legalName`. Verify with `npm --workspace apps/web run dev` and
   visit `/legal/privacy` and `/legal/terms` to spot-check
   propagation.
2. **Ops** provisions the two mailboxes + inbound/outbound test.
3. **Ops** publishes SPF / DKIM / DMARC records; verifies with a
   test send.
4. **Ops** deploys / confirms `confirmx.ai` homepage.
5. **Engineering** flips the dynamic last-updated date to a static
   value matching the legal review date.
6. Submit.

After approval: tighten DMARC from `p=none` to `p=quarantine` once
deliverability is confirmed clean for two weeks. If `status.confirmx.ai`
isn't shipped by approval, either remove `statusPageUrl` from
`defaults.ts` OR ship a stub status page; the field only renders on
operational alert emails today, but a 404 in any rendered surface
is a long-tail polish risk.
