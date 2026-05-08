import type { Metadata } from "next";
import { getBrandingSync } from "@ecom/branding";

const _brand = getBrandingSync();

export const metadata: Metadata = {
  title: `Terms of Service — ${_brand.name}`,
  description: `Terms governing use of the ${_brand.name} platform.`,
};

/**
 * Terms of Service page.
 *
 * Required by Shopify Partner program for Public Distribution apps.
 * Linked from the Partner-app config "Terms of Service URL" field.
 *
 * Update placeholders (legal entity name, jurisdiction, support email)
 * before going live.
 */
export default function TermsOfServicePage() {
  return (
    <article className="prose prose-invert max-w-none">
      <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="text-sm text-fg-subtle">
        Last updated: {new Date().toISOString().split("T")[0]}
      </p>

      <section className="mt-8 space-y-4 text-sm leading-relaxed text-fg-muted">
        <p>
          These terms govern your use of the Cordon service
          (&ldquo;Service&rdquo;). By creating an account, connecting a
          commerce platform, or otherwise using the Service, you
          (&ldquo;Merchant&rdquo;, &ldquo;you&rdquo;) agree to these terms.
          If you are using the Service on behalf of a company, you confirm
          you have authority to bind that company.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold">1. The Service</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Cordon provides ecommerce-logistics tooling: order sync
          from connected commerce platforms, fraud scoring, customer
          outreach, courier dispatch, and analytics. Specific feature
          availability depends on your subscription tier; see{" "}
          <a href="/pricing">Pricing</a> for details.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">2. Account &amp; security</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          You are responsible for keeping your account credentials secure
          and for all activity that happens under your account. Notify us
          at <a href={`mailto:${_brand.supportEmail}`}>{_brand.supportEmail}</a>{" "}
          immediately if you suspect unauthorised access.
        </p>
        <p>
          You must be at least 18 years old (or the age of majority in
          your jurisdiction) to use the Service.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">3. Acceptable use</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>You agree not to:</p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            Use the Service to send unsolicited bulk messages
            (&ldquo;spam&rdquo;) to your customers or anyone else.
          </li>
          <li>
            Attempt to access another merchant&rsquo;s data, probe the
            platform for vulnerabilities without an authorised security
            test agreement, or otherwise interfere with the integrity of
            the Service.
          </li>
          <li>
            Use the Service to process transactions for goods or services
            that are illegal in your jurisdiction.
          </li>
          <li>
            Reverse-engineer, decompile, or otherwise attempt to derive
            the source code of the Service except where such restrictions
            are expressly prohibited by applicable law.
          </li>
        </ul>
      </div>

      <h2 className="mt-10 text-xl font-semibold">4. Subscription &amp; billing</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          The Service is offered on a subscription basis. Trial periods,
          plan features, and pricing are described on the{" "}
          <a href="/pricing">Pricing page</a> and may change with at
          least 30 days&rsquo; notice for active subscribers.
        </p>
        <p>
          We accept payment via the methods listed in the dashboard. You
          authorise us (and our billing processor) to charge your chosen
          payment method on the recurring schedule of your selected plan.
        </p>
        <p>
          Refunds are issued at our discretion, typically only for
          duplicate charges or service unavailability beyond our SLA.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">5. Customer data</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          You remain the data controller for any personal data your
          customers provide. We act as the data processor and handle that
          data per our <a href="/legal/privacy">Privacy Policy</a> and
          per your instructions. You confirm you have the legal basis to
          collect and share that data with us.
        </p>
        <p>
          On request via the standard Shopify privacy webhooks
          (<code>customers/redact</code>, <code>shop/redact</code>) or by
          email to <a href={`mailto:${_brand.privacyEmail}`}>{_brand.privacyEmail}</a>,
          we will redact or delete data per the timelines in our Privacy
          Policy.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">6. Service availability</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          We aim for high availability but make no absolute uptime
          guarantee outside what is committed in your subscription tier.
          Scheduled maintenance is announced in advance via the dashboard
          and email. Emergency security maintenance may occur without
          notice.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">7. Termination</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          You may cancel your subscription at any time from the dashboard.
          We may suspend or terminate your account if you violate these
          terms or the acceptable use policy in section 3. On termination,
          your data will be retained per our Privacy Policy retention
          schedule.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">8. Warranty disclaimer</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTY OF
          ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
          IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
          PURPOSE, AND NON-INFRINGEMENT.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">9. Limitation of liability</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT
          SHALL LOGISTICS CLOUD BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
          PROFITS OR REVENUE, ARISING OUT OF OR IN CONNECTION WITH THE
          SERVICE. OUR TOTAL LIABILITY UNDER THESE TERMS IS LIMITED TO
          THE AMOUNT YOU PAID US IN THE TWELVE MONTHS PRIOR TO THE EVENT
          GIVING RISE TO THE CLAIM.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">10. Changes</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          We may update these terms; material changes are notified at
          least 30 days in advance via email and an in-dashboard banner.
          Continued use after the effective date constitutes acceptance.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">11. Contact</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted">
        <p>
          Questions about these terms:{" "}
          <a href={`mailto:${_brand.supportEmail}`}>{_brand.supportEmail}</a>.
        </p>
      </div>
    </article>
  );
}
