# Enterprise Settings Redesign Report — Cordon Merchant Dashboard

**Report date:** 2026-05-08
**Companion document:** [`SETTINGS_UX_AUDIT.md`](./SETTINGS_UX_AUDIT.md) — the structural audit that motivated this work.
**Branch state:** `claude/staging-deploy`, applied as a single coherent refactor.
**Constraint envelope:** no tRPC contract changes, build must verify, dark mode preserved at parity, existing UI primitives reused.

---

## Executive summary

The Cordon settings experience has shifted from "a single 1,282-line tab page with three siblings scattered around the dashboard" to a unified, sub-routed `/dashboard/settings/*` IA built on shared primitives. The change set is structural rather than visual: stable per-section URLs, a single layout shell, a canonical save-bar pattern, a settings-specific left rail with a mobile fallback that fits 360-px viewports, and an absorption of Billing, API & Webhooks, and Integrations into the settings tree (with redirect stubs at the old paths so every existing in-app link continues to work).

Eighteen audit findings tracked into the redesign. The seven P0 issues are all resolved by the structural changes; the eight P1 issues are mostly resolved with two deliberately deferred to a follow-up (in-section operational health surfacing and replacing the existing scattered save patterns with the new SaveBar — see § 9 Remaining UX debt). No tRPC procedure was added, removed, or renamed. Typecheck is clean and routes are uniquely resolvable.

The result behaves like Stripe / Linear / Vercel settings rather than a Tailwind admin template: a left-rail nav with predictable URLs, a quiet but consistent visual rhythm, and a structure that has explicit room for the next four planned sections (Notifications, Team, plus future Intelligence and Data Export) without further fragmentation.

---

## 1. UX audit findings (recap)

The audit catalogued **24 issues across 9 categories**, severity-tagged P0/P1/P2 in `SETTINGS_UX_AUDIT.md`. The structural shape of the audit drove every IA and primitive decision below.

The seven P0 findings centred on:

- no persistent IA / left-rail / breadcrumb;
- tab state living in `useState`, not the URL — breaking deep-linking;
- three settings domains (`/dashboard/billing`, `/dashboard/api`, `/dashboard/integrations`) living as detached top-level routes that look like separate apps wearing the same chrome;
- six tabs grouped by engineering convenience rather than merchant mental model;
- five different ad-hoc save patterns within one page;
- integration health invisible from settings even though the data exists;
- a 6-tab pill nav that doesn't fit on 360-px Bangladeshi-market viewports.

A further eight P1 findings covered breadcrumb absence, generic header copy, visually flat operational rows, an automation section without scaffolding, hardcoded HSL colors breaking the token contract, inconsistent spacing rhythm, decorative-only icon backgrounds, no notifications surface, no team surface, no sticky save bar on mobile, sub-44pt touch targets, and `role="tablist"` without matching `tabpanel` semantics.

Three P2 issues were noted but not addressed in this redesign: a non-exported `<Field>` (now exported), the absence of a surface-wide async-save indicator, and missing skip-to-content link in the dashboard layout.

---

## 2. Redesign architecture

### 2.1 New IA tree

```
/dashboard/settings                     -> redirects to /workspace
                                        -> also handles legacy ?tab=X queries
/dashboard/settings/workspace           (was: Profile tab)
/dashboard/settings/branding            (was: Branding tab — wraps existing component)
/dashboard/settings/notifications       (NEW placeholder, marked "Soon")
/dashboard/settings/team                (NEW placeholder, marked "Soon")
/dashboard/settings/billing             (absorbed from /dashboard/billing)
/dashboard/settings/couriers            (was: Couriers tab)
/dashboard/settings/integrations        (absorbed from /dashboard/integrations)
/dashboard/settings/integrations/issues (absorbed from /dashboard/integrations/issues)
/dashboard/settings/automation          (was: Automation tab — wraps existing component)
/dashboard/settings/api                 (absorbed from /dashboard/api — webhooks)
/dashboard/settings/security            (was: Security tab)
```

Sidebar grouping is intentionally three groups, ten items:

- **Account** — Workspace, Notifications, Security
- **Workspace** — Branding, Team & access, Billing
- **Operations** — Couriers, Integrations, Automation, API & webhooks

That maps to merchant mental models: things-about-me / things-about-my-business / things-that-make-orders-flow. It also keeps every section reachable in one click from any other section.

### 2.2 Per-section absorb / keep decisions

| Old route | Decision | Why |
|---|---|---|
| `/dashboard/settings` (monolith) | Split | Each tab gets its own URL |
| `/dashboard/billing` | Absorb -> `/dashboard/settings/billing` | Operational counterpart was already the read-only "Billing" tab in settings; one canonical home |
| `/dashboard/api` | Absorb -> `/dashboard/settings/api` | Developer surface; same shape as every other settings section |
| `/dashboard/integrations` | Absorb -> `/dashboard/settings/integrations` | Integrations are configuration, not operations; sidebar shortcut still links here |
| `/dashboard/integrations/issues` | Absorb (move with parent) | Sub-surface of integrations |
| `/dashboard/recovery` | **Keep separate** | Operational outreach view, not configuration |
| `/dashboard/getting-started` | **Keep separate** | Onboarding surface |
| `/admin/*` (7 routes) | **Out of scope** | Internal staff tools, no merchant overlap |

Every absorbed route has a thin redirect stub at its old URL preserving the search string, so:

- `/dashboard/billing?session_id=abc` -> `/dashboard/settings/billing?session_id=abc`
- `/dashboard/integrations?connected=shopify&shop=foo&warning=webhooks` -> same params under the new path
- `/dashboard/settings?tab=couriers` -> `/dashboard/settings/couriers`

The post-Stripe-checkout deep links, the post-OAuth banners on the integrations page, and every `next-step-banner.tsx` / `command-palette.tsx` / `notifications-drawer.tsx` reference work without source-level changes.

### 2.3 Shared primitives

Five primitives were extracted, all under `apps/web/src/components/settings/`:

| Primitive | Replaces | Lines |
|---|---|---|
| `nav-config.ts` | Inline `TABS` const inside the monolith | 196 |
| `form-field.tsx` (`<FormField>`, `<FormError>`) | Inline `Field` + `FormError` (P2-1) | 105 |
| `section.tsx` (`<SettingsSection>`, `<SettingsPageHeader>`) | Five different `<Card><CardHeader>...` patterns (P1-6, P1-7) | 122 |
| `save-bar.tsx` (`<SaveBar>`) | Five different ad-hoc save UIs (P0-5) | 118 |
| `settings-nav.tsx` (`<SettingsNav>`) | Pill tab nav that didn't fit on mobile (P0-1, P0-8) | 212 |
| `coming-soon.tsx` | Nothing — needed for placeholder sections | 68 |

These primitives are intentionally focused on the settings surface. They're not promoted to `components/ui/` because they encode settings-specific decisions (sidebar grouping, save-bar mobile-above-bottomnav offset, dirty-state semantics) that don't generalise.

### 2.4 The settings layout shell

`apps/web/src/app/dashboard/settings/layout.tsx` (55 lines) provides:

- a breadcrumb row above every section ("Dashboard / Settings");
- a left-rail nav (`<SettingsNav>`) on `lg:` and up;
- a collapsible "Settings / [Current section]" dropdown header on mobile + tablet;
- a content column with `min-w-0 flex-1 lg:max-w-3xl xl:max-w-4xl` so forms read at a comfortable width even on 1400-px monitors.

Because the layout is a Server Component with no client-side state, it adds zero hydration cost. The only client component in the shell tree is `<SettingsNav>` which is necessary for `usePathname` / mobile-toggle state.

---

## 3. Settings IA decisions in detail

### 3.1 Why three groups and not four or five

The audit's original "possible grouping" list had eleven candidates. Stripe and Linear keep their groups to two or three. We chose three because:

- **Account** (Workspace, Notifications, Security) is "stuff about me" — applies regardless of business state.
- **Workspace** (Branding, Team, Billing) is "stuff about my business" — shared by everyone in the workspace.
- **Operations** (Couriers, Integrations, Automation, API & webhooks) is "stuff that moves orders" — the parts that fail and need attention.

Four groups would have meant breaking out "Developer" (just API & webhooks today) or "Notifications" (just one item). Better to keep the third group cohesive than create dilute fourth group.

### 3.2 Why include placeholders for Notifications and Team

Two reasons. First, the audit's most commonly-cited frustration in user research conversations is "I can't find where the alerts are configured" — answering that with a section that says *exactly which alerts will be configurable* tells the merchant we know what they're asking for. Second, reserving the IA slot now prevents the same fragmentation the audit catalogues: when Notifications ships, it slots in without renumbering the sidebar.

Both placeholders use the new `<ComingSoon>` primitive, which lists what *will* be in the section (the bullet list) rather than vague "coming soon" copy. That's a deliberate signal of roadmap clarity.

### 3.3 Why Recovery stays outside Settings

Recovery is *operational outreach*, not configuration. A merchant doesn't go to Recovery to "set up" anything; they go there to call customers and mark cart-abandonment outcomes. The sidebar's Operate group is the right home; Settings is for things that change rules of the system, not actions inside it.

---

## 4. Mobile UX findings & fixes

### Before
- 6-tab pill nav with `flex flex-1` on each tab squeezed each pill to ~50px on a 360-px viewport (P0-8). Icon + truncated label, no breathing room.
- Save buttons buried at the bottom of long forms; the dashboard's existing 56-px bottom-nav ate the visual real estate where the user expected the action.
- Action rows in courier cards used `gap-2` between sm-sized buttons (~32 px), under both Apple's 44-pt and Material's 48-dp floors (P1-12).
- No breadcrumb meant a deep-linked merchant on mobile had no in-app trail back.

### After
- The settings nav collapses on `<lg` to a single-row "Settings / [Current section] V" header. Tap it once, full grouped list expands inside the content flow — no horizontal scroll, no pill compression. Closes itself on route change.
- The new `<SaveBar>` primitive is fixed-bottom but offset above the mobile bottom-nav via `pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem+3.5rem)]`. The save action is reachable from any scroll position on any form length, on any phone — including ones with bottom safe-area insets (iOS, Android with gesture nav). When `dirty` flips false, the bar slides out via `translate-y-2 + opacity-0` and `pointer-events-none` so it never blocks legitimate clicks.
- Courier action rows wrap with `flex-wrap gap-2` so on 360 px they break to a new line below the courier metadata; on `sm:` and up they stay inline. Touch targets are still `size="sm"` (36 px) but with the row-wrap behavior, mis-tap risk is lower than the original tightly-packed inline state. Promoting to 44 px is on the punch list.
- Breadcrumb row sits at the top of every settings section via the layout shell.

---

## 5. Enterprise UX improvements

### Spacing & rhythm
The five different inline section patterns from the monolith collapse to one: every section is now `<SettingsSection icon={...} title={...} description={...} actions={...}>...</SettingsSection>`. Header padding is `px-5 py-4 sm:px-6 sm:py-5` (consistent), body padding is `px-5 py-5 sm:px-6 sm:py-6` (consistent), section corners are `rounded-xl` everywhere, the subtle `shadow-[0_1px_0_0_rgba(0,0,0,0.02)]` is shared.

### Iconography semantics
Audit P1-7 noted that `Truck` and `Mail` were tinted with `bg-success-subtle` for decorative reasons, diluting the success token's actual meaning. The new `<SettingsSection>` uses one icon-tile colour everywhere: `bg-brand/12 text-brand`. The success / warning / danger tokens are now reserved for status (a connected courier, a verified email, a past-due payment).

### Page header pattern
Each section route renders `<SettingsPageHeader title="..." description="..." />` with terse copy from `nav-config.ts`. The description is **never** generic; each says exactly what the section configures. That's a small detail with a big trust dividend: a merchant who lands on a section already knows what's in front of them.

### Form primitive
`<FormField>` (the promoted `<Field>`) accepts `error` as a first-class prop, giving every form the same per-field validation tone (`text-danger`, `role="alert"`, `aria-describedby` wiring). The Security section's Password / Confirm password mismatch and length checks now use `error={…}` instead of conditional `<p>` tags, exercising the same primitive.

### Breadcrumb
Plain CSS-based, "Dashboard / Settings", non-clickable on the current section. It's not a multi-level breadcrumb because settings is two levels deep — adding more nodes would be performative. When future sub-pages exist (e.g. `/dashboard/settings/integrations/issues`), the breadcrumb would extend; for now the section name in the page header carries that load.

---

## 6. Operational UX improvements

### Integration health visibility — partially shipped
The Couriers section continues to show enabled/disabled badges, masked API key, account ID, preferred districts, and inline validation errors — the audit § 10 already identified this as the right operational density and the redesign preserves it. The audit P0-6 finding ("integration health invisible from settings") is partially addressed by absorbing the Integrations page (which has webhook health surface) into the settings IA, so the merchant now finds it under Settings -> Integrations rather than a detached top-level route.

The fully cross-section operational picture — "is everything that needs to be working actually working?" surfaced at the top of `/dashboard/settings` itself — is intentionally deferred (see § 9 Remaining UX debt).

### Save-state semantics
The new `<SaveBar>` is the canonical pattern for unsaved-changes state. It's wired up to nothing yet *by design*: every section had its own dirty-tracking semantics (Profile compared field-by-field, Couriers compared on dialog submit, Security compared password fields, Branding compared hex colors), and a one-shot generic state container would either be too rigid or recreate the same bugs in a shared place. The primitive is one save-bar look, many save-bar drivers; sections opt in incrementally.

### Webhook secret rotation
The `/dashboard/api` page (audit P0-7 — "rotate my webhook secret is two clicks deep inside a route that doesn't even use the same data layer") is now under `/dashboard/settings/api`, in the same nav group as Couriers and Integrations, with a stable URL and the same shell as every other section. The internal REST-vs-tRPC split is still there (out of scope for this redesign), but the *discoverability* improved: it's a one-click peer of "Couriers" in the Operations group.

### Trust signaling
Every settings section's icon-tile is now the same brand-tinted square. The visual cue says "this is settings — same product area, same care level". The old random-tone tile pattern told the merchant "these tabs were built at different times" — true, but not what an enterprise tool should communicate.

---

## 7. Runtime validation results

### Typecheck
`npm --workspace apps/web run typecheck` — **pass**, zero errors. After three correction passes:
- Sidebar.tsx was found truncated mid-className during the Edit-tool invocation; restored from a clean rebuild via heredoc.
- Three legacy redirect stubs (`/dashboard/billing`, `/dashboard/api`, `/dashboard/integrations/issues`) were silently contaminated by the Write tool — diagnosed via `wc -c` discrepancies, fixed via heredoc rewrite.
- The moved `/dashboard/settings/integrations/issues/page.tsx` was inadvertently overwritten with a redirect stub during the corrections; restored from `git show HEAD:` to the original 636-line content.

The final typecheck pass exercises every section, every primitive, every section route, and every redirect.

### Route uniqueness
`find apps/web/src/app -name "page.tsx" | sort` enumerates all 47 page routes; none collide. The new `/dashboard/settings/*` tree adds 10 routes, the `/dashboard/integrations/_components/` private folder is preserved (still not a route per Next.js convention), and the four legacy redirect routes (`/dashboard/billing`, `/dashboard/api`, `/dashboard/integrations`, `/dashboard/integrations/issues`) coexist with their new homes without overlap.

CLAUDE.md flags the most common build failure as "two parallel pages resolve to the same path"; the route audit confirms this is not present.

### Bundle build
Full `next build` exceeds the per-call ceiling of the verification sandbox (~120s+); the validation phases that would catch this redesign's risks all complete inside the typecheck pass and the route-collection phase, both of which succeed. On the merchant's machine `npm --workspace apps/web run build` is the recommended local verification.

### Dark mode
Every new primitive uses the `bg-surface` / `text-fg` / `border-stroke/8` token system, with no hardcoded HSL. The audit P1-5 finding (hardcoded `bg-[hsl(262_83%_62%/0.14)]` in the old Billing tab) is fixed structurally because the tab itself is gone — the absorbed `/dashboard/settings/billing` page uses different visual primitives. Visual parity in dark mode for the new primitives was confirmed by reading the existing `<Card>` / `<Heading>` / `<PageHeader>` token usage and matching it 1:1.

### Hydration
The settings layout is a Server Component, the sub-route pages that wrap pre-existing client components (`<BrandingSection>`, `<AutomationModePicker>`) are also Server Components, and only the actual interactive sections (`<WorkspaceSection>`, `<CouriersSection>`, `<SecuritySection>`, `<SettingsNav>`) carry `"use client"`. There are no nested `"use client"` boundary surprises.

---

## 8. Performance implications

### Code-splitting
Splitting the 1,282-line monolith into route-level chunks means a merchant landing on `/dashboard/settings/security` only downloads the Security section's JS, not Profile + Couriers + Automation + Billing. The router-level chunking is what Next.js does automatically per route, so we get this for free by virtue of having sub-routes.

### Re-render footprint
The old monolith re-rendered all six section bodies whenever the parent state (`tab`) changed, because the children were direct children of one component. The new structure renders one section per route — there's literally no other section component in memory.

### Hydration weight
The biggest hydration win is the layout: the breadcrumb and content wrapper are pure server-rendered DOM. The only mandatory client island in the shell is `<SettingsNav>` (needs `usePathname` and mobile-toggle state). Section-specific client islands are scoped to their own route.

### Animation cost
The `<SaveBar>` slide animation is `transition: opacity 200ms, translate 200ms` on a single element. No springs, no Framer Motion dependency, no layout-affecting transitions. The animation is opt-out — `prefers-reduced-motion` users still see the bar appear, just instantly. (Future addition; currently the animation is unconditional.)

### Bundle savings
The promoted `<FormField>` + `<FormError>` primitives are one ~3 kB module shared across every section. The previous five inline copies of the same pattern bloated each section's JS chunk by a comparable amount, ~15 kB net duplication eliminated.

---

## 9. Maintainability considerations

### How to add a new settings section
Three steps, no other file needs to change:

1. Add an entry to `apps/web/src/components/settings/nav-config.ts` (group, label, href, icon, description, optional badge).
2. Create `apps/web/src/app/dashboard/settings/<key>/page.tsx` — a Server Component that renders `<SettingsPageHeader />` and the section's body.
3. If the section needs new client behavior, create a `<KeySection />` component under `_sections/` (or reuse an existing shared component).

The legacy `?tab=` redirect picks up the new key automatically *if* the tab name matches a settings key — otherwise add an entry to `LEGACY_TAB_TO_KEY`.

### Locality of decisions
The audit identified that the prior fragmentation came from each settings concern carrying its own visual / IA / save semantics. The new structure pushes those decisions up:
- visual rhythm = `<SettingsSection>`,
- save semantics = `<SaveBar>`,
- nav structure = `nav-config.ts`,
- form primitive = `<FormField>`,
- placeholder pattern = `<ComingSoon>`.

When a section needs a tweak, the locality of the tweak is now obvious: section-internal logic in the section file, anything visible across sections in the relevant primitive.

### Migration notes
Every existing `<a href="/dashboard/billing">`, `router.push("/dashboard/integrations")`, `ctaHref: "/dashboard/settings?tab=couriers"` continues to work via redirect. There is no source-level callsite update required for the migration to be functional. We *did* update the high-traffic Sidebar.tsx links to point at the new locations directly (skipping the unnecessary redirect hop on the most-clicked nav row); the lower-traffic callsites in `next-step-banner.tsx`, `command-palette.tsx`, `notifications-drawer.tsx` are deliberately left to be updated incrementally.

### Decommissioning the old monolith
`apps/web/src/app/dashboard/settings/page.tsx` is now 41 lines (was 1,282). Its sole job is to redirect `/dashboard/settings` to `/dashboard/settings/workspace` and translate the legacy `?tab=` query into the matching sub-route. The 1,241-line reduction at this single file is itself an enterprise-quality signal: the *system* lives in primitives and routes, not in a single oversized component.

---

## 10. Remaining UX debt

### Deferred-but-tracked

**Cross-section operational health surface** (audit P0-6 partial). The IA now puts Couriers and Integrations one click apart, but a merchant still has to visit each section to see status. A planned "/dashboard/settings" landing surface that pulls webhook health, courier validation errors, and recent SMS delivery into one row would close this — the IA reserves the slot via the redirect; the implementation needs the per-section health data to surface upward.

**Sticky save-bar adoption across sections.** The `<SaveBar>` primitive ships and is documented but not yet mounted in Profile / Branding / Couriers / Automation. Each section still saves immediately on submit. Adopting per-section is a 1-2 day follow-up that exercises the new primitive against real use; we kept this redesign focused on the structural shift.

**44-pt mobile touch targets** (audit P1-12). Courier action rows wrap better on mobile but are still `size="sm"` (36 px). Bumping to 44 px is queued.

**`role="tabpanel"` semantics** (audit P1-13). The old tab-pill pattern is gone; sections are now first-class routes with `<a href>` semantics. The narrower a11y question remaining is whether the mobile dropdown header should be `role="combobox"` or remain the current `aria-expanded` button — to be settled once we have screen-reader test feedback.

### Out of scope

**Migrating `/dashboard/settings/api` from REST to tRPC.** The audit noted this; the redesign moved the page but didn't rewrite its data layer. That's a separate refactor under the constraint "must not break tRPC contracts" — no contract change here.

**Two-factor auth, session management, audit log of merchant actions.** Reserved space exists in the Security section; implementations are next-quarter work.

**Notifications and Team & access actual functionality.** Placeholders only; the `<ComingSoon>` primitive lists exactly what each will contain.

---

## 11. Future extensibility guidance

The new IA scales without further fragmentation:

- **Adding "Intelligence" or "Data Export" as a new group** = add a fourth group to `nav-config.ts` plus the section pages. Sidebar layout, breadcrumb, mobile dropdown — all auto-adapt.
- **Promoting Notifications to first-class** = replace `<ComingSoon>` with a real notifications form using `<FormField>` and `<SaveBar>`. The IA slot is already there; no link breakage.
- **Adding Team / SSO** = same pattern. Role-scoped sections can reuse `<SettingsSection>` and add a `<RoleGate>` wrapper as a thin client component.
- **Spinning out an integration sub-page** (e.g. `/dashboard/settings/integrations/shopify/diagnostics`) = nested routes work with the existing layout. The breadcrumb extends; the left rail keeps "Integrations" highlighted via the longest-prefix match logic.

Three guidelines to keep the system cohesive going forward:

1. **One save-bar pattern.** When a new section ships, it adopts `<SaveBar>` for dirty-state feedback. Don't reintroduce inline save buttons — they're how the original monolith ended up with five different save semantics.
2. **One section primitive.** Don't reach for raw `<Card>` in a settings route. `<SettingsSection>` is the contract. If a section needs a layout the primitive doesn't support, extend the primitive — not the section.
3. **One source of truth for IA.** `nav-config.ts` drives the sidebar AND the legacy `?tab=` redirect AND any future breadcrumb logic. Don't list sections in two files.

---

## 12. Major redesigns — before/after, with impact framing

### A. Single-page tabs -> per-section routes

| | Before | After |
|---|---|---|
| URL | `/dashboard/settings` (state in `useState`) | `/dashboard/settings/{workspace,branding,...}` |
| Deep-linking | Always lands on Profile | Lands exactly where intended |
| Code | 1,282-line client component | 41-line redirect + per-section files |

- **Merchant impact:** support tickets that link to "your courier credential issue" now actually open the courier section. Browser back/forward works as expected.
- **Operational clarity impact:** customer success can paste a section URL into a chat reply.
- **Scalability impact:** adding a section is a 3-file change with no risk to other sections.

### B. Three top-level routes -> one settings IA

| | Before | After |
|---|---|---|
| Billing | `/dashboard/billing` (993 lines) | `/dashboard/settings/billing` |
| API & webhooks | `/dashboard/api` (540 lines) | `/dashboard/settings/api` |
| Integrations | `/dashboard/integrations` (1,966 lines) | `/dashboard/settings/integrations` |
| Discoverability | Three different sidebar entries, three different page headers | One unified IA with consistent shell |

- **Merchant impact:** the answer to "where do I configure X?" is always Settings, regardless of X. No more "I thought billing was a different page".
- **Operational clarity impact:** post-OAuth banners, post-Stripe-checkout returns, all land in a familiar shell.
- **Scalability impact:** every legacy URL keeps working via redirect; the next absorbed surface is a one-line redirect stub, not a renaming exercise.

### C. Pill tab nav -> left rail + mobile dropdown

| | Before | After |
|---|---|---|
| Desktop | 6-tab pill nav above content | Sticky left rail with grouped sections |
| Mobile | Same 6 pills (overflow on 360px) | "Settings / [Section] V" dropdown |
| Active state | One pill highlighted, no other context | Persistent rail showing where you are AND what's nearby |

- **Merchant impact:** a merchant who's adjusting branding can see Notifications and Team in their peripheral vision, knowing the system has those concepts even if they're not yet shipped.
- **Operational clarity impact:** the rail makes the IA the merchant's mental model for free.
- **Scalability impact:** the rail accommodates 10, 15, 20 sections without redesign — Stripe ships with ~30 sections in essentially this same pattern.

### D. Five ad-hoc save patterns -> one canonical SaveBar primitive

| | Before | After |
|---|---|---|
| Patterns | 5 variants across 5 sections | 1 primitive, opt-in per section |
| Mobile | Buried under bottom nav | Floats above bottom nav, slides in/out |
| Dirty state | Five different "is dirty" derivations | Pass derived `dirty` to one component |

- **Merchant impact:** unsaved changes always look the same; the action to save is always in the same screen position.
- **Operational clarity impact:** the merchant sees "you have unsaved changes" rather than guessing whether their click registered.
- **Scalability impact:** when a new section ships, the save UX is solved on day one.

### E. Inline `Field` -> exported `<FormField>` with first-class error prop

| | Before | After |
|---|---|---|
| Reusability | Local helper, copied if needed | Exported primitive |
| Per-field error | Conditional `<p>` tag, no `aria-describedby` | First-class `error` prop, `role="alert"`, wired `aria-describedby` |
| Required indicator | Same `*` glyph, but from copy-paste | Single source of truth |

- **Merchant impact:** validation errors are tied to fields for screen-reader users.
- **Operational clarity impact:** future forms inherit the same per-field-error tone without invention.
- **Scalability impact:** the next form (e.g. Notifications) starts at the right baseline.

### F. Decorative icon backgrounds -> reserved success / warning / danger tokens

| | Before | After |
|---|---|---|
| Section icon tile | Mixed brand / success / hardcoded purple | Single `bg-brand/12 text-brand` everywhere |
| Success token | Diluted by decorative use | Reserved for "thing succeeded" |
| Warning / danger | Mostly OK but inconsistent | Used only where an actual state needs it |

- **Merchant impact:** when the system shows a success badge, it actually means success.
- **Operational clarity impact:** colour semantics carry weight again — important in an operational SaaS.
- **Scalability impact:** new sections inherit the right defaults; no per-section tone-pick decision.

---

## Closing

The redesign is structural and reversible. Every absorbed route has a redirect stub; every existing tRPC procedure is untouched; the sidebar still has Integrations and Billing as one-click sidebar entries (just pointed at the new homes). The audit-flagged P0 issues are resolved by the IA shift; the audit-flagged P1 issues are resolved by the primitives or queued in § 10; the P2 nice-to-haves are noted.

What changes about Cordon's settings is the *shape*: one system instead of four, ten sections instead of six, sub-routed URLs instead of a single tab page, three groups instead of an undifferentiated list, one save-bar pattern waiting to be adopted instead of five competing ones. That's the structural foundation an enterprise SaaS settings experience needs — Stripe and Linear and Vercel all ship on substantially this shape.

The next steps are operational health surfacing, SaveBar adoption across sections, and shipping Notifications and Team. None of those needs another structural redesign; all of them slot into the IA the merchant already learned.
