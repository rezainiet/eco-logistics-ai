import { env } from "../env.js";

/**
 * Transactional email pipeline.
 *
 * Backed by Resend's HTTP API so we don't need a new SDK dependency. In
 * development, when `RESEND_API_KEY` is unset, emails are written to stdout
 * instead of sent — keeps local signup/reset flows working without external
 * accounts. In production an unset key causes `sendEmail` to no-op with a
 * loud warning rather than crashing the request path; merchants still see
 * the in-app reset link via `WebUrlBuilder`.
 *
 * All templates are rendered server-side with a tiny `renderLayout()` shell
 * so each new email type is a few lines of HTML, not a JSX-renderer setup.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback for accessibility / spam filters. */
  text?: string;
  /** Tag for analytics grouping in Resend dashboards. */
  tag?: string;
}

export interface EmailDeliveryResult {
  ok: boolean;
  id?: string;
  skipped?: boolean;
  error?: string;
}

function fromAddress(): string {
  return env.EMAIL_FROM ?? "Logistics <onboarding@logistics.local>";
}

/**
 * Centralized URL builder so email links stay consistent regardless of where
 * they're triggered (HTTP route, worker, admin tool). Falls back to the
 * NextAuth canonical URL the web app uses.
 */
export function webUrl(path: string): string {
  const base = (
    env.PUBLIC_WEB_URL ??
    process.env.PUBLIC_WEB_URL ??
    process.env.NEXTAUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function sendEmail(msg: EmailMessage): Promise<EmailDeliveryResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev fallback: log instead of send. Tests still go through this path so
    // they can assert the templated copy.
    console.log(
      `[email:dev] to=${msg.to} subject="${msg.subject}" tag=${msg.tag ?? "-"}\n` +
        `${msg.text ?? msg.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)}`,
    );
    return { ok: true, skipped: true };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        tags: msg.tag ? [{ name: "type", value: msg.tag }] : undefined,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] resend ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, error: `resend_${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id };
  } catch (err) {
    console.error("[email] send failed", (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Skinny inline-styled layout — works in Gmail/Outlook without a CSS reset
 * library. Keep brand visuals minimal so deliverability stays high.
 */
function renderLayout(args: { heading: string; body: string; cta?: { label: string; href: string }; footer?: string }) {
  const cta = args.cta
    ? `<p style="margin:32px 0;text-align:center"><a href="${args.cta.href}" style="display:inline-block;padding:12px 22px;background:#0084d4;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">${args.cta.label}</a></p>`
    : "";
  const footer =
    args.footer ??
    "If you didn't expect this email, it's safe to ignore — no action will be taken on your account.";
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;box-shadow:0 1px 2px rgba(15,23,42,.04)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px">
        <span style="display:inline-block;width:28px;height:28px;border-radius:8px;background:#0084d4;color:#fff;font-weight:700;font-size:14px;text-align:center;line-height:28px">L</span>
        <span style="font-weight:600;font-size:15px;color:#0f172a">Logistics</span>
      </div>
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;color:#0f172a">${args.heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#334155">${args.body}</div>
      ${cta}
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;border-top:1px solid #e5e7eb;padding-top:16px">${footer}</p>
    </div>
    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">© ${new Date().getFullYear()} Logistics · Built for Bangladesh e-commerce</p>
  </div>
</body></html>`;
}

/** Verification email sent at signup. */
export function buildVerifyEmail(args: { businessName: string; verifyUrl: string }): { subject: string; html: string; text: string } {
  const subject = "Verify your email to finish setting up Logistics";
  const html = renderLayout({
    heading: `Welcome to Logistics, ${escapeHtml(args.businessName)}!`,
    body: `<p>Thanks for signing up. To keep your workspace secure, please confirm your email address.</p>
    <p style="color:#64748b;font-size:13px">This link will expire in 24 hours.</p>`,
    cta: { label: "Verify email", href: args.verifyUrl },
  });
  const text = `Welcome to Logistics, ${args.businessName}!\n\nVerify your email: ${args.verifyUrl}\n\nThis link expires in 24 hours.`;
  return { subject, html, text };
}

/** Password reset email. */
export function buildPasswordResetEmail(args: { businessName: string; resetUrl: string; ip?: string | null }): { subject: string; html: string; text: string } {
  const subject = "Reset your Logistics password";
  const ipNote = args.ip
    ? `<p style="color:#64748b;font-size:13px">Requested from IP <code>${escapeHtml(args.ip)}</code>.</p>`
    : "";
  const html = renderLayout({
    heading: "Reset your password",
    body: `<p>Hi ${escapeHtml(args.businessName)} — we received a request to reset the password on your Logistics workspace.</p>
    <p>Click below to choose a new one. The link is valid for 60 minutes and can only be used once.</p>
    ${ipNote}`,
    cta: { label: "Set a new password", href: args.resetUrl },
    footer:
      "If you didn't request a password reset, you can ignore this email — your current password will keep working.",
  });
  const text = `Reset your Logistics password: ${args.resetUrl}\n\nThe link expires in 60 minutes. If you didn't request this, you can ignore it.`;
  return { subject, html, text };
}

/** Trial-ending warning sent at T-3 days. */
export function buildTrialEndingEmail(args: { businessName: string; daysLeft: number; pricingUrl: string; billingUrl: string }): { subject: string; html: string; text: string } {
  const subject = `Your Logistics trial ends in ${args.daysLeft} day${args.daysLeft === 1 ? "" : "s"}`;
  const html = renderLayout({
    heading: `Your trial ends in ${args.daysLeft} day${args.daysLeft === 1 ? "" : "s"}`,
    body: `<p>Hi ${escapeHtml(args.businessName)} — your 14-day Logistics trial wraps up soon. Pick a plan to keep orders flowing, fraud reviews running, and your couriers connected.</p>
    <p style="color:#64748b;font-size:13px">No interruption if you upgrade before the trial ends. Manual bKash / Nagad / bank transfers are supported.</p>`,
    cta: { label: "Choose a plan", href: args.pricingUrl },
    footer: `Need help deciding? Reply to this email or open the billing page: ${args.billingUrl}`,
  });
  const text = `Your trial ends in ${args.daysLeft} day(s). Choose a plan: ${args.pricingUrl}`;
  return { subject, html, text };
}

/** Sent after admin approves a manual payment. */
export function buildPaymentApprovedEmail(args: {
  businessName: string;
  planName: string;
  amount: number;
  currency: string;
  periodEnd: Date;
  dashboardUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Payment received — ${args.planName} plan is active`;
  const formattedAmount = `${args.currency === "BDT" ? "৳ " : args.currency + " "}${args.amount.toLocaleString()}`;
  const periodEndStr = args.periodEnd.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const html = renderLayout({
    heading: `You're on ${escapeHtml(args.planName)} 🎉`,
    body: `<p>Hi ${escapeHtml(args.businessName)} — we received your payment of <strong>${formattedAmount}</strong>. Your subscription is now <strong>active</strong>.</p>
    <p>Renews on <strong>${periodEndStr}</strong>. We'll email you a reminder before the next renewal.</p>`,
    cta: { label: "Open dashboard", href: args.dashboardUrl },
    footer: "Receipts and payment history are always available under Billing in your workspace.",
  });
  const text = `Payment of ${formattedAmount} received. ${args.planName} plan is active until ${periodEndStr}. Dashboard: ${args.dashboardUrl}`;
  return { subject, html, text };
}

/** Sent on the FIRST `invoice.payment_failed` of a billing cycle. */
export function buildPaymentFailedEmail(args: {
  businessName: string;
  gracePeriodEndsAt: Date;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = "Action required — your Logistics payment failed";
  const graceStr = args.gracePeriodEndsAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const html = renderLayout({
    heading: "Your latest invoice didn't go through",
    body: `<p>Hi ${escapeHtml(args.businessName)} — your most recent Logistics invoice failed to charge. Please update your card on file to keep service active.</p>
    <p style="color:#64748b;font-size:13px">If we don't receive payment by <strong>${graceStr}</strong>, your account will be temporarily suspended. We'll restore access automatically the moment your card succeeds.</p>`,
    cta: { label: "Update payment method", href: args.billingUrl },
    footer:
      "Stripe will retry the charge automatically. You can also update your card immediately from the Customer Portal.",
  });
  const text = `Your Logistics payment failed. Update your card by ${graceStr}: ${args.billingUrl}`;
  return { subject, html, text };
}

/** Sent when the grace worker flips a merchant from past_due to suspended. */
export function buildSubscriptionSuspendedEmail(args: {
  businessName: string;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = "Your Logistics workspace is suspended";
  const html = renderLayout({
    heading: "Your account is temporarily suspended",
    body: `<p>Hi ${escapeHtml(args.businessName)} — we weren't able to recover payment within the grace window, so your workspace is temporarily suspended.</p>
    <p>Your data is intact. Re-add a working card and your account reactivates instantly.</p>`,
    cta: { label: "Reactivate now", href: args.billingUrl },
    footer:
      "Need a hand? Reply to this email and a billing teammate will help you reactivate.",
  });
  const text = `Your Logistics workspace is suspended. Reactivate: ${args.billingUrl}`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
