import { test, expect } from "@playwright/test";
import { E2E, adminActivate, fetchMerchantId, uniqueMerchant } from "./fixtures";

/**
 * Golden path — merchant onboarding confidence.
 *
 *   signup → trial → connect CSV → create order → upgrade → plan reflects
 *
 * One spec, run serially. Each numbered step is an `await test.step(...)`
 * so failures point straight at the broken stage in the report.
 *
 * Notes on the upgrade leg:
 *   We exercise the "manual payment + admin approval" path because it is
 *   100% in-house (no third-party dependency on Stripe Checkout / SMS /
 *   bKash). The Stripe flows are unit-tested in `apps/api/tests/sprintB`
 *   and `sprintD`; this spec confirms the dashboard reflects the resulting
 *   active state correctly — that's the regression we care about.
 */

test.describe("merchant golden path", () => {
  test("signup → trial → connect CSV → create order → upgrade → plan reflects", async ({
    page,
    request,
  }) => {
    const merchant = uniqueMerchant();

    await test.step("1. Signup creates the workspace and lands on the dashboard", async () => {
      await page.goto("/signup");
      await page.getByLabel("Business name").fill(merchant.businessName);
      await page.getByLabel("Email").fill(merchant.email);
      await page.getByLabel("Password").fill(merchant.password);
      await page.getByRole("button", { name: /create account/i }).click();
      // Signup auto-signs the merchant in and bounces to /dashboard/orders.
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    });

    await test.step("2. Trial state is visible (banner or onboarding checklist)", async () => {
      await page.goto("/dashboard");
      // Onboarding checklist header is the most stable trial signal —
      // present whenever any setup step is incomplete (always at signup).
      await expect(page.getByText(/get set up/i).first()).toBeVisible();
    });

    await test.step("3. Connect a CSV provider", async () => {
      await page.goto("/dashboard/integrations");
      // The CSV provider card lives under heading "CSV import". Scope the
      // Connect click to that card so we don't hit the wrong provider.
      const csvCard = page
        .locator('div:has(h3:has-text("CSV import"))')
        .first()
        .or(page.locator('[data-testid="provider-card-csv"]'));
      await csvCard.scrollIntoViewIfNeeded();
      await csvCard
        .getByRole("button", { name: /connect/i })
        .first()
        .click();

      // ConnectDialog for csv has an optional Label field + a Create button.
      await page.getByLabel(/label/i).fill("E2E CSV");
      await page.getByRole("button", { name: /create/i }).click();

      // Connection appears in the Connections list with the label we entered.
      await expect(page.getByText(/^E2E CSV$/i).first()).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step("4. Create an order via the dashboard form", async () => {
      await page.goto("/dashboard/orders");
      await page.getByRole("button", { name: /create order/i }).click();
      await page.getByLabel("Customer name").fill("Sprint E Customer");
      await page.getByLabel("Customer phone").fill("+8801711111111");
      await page.getByLabel("Address").fill("12 Test Lane");
      await page.getByLabel("District").fill("Dhaka");
      await page.getByLabel("Item name").fill("Widget");
      await page.getByLabel("Quantity").fill("1");
      await page.getByLabel("Price").fill("500");
      await page.getByLabel("COD amount").fill("500");
      await page.getByRole("button", { name: /create order$/i }).click();

      // The dialog closes on success and the orders table refreshes; the
      // new row's customer name appears inside the rendered cell.
      await expect(
        page.getByText(/^Sprint E Customer$/).first(),
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("5. Submit a manual payment for the Growth plan", async () => {
      await page.goto("/dashboard/billing");
      // Choosing the Growth plan via the manual button auto-fills the form.
      // The card uses 4 plan tiles — pick Growth's "Pay manually" button.
      const growthCard = page
        .locator('div:has(h3:has-text("Growth"))')
        .first();
      await growthCard
        .getByRole("button", { name: /pay manually/i })
        .first()
        .click();

      // Form is now pre-filled with plan=growth + amount=2499.
      await page.getByLabel(/transaction id/i).fill("E2E-TXN-GOLDEN");
      await page.getByRole("button", { name: /submit payment$/i }).click();
      await expect(
        page.getByText(/payment submitted/i).first(),
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("6. Admin activates the merchant on Growth", async () => {
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
        tier: "growth",
        request,
      });
    });

    await test.step("7. Billing page reflects the new plan", async () => {
      await page.goto("/dashboard/billing");
      // Current-plan card title becomes "Growth"; the "Current plan" badge
      // attaches to the Growth column in the catalogue.
      await expect(
        page.getByRole("heading", { name: /^growth$/i }).first(),
      ).toBeVisible({ timeout: 15_000 });
      // Status pill flips off "trial" — assert "active" instead.
      await expect(page.getByText(/^active$/i).first()).toBeVisible();
    });
  });
});
