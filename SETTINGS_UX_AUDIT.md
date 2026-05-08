# Settings UX Audit — Cordon Merchant Dashboard

**Audit date:** 2026-05-08
**Audit scope:** every merchant-facing route that contains configuration, account, billing, or developer settings.
**Audit boundary:** admin-only routes (`/admin/*`) are catalogued for completeness but explicitly out of scope — they serve internal staff, not merchants, and have no overlap with merchant-facing settings.
**Audited code:** ~5,096 lines of merchant settings-adjacent code across 7 routes.

---

## Executive summary

Cordon's settings experience is functionally rich but architecturally fragmented. Six unrelated configuration domains share a single 1,282-line client component (`/dashboard/settings/page.tsx`), while three more domains that conceptually belong to settings live as top-level routes (`/dashboard/billing`, `/dashboard/api`, `/dashboard/integrations`). The result is an information architecture that no merchant could draw from memory and which doesn't scale: every new setting either bloats the monolith further or fragments the experience further.

The visual primitives are good — `Card`, `Heading`, `Eyebrow`, `PageHeader`, the design tokens (`fg`, `fg-subtle`, `surface`, `stroke/8`) — and the dark-mode story is solid where it's been thought about. The issues are structural: navigation, IA, save-state semantics, in-section status visibility, and mobile interaction patterns.

This audit identifies **18 distinct issues** across nine categories. Of these, **7 are P0** (block the "enterprise-grade operational SaaS" target), **8 are P1** (visible quality drag), and **3 are P2** (nice to have). Crucially, none require changing tRPC contracts — every issue is in the UI layer.

---

## 1. Current settings surface (what exists today)

### Inside `/dashboard/settings`
A single client page with six tabs driven by local `useState` (no URL state):

| Tab | What it does | tRPC procedures |
|---|---|---|
| Profile | Business name, phone, country, language; test-SMS button | `merchants.getProfile`, `merchants.updateProfile`, `merchants.sendTestSms` |
| Branding | Logo upload, accent color extraction, live preview | `merchants.getProfile`, `merchants.updateBranding` |
| Couriers | Pathao / Steadfast / RedX / eCourier / Paperfly credentials, preferred districts, AES-256 storage messaging | `merchants.getCouriers`, `merchants.upsertCourier`, `merchants.removeCourier` |
| Automation | Manual / semi-auto / full-auto policy + thresholds | `merchants.getAutomationConfig`, `merchants.updateAutomationConfig` |
| Security | Password change (with anti-GET-leak hardening), email verification status | `merchants.changePassword`, `merchants.getProfile`, REST `/auth/resend-verification` |
| Billing | Plan tier card, trial countdown, WhatsApp upgrade CTA, fact grid | `merchants.getProfile.billing` (read-only) |

### Outside `/dashboard/settings` but conceptually settings
| Route | Lines | What it is | Belongs in settings? |
|---|---|---|---|
| `/dashboard/billing/page.tsx` | 993 | Plan picker, manual bKash/Nagad payment submission, Stripe checkout/portal, payment history (25 most recent) | **Yes** — this is the operational counterpart to the read-only `Billing` tab; merging them eliminates a confusing "view here, change there" split |
| `/dashboard/api/page.tsx` | 540 | Webhook URL copy, HMAC signing secret rotation, test-event firing, last 25 deliveries with status / latency / response codes. Uses REST `fetch`, not tRPC | **Yes** — this is the developer settings surface |
| `/dashboard/integrations/page.tsx` | 1,966 | Shopify / WooCommerce / Custom API connect flow, post-OAuth banners, import progress, webhook health, replay/retry actions | **Yes, but with care** — it's settings, but it's also a merchant's day-1 onboarding surface; it must stay easy to find from the dashboard home |
| `/dashboard/integrations/issues/page.tsx` | ~200 | List of integration warnings/errors with action buttons | **Yes** — it's a sub-surface of integrations |

### Adjacent merchant routes (not settings)
| Route | Lines | Notes |
|---|---|---|
| `/dashboard/recovery` | 292 | Cart-recovery outreach. Operational, not configurable. **Keep separate.** |
| `/dashboard/getting-started` | 23 | First-run hero + checklist. **Keep separate.** |

### Admin routes (out of scope)
`/admin/branding`, `/admin/billing`, `/admin/access`, `/admin/audit`, `/admin/system`, `/admin/alerts`, `/admin/fraud` — all super-admin internal tooling. **No overlap with merchant settings**, kept untouched.

---

## 2. Layout & navigation findings

### P0-1 — No persistent settings IA. Tab nav is internal-only.
The 6 tabs are a horizontal pill-bar at the top of `/dashboard/settings`. There is no breadcrumb, no left-rail, no section indicator in the topbar. A merchant who deep-links to a courier credential issue from a Slack message lands on `/dashboard/settings`, sees a Profile form, and has to rediscover the Couriers tab. Stripe / Linear / Vercel / Shopify all use a left-rail settings nav with stable URLs — that's the genre convention this product targets and currently misses.

### P0-2 — Tab state lives in `useState`, not the URL.
`const [tab, setTab] = useState<TabKey>("profile")` (line 121). Refreshing, opening in a new tab, sharing a link, or closing/reopening always resets to Profile. This breaks deep-linking from support tickets, emails, and incident playbooks — exactly the scenarios where merchant trust is most fragile.

### P0-3 — Conceptually-related settings live in three different navigations.
Today a merchant who wants to change their plan goes to `/dashboard/billing`, but the trial countdown lives in `/dashboard/settings#billing`, while the API key rotation is at `/dashboard/api`, and integrations are at `/dashboard/integrations`. Each has its own page header style, its own back-to-settings affordance (or none), and its own loading skeleton. That's not enterprise UX — that's three separate apps wearing the same chrome.

### P1-1 — No breadcrumbs anywhere in the dashboard.
Once routes go two levels deep (e.g. `/dashboard/integrations/issues`) the user has no in-app trail back to the parent. The browser back button works but doesn't communicate hierarchy.

### P1-2 — The settings page header is generic.
"Settings — Manage your business profile, courier credentials, and billing." is informationally inert and gets stale the moment a new section is added. Stripe's settings header uses the section's name and one operational sentence; Linear's uses a single eyebrow + name pattern. The current header sits there like wallpaper.

---

## 3. Grouping & IA findings

### P0-4 — Tabs reflect engineering convenience, not merchant mental models.
The current six tabs are `Profile / Branding / Couriers / Automation / Security / Billing`. Conspicuously missing: Notifications, Team & Access, API & Webhooks, Integrations, Data Export. Conspicuously misshapen: "Profile" mixes business identity (name, country) with an isolated phone-test affordance, and "Billing" is a read-only summary that lives apart from the actual plan picker. A merchant looking for "where do I change who gets the past-due alert" cannot find it because there is no notification preferences surface at all.

### P1-3 — Couriers is operationally rich but visually flat.
Each configured courier shows status (Enabled / Disabled), masked API key, account ID, preferred districts, and validation errors — that's good operational detail. But all couriers are presented as identical rounded rows with the same border weight, in the order the API returns them. There is no "your active courier" emphasis, no recent-success indicator, no "last booked at", no failure-rate gloss. This is the kind of section that could, with no schema change, become an operational dashboard for the merchant to trust at a glance.

### P1-4 — The Automation section is a single bare card, no scaffolding.
`<AutomationModePicker />` is rendered directly with no wrapping; it inherits the page's `space-y-6` and that's it. There is no "Why does this matter?" explainer, no link to the rules engine docs, no preview of how the current config would have classified yesterday's orders. Merchants who don't already understand the manual / semi-auto / full-auto distinction get a single dropdown and three sentences of helper text.

---

## 4. Visual consistency findings

### P1-5 — Hardcoded HSL color in Billing tab breaks the token contract.
Lines 1007–1008: `bg-[hsl(262_83%_62%/0.14)]` and `text-[hsl(262_83%_72%)]` are inline arbitrary colors that the theme system can't change. Every other section uses the `bg-brand/14` + `text-brand` token pair. This will look slightly off in dark mode and will silently break if someone re-themes the brand color.

### P1-6 — Spacing rhythm is inconsistent across sections.
`ProfileSection` uses `space-y-5` inside the form. `CouriersSection` uses `space-y-3`. The dialog uses `space-y-4`. The Security card stack uses `space-y-4`. These differences are individually defensible but cumulatively they make the same page feel like several pages stitched together. An enterprise system picks one rhythm (typically `space-y-6` between sections, `space-y-4` between fields) and holds the line.

### P1-7 — Section card icons are decorative-only and inconsistent in tone.
`Building2` in a `bg-brand/14` square for Profile, `Truck` in a `bg-success-subtle` square for Couriers, `Lock` in `bg-brand/14` for Password, `Mail` in `bg-success-subtle` for Email verification, `CreditCard` in a hardcoded purple for Billing. The success-tinted Truck and Mail aren't conveying success — they're decorative. That dilutes the success token's meaning when it's actually used to convey success (badges, validation).

---

## 5. Form UX findings

### P0-5 — No save-bar pattern. Every section invents its own save semantics.
- Profile: dirty-tracked `Save changes` button at the bottom of the card.
- Branding: dirty-tracked, save-on-click via the BrandingSection's own button.
- Couriers: each provider is a sub-form inside a modal — saved on submit, no draft state.
- Automation: has its own internal save button inside the picker.
- Security: classic submit form with native `<button type=submit>`.
- Billing: read-only.

That's five different save patterns in one page. None of them uses an `Esc` to discard, none of them warns on navigation-with-unsaved-changes, and none of them shows where in the form an error came from when the server rejects. An enterprise settings system has one canonical pattern (sticky save bar that appears when dirty, "Discard / Save changes" buttons, navigation guard, success toast). Linear, Vercel, and Stripe all do this; we don't do it anywhere.

### P1-8 — Inconsistent dirty tracking.
Profile has explicit `touched` state. Branding has its own `touched`. Couriers has none (it's a modal-on-submit). Security uses derived `canSubmit`. Automation tracks dirtiness internally. We don't have a shared form primitive, so each section invented its own.

### P2-1 — `<Field>` is local to settings/page.tsx and not exported.
The 23-line `Field` helper at the bottom of `page.tsx` is a perfect candidate for `components/ui/form-field.tsx`. Today it can't be reused; tomorrow when we add Notifications, the next person re-implements the same idea and drift starts.

### P2-2 — No async-saving indicator distinct from initial loading.
A user clicking Save sees `<Loader2 className="animate-spin">` next to the button label — that's fine. But there is no surface-wide saving indicator (greyed-out form, dimmed sections, mid-page progress strip) for slow networks. On a 3G connection from a Bangladeshi merchant on a metered plan, "did my courier credential save?" is exactly the question this product can't afford to leave ambiguous.

---

## 6. Operational clarity findings

### P0-6 — Integration health is invisible from settings.
The integrations page shows recent webhooks; the courier section shows enabled/disabled badges. But neither cross-references operational state from the other. A merchant whose Pathao is enabled but whose last 5 webhooks failed has no breadcrumb pointing them at the problem. Settings should answer "is everything that needs to be working actually working?" at a glance — today it answers "is everything configured?".

### P0-7 — Webhook signing secret rotation is hidden in `/dashboard/api`.
For an API-first SaaS targeting Shopify and WooCommerce merchants, "rotate my webhook secret" is exactly the kind of action that needs to be discoverable, audit-loggable, and clearly destructive. Right now it's two clicks deep inside a route that doesn't even use the same data layer (REST instead of tRPC).

### P1-9 — No notification preferences surface at all.
There are no merchant-controllable notification settings — not for past-due alerts, fraud thresholds, recovery-pipeline notifications, nor weekly summary emails. Every notification today is hard-coded. As we add channels (SMS, WhatsApp, email digest), this gap will become a customer-success bottleneck.

### P1-10 — No team / access surface.
Single-user merchants are fine for now, but there is no surface where a merchant can see who has access, invite a co-worker, or set scopes. Adding it later without a parent settings IA will mean a fourth top-level route and the fragmentation continues.

---

## 7. Mobile UX findings

### P0-8 — The 6-tab pill nav doesn't fit on mobile.
The pill nav uses `flex flex-1` for each tab, which means on a 360px screen each pill is ~50px wide — barely room for the icon and a truncated label. Real-world merchants in Bangladesh use this dashboard on Xiaomi and Realme phones with 360–393px-wide viewports. A horizontal-scroll tablist or a mobile-first dropdown is needed.

### P1-11 — Forms don't use a sticky save bar on mobile.
On a long form, the Save button is at the bottom; on a short viewport, the user has to scroll to it. The dashboard's mobile bottom nav already eats screen space, so a sticky-above-mobile-nav save bar is the pattern that actually works.

### P1-12 — Touch targets in CourierSection are borderline.
The 32px-wide `Edit` and `Remove` outline buttons (lines 466–478) sit close together with `gap-2` and a `size="sm"` Button. Apple's HIG floor is 44pt, Material's is 48dp — we're under both. On mobile the cards already wrap to a column, but the action row stays horizontal.

---

## 8. Accessibility findings

### P1-13 — Tab pills have `role="tab"` but no `tabpanel`.
The `<nav role="tablist">` (line 132) wraps `<button role="tab">` correctly, but the panels below are plain divs without `role="tabpanel"`, `aria-labelledby`, or `id`. Screen-reader users hear tabs but can't navigate to the corresponding panel. WAI-ARIA says either commit to the full pattern or use `<a href>` links instead.

### P2-3 — No skip-to-content link in the dashboard layout.
Every page has the sidebar + topbar before content; keyboard-only users tab through the sidebar links every time. A `<a href="#main-content">Skip to content</a>` would help.

---

## 9. Loading & empty states

The empty states in `CouriersSection` are well-done: dashed border, icon, helper copy, primary CTA. That pattern is **good and should be reused** as the canonical empty state for every future settings section. The `<EmptyState>` helper (lines 1259–1281) is currently local — it should be exported from `components/ui/empty-state.tsx` (which already exists with a similar but not identical signature; needs reconciliation).

Loading: the `animate-pulse` skeleton boxes in CouriersSection (lines 391–399) are also good. They could be swapped to use the existing `components/ui/skeleton.tsx`.

---

## 10. What's working — preserve these patterns

Even though most findings are critical, the codebase has real strengths that the redesign must preserve:

- **The dark-mode token system** (`bg-surface`, `text-fg`, `border-stroke/8`) is consistent everywhere except the one Billing tab regression noted above. New code should use these exclusively.
- **The Couriers section's operational detail** (masked key, account ID, validation error inline, preferred districts) is exactly the right shape for an enterprise settings row — every new section should mirror this density.
- **Security's anti-GET-fallthrough hardening** in the password form (lines 837–854) is a deeply considered, prod-incident-driven detail. The redesign must preserve `method="post" action="/api/auth/__nope" + e.preventDefault()` and the comment explaining why.
- **The `<EmptyState>`** pattern with icon + title + description + CTA is the right shape for a configuration-empty state.
- **The Test-SMS button** with its three-state disable logic ("add a phone first" / "save your phone change first" / OK) is genuinely operational UX. It survives the redesign.
- **The `Field` helper's hint + required-asterisk pattern** is good shape for a shared `FormField` primitive — promote it, don't replace it.

---

## Severity-tagged issue index

| # | Severity | Title |
|---|---|---|
| P0-1 | P0 | No persistent settings IA / left-rail / breadcrumb |
| P0-2 | P0 | Tab state in useState, not URL — breaks deep-linking |
| P0-3 | P0 | Three settings domains live as separate top-level routes |
| P0-4 | P0 | Tab grouping reflects engineering, not merchant mental model |
| P0-5 | P0 | No canonical save-bar / dirty-state pattern |
| P0-6 | P0 | Integration health invisible from settings |
| P0-7 | P0 | Webhook secret rotation hidden in detached `/dashboard/api` |
| P0-8 | P0 | 6-tab pill nav doesn't fit on 360px mobile |
| P1-1 | P1 | No breadcrumbs across the dashboard |
| P1-2 | P1 | Generic page header copy |
| P1-3 | P1 | Couriers visually flat — no operational hierarchy |
| P1-4 | P1 | Automation section is a bare card with no scaffolding |
| P1-5 | P1 | Hardcoded purple HSL in Billing tab |
| P1-6 | P1 | Inconsistent spacing rhythm across sections |
| P1-7 | P1 | Decorative icon backgrounds dilute the success token |
| P1-8 | P1 | Inconsistent dirty tracking across forms |
| P1-9 | P1 | No notification preferences surface |
| P1-10 | P1 | No team / access surface |
| P1-11 | P1 | No sticky save bar on mobile |
| P1-12 | P1 | Sub-44pt touch targets in courier rows |
| P1-13 | P1 | `role="tablist"` without `role="tabpanel"` |
| P2-1 | P2 | `<Field>` not exported as a shared primitive |
| P2-2 | P2 | No surface-wide async-save indicator |
| P2-3 | P2 | No skip-to-content link in dashboard layout |

---

## Out of scope but noted

These came up during the audit and deserve recording, but are deliberately not part of this redesign:

- **`/dashboard/integrations/page.tsx` is 1,966 lines.** Breaking it up is its own project. This redesign moves it under `/dashboard/settings/integrations/` (with an old-route redirect) and leaves the internal structure intact.
- **`/dashboard/api` uses REST instead of tRPC.** Migrating to tRPC is a separate refactor — out of this redesign's scope per the constraint "must not break tRPC contracts" (which we read as: don't rewrite the API layer here).
- **Two-factor auth, session management, audit log of merchant actions.** These are obvious next-quarter additions; the new IA reserves space for them but doesn't ship them.

---

## Audit conclusion

The redesign that follows is not visual polish. It is a structural shift from "a settings page with six tabs" to "a settings *system* with a stable URL per section, a shared shell, a canonical save-bar pattern, and room to add Notifications, Team, API & Webhooks, and Integrations as first-class peers." That structural shift is what makes the experience feel like Stripe and not like a Tailwind admin template — and it's what unblocks every settings feature we'll ship in the next 12 months.
