import { test, expect } from "@playwright/test";
import {
  E2E,
  adminActivate,
  fetchMerchantId,
  uniqueMerchant,
} from "./fixtures";

/**
 * Shopify connect flow — merchant-facing surface.
 *
 * What this spec covers (deterministic, no Shopify outbound HTTP):
 *   - Inline shop-domain validation (good vs bad inputs disables/enables
 *     the "Continue to Shopify" button)
 *   - Custom-app credentials path: Advanced disclosure → fill all 3 fields
 *     → click "Continue to Shopify" → integration appears in Connections
 *     list as "connected" (when an accessToken is supplied directly the
 *     backend skips OAuth entirely and lands the row in connected state)
 *   - One-shop-per-provider UI guard fires for a SECOND distinct shop on
 *     a plan that has the headroom for it (we admin-activate to Scale
 *     tier first so we don't trip the count cap before reaching the
 *     guard). The card flips to a disabled "Connected" pill.
 *   - Disconnect (trash button) → reconnect a DIFFERENT shop succeeds
 *     (soft-delete + guard release)
 *
 * What this spec does NOT cover — and why:
 *   - The OAuth callback path (`/api/integrations/oauth/shopify/callback`)
 *     is a server-side handler that calls Shopify's Admin API to exchange
 *     the auth code for a token and to fetch shop info. Driving it
 *     end-to-end requires either a real Shopify install (depends on an
 *     external auth UI, MFA, partner-app config) or intercepting outbound
 *     HTTPS from the API process. Neither belongs in this UI-focused
 *     spec — covered by API integration tests instead.
 *   - Webhook auto-registration (also outbound HTTP) for the same reason.
 *
 * Notes on the e2e stack:
 *   - `scripts/e2e-stack.mjs` does NOT inject SHOPIFY_APP_API_KEY/SECRET
 *     env vars, so the dialog renders the "Custom-app credentials needed"
 *     warning and Advanced is force-opened. We type apiKey + apiSecret +
 *     accessToken into those fields.
 */

const SHOP_A = "e2e-store-a.myshopify.com";
const SHOP_B = "e2e-store-b.myshopify.com";
const FAKE_API_KEY = "e2e_test_api_key_aaaaaaaaaaaaaaaa";
const FAKE_API_SECRET = "e2e_test_api_secret_bbbbbbbbbbbbbbbb";
// Any non-empty token is enough. The connect handler stores it encrypted
// and lands the integration in "connected" status without exchanging it
// against Shopify (that's only the OAuth-callback path, which we don't
// trigger here).
const FAKE_ACCESS_TOKEN = "shpat_e2e_test_token_cccccccccccccccccccc";

/** Helper: fill the Advanced credentials block. Force-opens it if the
 *  disclosure happens to be collapsed (it is auto-opened when the platform
 *  Shopify env vars are unset, which is the e2e default — but defending
 *  against the variant keeps the helper reusable). */
async function fillAdvancedShopifyCredentials(
  page: import("@playwright/test").Page,
) {
  const apiKeyInput = page.getByLabel("API key", { exact: true });
  if (!(await apiKeyInput.isVisible().catch(() => false))) {
    await page
      .getByRole("button", { name: /advanced \(for developers\)/i })
      .click();
  }
  await apiKeyInput.fill(FAKE_API_KEY);
  await page.getByLabel("API secret key", { exact: true }).fill(FAKE_API_SECRET);
  await page
    .getByLabel(/admin api access token \(optional\)/i)
    .fill(FAKE_ACCESS_TOKEN);
}

test.describe("merchant connects Shopify (custom-app path)", () => {
  test("validate domain, connect, see in list, disconnect, reconnect different shop", async ({
    page,
    request,
  }) => {
    const merchant = uniqueMerchant();

    await test.step("1. Sign up and land on dashboard", async () => {
      await page.goto("/signup");
      await page.getByLabel("Business name").fill(merchant.businessName);
      await page.getByLabel("Email").fill(merchant.email);
      await page.getByLabel("Password").fill(merchant.password);
      await page.getByRole("button", { name: /create account/i }).click();
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    });

    await test.step("2. Open the Shopify connect dialog", async () => {
      await page.goto("/dashboard/integrations");
      const shopifyCard = page.locator('[data-testid="provider-card-shopify"]');
      await shopifyCard.scrollIntoViewIfNeeded();
      await shopifyCard
        .getByRole("button", { name: /^connect$/i })
        .first()
        .click();
      await expect(
        page.getByRole("dialog").getByText(/connect shopify/i),
      ).toBeVisible();
    });

    await test.step("3. Inline domain validation rejects bogus input", async () => {
      const domainInput = page.getByLabel("Your Shopify store address");
      // Submit button text is "Continue to Shopify" — that's the OAuth
      // verb. ("Connect" would be misleading because the actual connect
      // happens on Shopify's grant screen.)
      const submitBtn = page
        .getByRole("dialog")
        .getByRole("button", { name: /continue to shopify/i });

      await domainInput.fill("not-a-shopify-domain.com");
      await expect(
        page.getByText(/use your shopify store address like/i),
      ).toBeVisible();
      await expect(submitBtn).toBeDisabled();

      await domainInput.fill(SHOP_A);
      await expect(submitBtn).toBeEnabled();
    });

    await test.step("4. Fill Advanced credentials and submit", async () => {
      await fillAdvancedShopifyCredentials(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /continue to shopify/i })
        .click();
      // The dialog closes and the integration appears in the Connections
      // section. Asserting on row content is more stable than asserting
      // on the toast (toasts are ephemeral).
      await expect(page.getByText(SHOP_A).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("5. Connections list shows status 'connected'", async () => {
      // Use a row-scoped locator anchored on the unique accountKey text.
      const row = page
        .locator(`text=${SHOP_A}`)
        .first()
        .locator("xpath=ancestor::*[self::div or self::li][1]");
      await expect(row.getByText(/connected/i).first()).toBeVisible();
    });

    await test.step("6. Bump merchant to Scale (so 2nd integration has headroom)", async () => {
      // Starter & Growth cap maxIntegrations at 1 — without bumping we'd
      // hit `integration_count_capped` before reaching the per-provider
      // guard, which is a different code path.
      const merchantId = await fetchMerchantId({
        apiUrl: E2E.apiUrl,
        email: merchant.email,
        password: merchant.password,
        request,
      });
      await adminActivate({
        apiUrl: E2E.apiUrl,
        adminSecret: E2E.adminSecret,
        merchantId,
        tier: "scale",
        request,
      });
      await page.reload();
    });

    await test.step("7. Shopify card is now LOCKED — shows disabled 'Connected'", async () => {
      await page.goto("/dashboard/integrations");
      const shopifyCard = page.locator('[data-testid="provider-card-shopify"]');
      await shopifyCard.scrollIntoViewIfNeeded();

      // The "Connect" button is replaced by a disabled "Connected" pill
      // pointing at SHOP_A — that IS the merchant-facing one-shop guard.
      // (The server-side guard is also covered, in apps/api/tests.)
      const connectedBtn = shopifyCard.getByRole("button", {
        name: /^connected$/i,
      });
      await expect(connectedBtn).toBeVisible();
      await expect(connectedBtn).toBeDisabled();
      // Tooltip / title attribute names the existing store — verifies
      // the merchant gets actionable info, not just "blocked".
      await expect(connectedBtn).toHaveAttribute(
        "title",
        new RegExp(`already connected to ${SHOP_A}`, "i"),
      );

      // SHOP_B must NOT have crept into the list.
      await expect(page.getByText(SHOP_B)).toHaveCount(0);
    });

    await test.step("8. Disconnect SHOP_A", async () => {
      const row = page
        .locator(`text=${SHOP_A}`)
        .first()
        .locator("xpath=ancestor::*[self::div or self::li][1]");

      // The trash button now has an aria-label ("Disconnect integration")
      // — without it the icon-only button has no accessible name and
      // screen readers / Playwright's role queries can't find it.
      await row
        .getByRole("button", { name: /disconnect integration/i })
        .click();

      // Disconnect fires immediately (no confirmation modal). Soft-delete:
      // the row's status flips to "disconnected" and the list query
      // filters it out.
      await expect(page.getByText(SHOP_A)).toHaveCount(0, { timeout: 10_000 });
    });

    await test.step("9. Reconnect SHOP_B — guard has released, new shop accepted", async () => {
      const shopifyCard = page.locator('[data-testid="provider-card-shopify"]');
      await shopifyCard
        .getByRole("button", { name: /^connect$/i })
        .first()
        .click();
      await page.getByLabel("Your Shopify store address").fill(SHOP_B);
      await fillAdvancedShopifyCredentials(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /continue to shopify/i })
        .click();
      await expect(page.getByText(SHOP_B).first()).toBeVisible({
        timeout: 15_000,
      });
    });
  });
});
