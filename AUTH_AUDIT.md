# Cordon — Auth & Production-Readiness Audit

**Scope:** `apps/web/src/app/(marketing)` vs `(auth)/login`, `(auth)/signup`, `forgot-password`, `reset-password`. Plus a sweep for missing must-have pages.

**Top-line finding:** The landing page and the auth pages look like they belong to two different products. The landing is **Cordon** — bold, premium, lime-on-black, with a serif-italic accent. The auth shell brands itself **"Logistics"** in generic blue with a square `L` logo. A user clicking "Start free trial" on the hero is teleported to a different visual identity, breaks emotional continuity, and loses the conversion runway built in the marketing copy.

---

## 1. Design system summary (extracted from landing)

| Token | Landing (`landing.module.css`) | Auth (`globals.css` / Tailwind) | Match? |
|---|---|---|---|
| Brand wordmark | **Cordon** with green pulse dot | **Logistics** with blue `L` square | ❌ different brand |
| Background | `#0A0A0B` (near-black) | `#0B0E1A` blue-tinted, with brand-blue radial glow | ❌ |
| Primary surface | `#111113` / `#18181B` (warm neutral) | `hsl(228 26% 14%)` ≈ `#1A1D2E` (cool blue) | ❌ |
| Border | `#27272A` neutral | `hsl(220 13% 85% / 0.14)` cool, much lighter alpha | ❌ |
| Accent / primary | `#C6F84F` lime + `#8AE619` hover | `#0084D4` enterprise blue + `#0072BB` hover | ❌ different hue |
| Foreground | `#FAFAFA` | `#F3F4F6` | ✓ close |
| Body type | Inter, 16px, `letter-spacing: -0.005em` | Inter, **14px** | ❌ smaller, denser |
| Display type | Inter 600 + `Instrument_Serif` italic accents | Inter 600, **no serif** | ❌ tone-shaping serif lost |
| Mono | JetBrains Mono on eyebrows / numbers / labels | Available but **never used in auth** | ❌ |
| Card radius | `22px` (`--c-radius-lg`) | `rounded-2xl` = **16px** | ❌ |
| Card style | Surface + 1px border + hover lift + green hairline gradient | Surface + 1px stroke + `shadow-elevated` | ⚠ similar shape, different texture |
| Button (primary) | Lime fill, dark text, hover lift + glow shadow | Blue fill, white text, no lift | ❌ |
| Section eyebrow | `mono` uppercase pill, lime text, `01 / The bleed` style | None | ❌ |
| Tone | Bold, premium, emotive: "You're losing ৳540,000+", "Stop the bleed", "We give it back" | Generic SaaS: "Welcome back", "Sign in to your merchant workspace" | ❌ |

**Spacing on landing:** `section { padding: 120px 0 }`, container `max-width 1200px`, card padding `32px`, gaps `12-16px`. **Spacing on auth:** `p-7` (28px), card `max-w-md`. Different rhythm.

---

## 2. Auth page issues

### 2.1 Common to all four pages

1. **Wrong brand identity.** `(auth)/layout.tsx` renders a `Logistics` wordmark and a blue square logo. Landing brands as `Cordon` with a green pulse dot. Two products, one repo.
2. **Wrong accent color.** Buttons, focus rings, links and badges use `bg-brand` (blue `#0084D4`). Landing primary is lime `#C6F84F` with a glow. The auth CTA reads as a different SKU.
3. **Wrong typography.** No `Instrument_Serif` italic anywhere. The serif is the single most distinctive type voice on the landing — it's how "we give it back" hits — and it's absent in the auth headlines.
4. **Wrong card silhouette.** `rounded-2xl` (16px) vs the landing's 22px. Subtle on its own, screams "different design system" alongside the color and font drift.
5. **Background tone.** Auth uses a blue radial glow + cool surfaces. Landing uses a lime radial + warm neutrals. The first thing the eye reads is the gradient, and it's the wrong color.
6. **No social proof on the form side.** Landing leans hard on `200+ merchants`, `৳45 Cr+ RTO prevented`, `99.9% webhook delivery`, and a microquote. None of that survives the click into auth — the value column on the left only restates the marketing pitch in lower-fidelity form, then disappears entirely on mobile.
7. **No SSO / "Continue with Google".** For a B2B SaaS aimed at e-commerce founders, Google is the dominant inbox. Adding it lifts conversion and cuts password reset churn.
8. **No password visibility toggle.** Login, signup, reset all hide the password without a `show` button. Increases typo failures, especially on mobile.
9. **Inconsistent post-auth landing.** Login → `/dashboard`. Reset → `/dashboard/orders`. Pick one, document why; don't surprise people who just rotated their password.

### 2.2 Login (`(auth)/login/page.tsx`)

- ✓ Solid security hardening (`method=post`, dummy `action`, `preventDefault` — well-commented).
- ❌ Headline `Welcome back` is generic; for a returning Cordon merchant, the equivalent landing voice would be `Welcome back. The pipeline kept running.` or similar — small touch, big tone shift.
- ❌ "Forgot?" link is `text-xs` and uses `text-fg-muted`. Easy to miss; one of the highest-friction parts of any auth flow.
- ❌ No "Stay signed in" / remember-me. NextAuth sessions are cookie-driven, but users still want the affordance.
- ❌ Error message `Invalid email or password` is correct from a security standpoint but the surface is jarring (red bordered alert) for a typo. Landing tone would acknowledge: `That combination didn't work. Try again or reset.`
- ❌ `callbackUrl` is read but never echoed back to the user, so a deep-link-then-login hop has no breadcrumb.

### 2.3 Signup (`(auth)/signup/page.tsx`)

- ✓ Plan badge on `?plan=growth` is a nice touch.
- ✓ `businessName` first-field ordering is correct — sets the workspace mental model.
- ❌ Headline `Create your workspace` is fine, but `Start managing your logistics in under 60 seconds` is generic and uses the wrong product noun (landing says **Cordon**, never "logistics platform").
- ❌ **No password strength meter on signup**, but `reset-password` has one. Same form, same risk, inconsistent affordance.
- ❌ **No "we'll never spam you / 14-day trial / no card" inline reassurance** even though those exact phrases live in `hero-meta` on the landing. The trust pills in the value column are desktop-only.
- ❌ Phone field marked `(optional)` is ambiguous — for a BD merchant base whose courier APIs (Pathao/Steadfast) require phone, this should at least say `Used for courier OTP and ops alerts`.
- ❌ No password requirements visible until the user fails. Should be a passive hint under the input ("8+ characters; passphrases work great").
- ❌ Submit button copy `Create account` is correct but loses the conversion language. Landing says `Start saving today →` — swapping in "Start your trial →" or "Stop the bleed →" mirrors the entry-point CTA the user just clicked.
- ❌ No legal microcopy ("By creating an account, you agree to Terms / Privacy"). Required for a paid SaaS launch.

### 2.4 Forgot password (`forgot-password/page.tsx`)

- ✓ Submitted-state copy is well-handled (`If an account exists for X…`) — correct enumeration-resistant pattern.
- ✓ "Try a different email" affordance is good.
- ❌ Lives **outside** the `(auth)` route group, so it does **not** inherit the value column / value prop. It shows the form on a near-empty page. Either move it under `(auth)/forgot-password` or duplicate the layout.
- ❌ No rate-limit messaging. If the user hits the form 6 times, they should see a friendly throttle copy, not a 429.
- ❌ "Couldn't process your request" error is muddy — was it a network failure, a service outage, an invalid email format that slipped past Zod? Tighten it.
- ❌ Reset-link expiry (60 minutes) is buried inside the success-state body — a user reading the email at 3am won't remember it. Repeat the expiry in the email itself if not already.

### 2.5 Reset password (`reset-password/page.tsx`)

- ✓ Token-missing fallback is well-handled.
- ✓ Strength meter is a nice touch; auto-login after success is a great conversion move.
- ❌ Same shell mismatch as forgot-password — lives outside `(auth)` and has no value column.
- ❌ Strength labels: `["Too short", "Weak", "Fine", "Strong"]`. **"Fine"** is conversational mush; use `"Okay"` or just `"Good"`. Better still, color the bar and skip the label.
- ❌ Auto-redirect lands on `/dashboard/orders` on success, while login lands on `/dashboard`. Pick one — the "fresh-merchant onboarding" comment in `login/page.tsx` argues for `/dashboard` everywhere.
- ❌ No "successfully reset, all other sessions logged out" reassurance. Standard security UX pattern.
- ❌ No feedback if the token is **expired** vs **invalid** vs **already used** — they all surface as a generic error string from the API. Differentiate.

### 2.6 Conversion leaks (cross-cutting)

- The exit-intent modal, floating loss indicator, and pricing highlighter on the landing are **non-existent** post-click. The user goes from a high-stimulus, narrative-rich page to a quiet form with no continuation of the loss story.
- The hero's `eyebrow.pulse` (a green dot pulse) signals "live, watching, on" — that affordance never appears in auth. Add a tiny live-status pill ("৳45 Cr+ RTO prevented this year") inside the value column.
- "14-day trial · no card" is the strongest hesitation-killer on the landing. It must appear on the signup card itself, not just the desktop value column.

---

## 3. Fix recommendations (no structural rewrites)

### 3.1 Token alignment (one PR, ~30 min)

In `apps/web/src/app/globals.css`, replace these CSS vars to match landing:

```css
:root {
  --surface-base: 240 4% 5%;        /* #0A0A0B */
  --surface:      240 4% 7%;        /* #111113 */
  --surface-raised: 240 4% 10%;     /* #18181B */
  --surface-overlay: 240 5% 12%;    /* #1F1F23 */
  --stroke-default: 240 5% 26%;     /* #3F3F46 */
  --brand:        76 92% 64%;       /* #C6F84F lime */
  --brand-hover:  85 84% 50%;       /* #8AE619 */
  --brand-fg:     240 6% 5%;        /* black text on lime */
}
```

Add a `--c-radius-lg: 22px` and apply via a `rounded-cordon` Tailwind utility on the auth card.

Do **not** flip the body gradient yet — that's app-wide and dashboards may regress. Override it locally inside `(auth)/layout.tsx` only.

### 3.2 Auth shell (`(auth)/layout.tsx`)

- Replace the `L` square with the landing's logo dot + `Cordon` wordmark.
- Swap the blue radial-glow gradient for `radial-gradient(900px 360px at 50% -160px, hsl(76 92% 64% / 0.18), transparent 70%)`.
- Move `forgot-password` and `reset-password` **into** `(auth)/` so they inherit this shell.
- In the value column, replace generic features with the landing's hardest signals:
  - `200+ BD merchants on Cordon`
  - `৳45 Cr+ RTO prevented in the last 12 months`
  - `99.9% webhook delivery — zero silent drops`
- Keep the trust pills (`AES-256 at rest`, `Audit-logged`, `Role-based access`) — they're great.

### 3.3 Login

- Headline: `Welcome back to Cordon.`
- Subhead: `Sign in to your merchant workspace.` (keep)
- Move "Forgot?" to `text-sm font-medium text-fg-muted` and reposition it as part of the field's bottom-right (current placement is fine, but bump it from `text-xs`).
- Add a password visibility toggle (right-side icon button inside the input).
- Below the submit button, add `Continue with Google` — wires into NextAuth's existing Google provider; one-line code change.
- Repeat the trust microline from landing under the form: `14-day trial · no card · Pay via bKash, Nagad, or card`. Remove the existing "No account?" footer line and combine.
- Primary button copy stays `Sign in` — this is a return path, not a conversion CTA.

### 3.4 Signup

- Headline: `Stop shipping to fraudsters.` (lifted directly from final-CTA on landing).
- Subhead: `Create your Cordon workspace. 14-day trial. No card.`
- Add password requirements **passively** under the input: `8+ characters. A passphrase works great.`
- Add the strength meter from `reset-password/page.tsx` — the component is already written.
- Phone field: change `(optional)` helper to `Used for courier OTP and ops alerts. Optional.`
- Submit button: `Start saving →` (mirrors landing CTA), with the `→` arrow animation already on landing (`btn:hover .arrow { transform: translateX(4px) }`).
- Below the form, add a single line: `By creating an account, you agree to our Terms and Privacy Policy.` Linked.
- Below that, the trust band condensed: `200+ BD merchants · ৳45 Cr+ RTO prevented · Setup in under 10 minutes`.

### 3.5 Forgot password

- Move into `(auth)/forgot-password/page.tsx` so it inherits the shell. Update `login/page.tsx` Link target — it's already `/forgot-password` so no change needed (the new route group resolves the same URL).
- Tighten the error: `We couldn't reach our reset service. Try again in a moment.` (network) vs `Too many requests — wait 5 minutes and try again.` (rate-limit). Switch on the API response code, not a single string.
- In the submitted state, lift the 60-min expiry up: `Check your inbox — the link expires in 60 minutes.` is the H2 sub.

### 3.6 Reset password

- Move into `(auth)/reset-password/page.tsx`.
- Strength labels: `["Too short", "Weak", "Good", "Strong"]` (replace `"Fine"`).
- On success, change the body to: `Password updated. We've signed out every other session. Taking you to your dashboard…`
- Land on `/dashboard` (not `/dashboard/orders`), matching login.
- Differentiate API errors: `expired`, `already_used`, `invalid` → three different copy variants. Backend already returns `body.error` — switch on it.

### 3.7 Cross-cutting CTA / copy alignment

| Surface | Current | Replace with |
|---|---|---|
| Login submit | `Sign in` | (keep) |
| Signup submit | `Create account` | `Start saving →` |
| Login subhead | `Sign in to your merchant workspace.` | (keep) |
| Signup subhead | `Start managing your logistics in under 60 seconds.` | `Create your Cordon workspace. 14-day trial. No card.` |
| Forgot subhead | `Enter your email and we'll send you a reset link.` | `Enter the email on your Cordon account. We'll send a reset link.` |

---

## 4. Missing pages for production

### Already shipped

`/dashboard`, `/dashboard/getting-started`, `/dashboard/integrations`, `/dashboard/integrations/issues`, `/dashboard/billing`, `/dashboard/settings`, `/dashboard/orders`, `/dashboard/analytics/*`, `/dashboard/recovery`, `/verify-email`, `/legal/{privacy,terms}`, `/pricing`, `/track`. Solid coverage.

### Must-have, currently missing

| Page | Purpose | Must contain | Why it converts / retains |
|---|---|---|---|
| `app/not-found.tsx` (404) | Catch unknown routes with on-brand fallback | Cordon mark, "this page slipped past us", primary CTA back to `/dashboard` (or `/`), search/contact link | Generic Next 404 leaks Vercel chrome; trust killer. |
| `app/error.tsx` (root error boundary) | Catch render errors without blanking the app | Friendly message, `Try again` button (calls `reset()`), Sentry/issue link | Without it, a single thrown error wipes the page. Standard SaaS reliability bar. |
| `app/(auth)/verify-email/sent/page.tsx` | Post-signup "check your email" success | Email shown, resend button (rate-limited), wrong-address link, support link | Closes the signup loop emotionally. Today the user hits `/dashboard` immediately on signup, so verification is silent — easy to forget about, easy to bounce later. |
| `app/(billing)/payment-success/page.tsx` | Stripe / bKash receipt confirmation | Plan name, amount, next billing date, "View receipt", "Back to dashboard" | Reduces refund/dispute churn. Critical for bKash receipts where the verification is manual. |
| `app/(billing)/payment-failed/page.tsx` | Mirror of above when card declines | Reason, "Try another card", contact support, **don't** auto-redirect | First-touch failure today drops user into a generic toast. |
| `app/dashboard/team/page.tsx` | Invite + manage seats | Members list, role dropdown, invite form, pending invites | Multi-merchant support is in `settings/merchants` already, but a `team` view (operators per merchant) is the standard. |
| `app/dashboard/api/page.tsx` (or `developer/`) | API keys, webhook secrets, signing keys | Generate / rotate / revoke keys, copy-once secrets, webhook test fire, signing-key reveal with re-auth gate | The landing leans hard on idempotent webhooks and HMAC signing — there's nowhere in the app to actually inspect those today. |
| `app/dashboard/integrations/{shopify,woocommerce,pathao,steadfast,redx}/page.tsx` | Per-integration setup wizards | Step-by-step: paste API key, test webhook, backfill toggle, status badge | Today a single integrations page enumerates them. A wizard per integration cuts setup-failure tickets in half. |
| `app/status/page.tsx` (public) | Webhook delivery, courier connector health | Live indicators per provider, last-incident summary, subscribe-to-incidents | Landing claims `99.9% webhook delivery` — back it with a public page. Massive trust signal. |
| `app/dashboard/audit-log/page.tsx` | Admin audit trail | Who did what, when, IP, diff | Required for SOC-2-adjacent enterprise sales (already promised in trust pills). |
| `app/dashboard/notifications/page.tsx` | Per-event email/Slack/SMS routing | Event types (high-risk order, RTO recovered, courier failed), channel toggles | Without it, every alert becomes the founder's inbox. |
| `app/(marketing)/changelog/page.tsx` | Public ship log | Date, headline, screenshot/diff | Trust signal that the platform is alive. ~30 min/month of upkeep. |
| `app/(marketing)/blog/[slug]/page.tsx` | SEO + objection-handling | The 6 FAQ items on landing → 6 ranking articles | Landing FAQ is already written; turn each into an indexable post. |

### Critical error states inside the app

- **Failed webhook screen** under `/dashboard/integrations/issues` exists — verify it covers retry-exhausted vs DLQ vs auth-failed as separate states (each needs its own remediation copy).
- **Courier-down banner** at the top of `/dashboard/orders` when a circuit breaker has tripped — pulled from the breaker state your landing already advertises.
- **Stale-session reauth modal** (when JWT expires mid-action). Today an action just fails silently.

---

## 5. Priority roadmap

### HIGH (do this before any paid acquisition)

1. **Brand the auth surface as Cordon.** Logo, wordmark, tokens, accent color. Single-PR scope.
2. **Move `forgot-password` and `reset-password` under `(auth)/`** so they inherit the value column.
3. **Add `app/not-found.tsx` and `app/error.tsx`.** One file each, Cordon-skinned. Production launch table-stakes.
4. **Signup CTA + trust band rewrite.** `Start saving →`, repeat `200+ merchants`, `14-day trial · no card`, `setup in under 10 minutes` directly on the form card.
5. **`/payment-success` + `/payment-failed`.** Cordon takes bKash receipts — a manual verification flow without confirmation pages is brittle.
6. **Reset/login post-auth landing alignment.** Both go to `/dashboard`.

### MEDIUM (before Series-A or first 50 paying)

7. **Google SSO on login + signup.** One-line NextAuth provider, large conversion lift.
8. **Password visibility toggle** on all three password inputs.
9. **Password strength meter on signup** (component already exists in `reset-password`).
10. **`/dashboard/api/`** for keys + webhook secrets — landing makes a promise the app can't yet show.
11. **Per-integration setup wizards** under `/dashboard/integrations/{slug}/`.
12. **`/dashboard/team`** and **`/dashboard/audit-log`** — both required for the "audit-logged · role-based access" trust pills.
13. **Public `/status` page.** Backs the `99.9%` claim.
14. **Verify-email "sent" page** post-signup.

### LOW (polish; ship between sprints)

15. Strength label `Fine` → `Good`.
16. Differentiated reset-token errors (`expired` vs `used` vs `invalid`).
17. Inline password requirement hint on signup.
18. Legal microcopy under signup submit.
19. `/changelog` and `/blog` shells — SEO compounding.
20. "We've signed out other sessions" copy on reset success.
21. Stale-session reauth modal.
22. Phone-field helper copy on signup (`Used for courier OTP…`).
23. Animated `→` arrow on auth CTAs (already in landing CSS, just port the rule).

---

**Estimated effort:**
- HIGH: ~1.5 dev days.
- MEDIUM: ~1 sprint (5 dev days).
- LOW: ~2 dev days, drop-in any time.

The HIGH bucket is what stops the hardest conversion leak: a user who clicked `Start free trial` on a green-on-black premium landing page and lands on a blue, generic auth shell labeled `Logistics`. Fixing that alone is worth more than all the medium- and low-priority items combined.
