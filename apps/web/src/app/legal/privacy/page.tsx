import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Logistics Cloud",
  description:
    "How Logistics Cloud collects, processes, retains, and redacts merchant + customer data.",
};

/**
 * Privacy Policy page.
 *
 * Required by Shopify Partner program for any Public Distribution app
 * (listed or unlisted). Linked from the Partner-app config "Privacy
 * Policy URL" field. Reviewers check that:
 *
 *   - The page is publicly reachable (no auth wall).
 *   - It names what data we collect, why, retention, and the
 *     mechanism for customer / shop data deletion.
 *   - The contact email actually exists.
 *
 * Update the placeholder values (company legal name, support email,
 * physical address if your jurisdiction requires it) before flipping
 * the app to production.
 */
export default function PrivacyPolicyPage() {
  return (
    <article className="prose prose-invert max-w-none">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="text-sm text-fg-subtle">
        Last updated: {new Date().toISOString().split("T")[0]}
      </p>

      <section className="mt-8 space-y-4 text-sm leading-relaxed text-fg-muted">
        <p>
          Logistics Cloud (&ldquo;we&rdquo;, &ldquo;us&rdquo;) provides
          ecommerce-logistics software to merchants. This policy explains what
          data we collect, why, how we store it, who we share it with, and
          how merchants and their customers can request access or deletion.
        </p>
        <p>
          We act as a <strong>data processor</strong> for the personal data
          our merchant customers (the <strong>data controllers</strong>) push
          into our platform. Our merchants are responsible for obtaining the
          legal basis to collect the personal data they bring to us; we are
          responsible for handling that data per their instructions and per
          this policy.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold">1. What data we collect</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          <strong>From merchants who sign up directly:</strong> business name,
          email address, phone number (optional), password (stored as a
          bcrypt hash &mdash; never the plaintext), branding (logo, theme
          colour), subscription tier, billing transaction references.
        </p>
        <p>
          <strong>From connected commerce platforms (Shopify, WooCommerce,
          Custom API, CSV import):</strong> orders and the customer details
          on those orders &mdash; customer name, email, phone, shipping
          address, line items, totals, fulfilment status. We also receive
          shop-level metadata (shop name, plan, primary currency).
        </p>
        <p>
          <strong>From operational telemetry:</strong> call-centre call logs
          (tied to orders), webhook delivery audit trail, fraud signals
          (phone + address fingerprints, stored as one-way SHA-256 hashes
          &mdash; never reversible to the original number / address),
          tracking events from courier integrations.
        </p>
        <p>
          <strong>From the storefront behavior tracker (optional, opt-in by
          the merchant):</strong> anonymised browsing + cart-intent events
          tied to a hashed visitor identifier. Identity is resolved to a
          known customer only when the visitor submits their phone or email
          on the merchant&rsquo;s site.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">2. Why we collect it</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Strictly to deliver the contracted service: order management,
          fraud scoring, customer outreach (recovery / call-centre), courier
          dispatch, analytics for the merchant. We do not sell merchant or
          customer data to anyone, ever.
        </p>
        <p>
          We aggregate anonymised usage telemetry across merchants to improve
          the product (for example, to set sensible defaults for fraud
          scoring weights). Aggregated metrics never reveal individual
          merchants or customers.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">3. How we store and protect it</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Production data lives in a managed MongoDB cluster with at-rest
          encryption. Access tokens (Shopify, WooCommerce consumer keys) are
          encrypted with AES-256-GCM before being written to the database;
          the decryption key lives in a separate secret store and rotates on
          a defined schedule.
        </p>
        <p>
          Passwords are stored as bcrypt hashes with a per-installation
          salt. We never see, log, or transmit plaintext passwords. Sessions
          use HTTP-only signed cookies with CSRF double-submit protection.
        </p>
        <p>
          All inbound webhooks (Shopify, WooCommerce, custom API) are
          verified via HMAC-SHA256 over the raw request bytes before any
          database write. A 5-minute freshness window blocks replay attacks
          using captured payloads.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">4. Retention</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Merchant data is retained for the lifetime of the merchant&rsquo;s
          subscription. When a merchant uninstalls our Shopify app, Shopify
          notifies us via the <code>shop/redact</code> webhook 48 hours
          later, after which we delete every row tied to that merchant
          &mdash; orders, calls, tracking, fraud history, audit log, the
          integration row itself.
        </p>
        <p>
          Webhook delivery records (the audit trail of incoming events) are
          retained for 90 days for debugging and SLA verification, then
          purged.
        </p>
        <p>
          Aggregated, fully-anonymised analytics may be retained
          indefinitely.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">5. Customer data requests</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          If a customer of one of our merchants asks the merchant for their
          data, the merchant relays the request to Shopify, which forwards
          us a <code>customers/data_request</code> webhook. We log the
          request to our audit trail. Per our processor / controller
          relationship, the merchant fulfils the data subject access request
          using the data they hold; we are available to them to extract
          additional context if needed.
        </p>
        <p>
          If a customer asks to be erased, Shopify forwards us a{" "}
          <code>customers/redact</code> webhook. Within 30 days of receipt
          we pseudonymise that customer&rsquo;s identifying fields across
          our order, call-log, recovery, tracking, audit, and webhook
          inbox collections. Aggregated analytics remain because they no
          longer identify the individual.
        </p>
        <p>
          A customer who wants to skip the merchant and contact us directly
          may email <a href="mailto:privacy@logisticscloud.example">privacy@logisticscloud.example</a>.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">6. Sub-processors</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          We use the following third-party processors. Each handles only the
          data necessary for its named purpose, under contractual data
          protection commitments.
        </p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <strong>MongoDB Atlas</strong> &mdash; primary database hosting.
          </li>
          <li>
            <strong>Stripe</strong> &mdash; subscription billing. Card
            details never reach our servers; we receive only an opaque
            customer / subscription id.
          </li>
          <li>
            <strong>Twilio / SendGrid</strong> &mdash; transactional SMS
            and email. Recipient phone / email only; never order or
            payment details.
          </li>
          <li>
            <strong>Shopify, WooCommerce</strong> &mdash; merchant has
            authorised the bidirectional sync.
          </li>
          <li>
            <strong>Cloud hosting provider</strong> &mdash; runs our API
            and web tier. No application data is stored in their object
            storage outside the database.
          </li>
        </ul>
      </div>

      <h2 className="mt-10 text-xl font-semibold">7. Cookies</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Our dashboard uses session cookies for authentication and CSRF
          protection. We do not use third-party advertising or analytics
          cookies on our dashboard. Our marketing site uses minimal
          first-party analytics for traffic counts.
        </p>
        <p>
          The optional storefront behavior tracker that merchants can
          install on their own site uses cookies only when explicitly
          enabled by the merchant. The merchant is responsible for its
          consent surface on their storefront.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">8. Changes to this policy</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          We will post material changes here at least 30 days before they
          take effect, and notify active merchants by email. The
          &ldquo;last updated&rdquo; date at the top of this page is the
          authoritative timestamp.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">9. Contact</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Questions about this policy or about how we handle data:{" "}
          <a href="mailto:privacy@logisticscloud.example">
            privacy@logisticscloud.example
          </a>
          .
        </p>
        <p>
          For Shopify-mandated privacy webhooks, the receiver is at{" "}
          <code>/api/webhooks/shopify/gdpr</code> on our production API
          domain.
        </p>
      </div>
    </article>
  );
}
