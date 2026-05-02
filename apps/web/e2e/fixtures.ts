/**
 * Shared helpers for the Playwright e2e suite.
 *
 * The constants below mirror what `scripts/e2e-stack.mjs` injects into the
 * API and Web processes. Don't edit one without the other — secrets must
 * line up so the back-channel admin call (used to flip a merchant's plan
 * from inside a test) succeeds.
 */

export const E2E = {
  apiUrl: "http://localhost:4000",
  webUrl: "http://localhost:3001",
  adminSecret: "e2e-admin-secret-at-least-twenty-four-chars",
};

/**
 * Generate a unique merchant identity for a single spec run.
 *
 * The suffix mixes timestamp + random so two parallel runs (or retries)
 * never collide on the unique-email index.
 */
export function uniqueMerchant() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `e2e-${suffix}@logistics.test`,
    password: "e2e-test-password-1234",
    businessName: `E2E Co ${suffix}`,
  };
}

/**
 * Read a merchant's id by re-authenticating against the API. We don't try
 * to crack the NextAuth cookie — too brittle. Instead we POST to
 * `/auth/login` with the credentials we just signed up with; the API
 * returns the merchant id in the response.
 */
export async function fetchMerchantId(args: {
  apiUrl: string;
  email: string;
  password: string;
  request: import("@playwright/test").APIRequestContext;
}): Promise<string> {
  const res = await args.request.post(`${args.apiUrl}/auth/login`, {
    data: { email: args.email, password: args.password },
    headers: { "content-type": "application/json" },
  });
  if (!res.ok()) {
    throw new Error(`fetchMerchantId: login failed ${res.status()}`);
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("fetchMerchantId: response missing id");
  return body.id;
}

/**
 * Activate a merchant's subscription via the back-channel admin endpoint.
 *
 * This is the "operator approves a manual payment" path — same code that
 * the back-office tool uses. We trigger it from the test so we don't have
 * to spin up Stripe Checkout (mock or real) just to verify the dashboard
 * reflects a paid state.
 */
export async function adminActivate(args: {
  apiUrl: string;
  adminSecret: string;
  merchantId: string;
  tier: "starter" | "growth" | "scale" | "enterprise";
  request: import("@playwright/test").APIRequestContext;
}) {
  const res = await args.request.post(`${args.apiUrl}/admin/activate`, {
    headers: {
      "content-type": "application/json",
      "x-admin-secret": args.adminSecret,
    },
    data: {
      merchantId: args.merchantId,
      tier: args.tier,
      actor: "e2e-runner",
    },
  });
  if (!res.ok()) {
    throw new Error(`adminActivate: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}
