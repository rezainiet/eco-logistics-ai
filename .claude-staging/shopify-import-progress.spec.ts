import { test, expect } from "@playwright/test";
import { uniqueMerchant, waitForAuthCallback } from "./fixtures";

/**
 * Shopify import-progress visibility — guards the bug where the import
 * modal could show `imported = 0 / failed = 0 / duplicates = 0` after
 * the merchant clicked Import, leaving them with no actionable signal.
 *
 * The whole point of this spec is the post-import assertion at the end:
 *   imported + failed + duplicates > 0  OR  lastError is rendered.
 *
 * If the upstream Shopify call succeeds (mocked or real), the modal must
 * report the actual counts. If the call fails (which is the e2e default
 * — the FAKE_ACCESS_TOKEN doesn't authenticate against real Shopify),
 * the modal must surface `lastError` rather than three silent zeroes.
 *
 * What this DOESN'T cover and why:
 *   - We don't intercept outbound HTTPS from the API process to fake a
 *     200 from Shopify. Driving that requires a sidecar mock server in
 *     the e2e-stack. The unit-test layer (apps/api/tests/
 *     shopifyMissingPhone.test.ts) already pins the exact accounting
 *     behaviour for the success path, and this spec verifies the modal
 *     correctly reflects whatever the worker decides.
 */

const SHOP = "e2e-import-store.myshopify.com";
const FAKE_API_KEY = "e2e_test_api_key_aaaaaaaaaaaaaaaa";
const FAKE_API_SECRET = "e2e_test_api_secret_bbbbbbbbbbbbbbbb";
const FAKE_ACCESS_TOKEN = "shpat_e2e_test_token_cccccccccccccccccccc";

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

test.describe("Shopify import — modal never silently shows imported=0/failed=0", () => {
  test("clicking Import surfaces a definitive outcome (counts or lastError)", async ({
    page,
  }) => {
    const merchant = uniqueMerchant();

    await test.step("1. Sign up", async () => {
      await page.goto("/signup");
      await page.getByLabel("Business name").fill(merchant.businessName);
      await page.getByLabel("Email").fill(merchant.email);
      await page.getByLabel("Password").fill(merchant.password);
      await Promise.all([
        waitForAuthCallback(page),
        page.getByRole("button", { name: /create account/i }).click(),
      ]);
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    });

    await test.step("2. Connect Shopify (custom-app fast path)", async () => {
      await page.goto("/dashboard/integrations");
      const shopifyCard = page.locator('[data-testid="provider-card-shopify"]');
      await shopifyCard.scrollIntoViewIfNeeded();
      await shopifyCard
        .getByRole("button", { name: /^connect$/i })
        .first()
        .click();
      await page.getByLabel("Your Shopify store address").fill(SHOP);
      await fillAdvancedShopifyCredentials(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /continue to shopify/i })
        .click();
      await expect(page.getByText(SHOP).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("3. Click Import recent", async () => {
      const row = page
        .locator(`text=${SHOP}`)
        .first()
        .locator("xpath=ancestor::*[self::div or self::li][1]");
      await row.getByRole("button", { name: /^import recent$/i }).click();
    });

    await test.step("4. Modal renders and reaches a terminal state", async () => {
      const dialog = page.getByRole("dialog");
      // The modal opens immediately in "Import queued" state.
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Wait for a terminal title — the modal title transitions through
      // "Import queued" → "Importing orders…" → "Import complete" /
      // "Import failed".
      await expect(
        dialog.getByText(/^(Import complete|Import failed)$/i),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("5. Outcome is definitive — counts OR lastError", async () => {
      const dialog = page.getByRole("dialog");

      // Read the three count tiles. Each one renders a single integer.
      async function readTile(label: RegExp): Promise<number> {
        const tile = dialog
          .locator("div", { has: page.getByText(label) })
          .first();
        const value = await tile.locator("div").last().innerText();
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : 0;
      }
      const imported = await readTile(/^imported$/i);
      const duplicates = await readTile(/^duplicates$/i);
      const failed = await readTile(/^failed$/i);

      // The pre-fix bug allowed all three to be zero with no lastError.
      // Post-fix, EITHER the counts are non-zero OR the lastError block
      // is rendered (the worker stamps a meaningful message: "missing
      // phone", "shopify 401: invalid api key", etc.).
      const total = imported + duplicates + failed;
      const errorBlock = dialog.locator("pre");
      const hasError = (await errorBlock.count()) > 0;

      expect(
        total > 0 || hasError,
        `import modal must show counts > 0 or a lastError — got imported=${imported}, duplicates=${duplicates}, failed=${failed}, hasError=${hasError}`,
      ).toBe(true);
    });
  });
});
