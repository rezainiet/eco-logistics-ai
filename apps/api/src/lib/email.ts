import {
  getBrandingSync,
  type BrandingConfig,
} from "@ecom/branding";
import { env } from "../env.js";

/**
 * Transactional email pipeline.
 *
 * Backed by Resend's HTTP API so we don't need a new SDK dependency. In
 * development, when `RESEND_API_KEY` is unset, emails are written to
 * stdout instead of sent — keeps local signup/reset flows working
 * without external accounts. In production an unset key causes
 * `sendEmail` to no-op with a loud warning rather than crashing the
 * request path; merchants still see the in-app reset link via
 * `WebUrlBuilder`.
 *
 * Branding: every template reads from the centralized `@ecom/branding`
 * resolver. Subject lines, sender, footer, accent, support line, and
 * copy that names the SaaS all flow from one source of truth. Each
 * `buildXxxEmail` accepts an optional `branding` override so callers
 * can pass a freshly-fetched DB-backed branding (via
 * `loadBrandingFromStore()`); when omitted, `getBrandingSync()`
 * provides defaults + ENV overrides so unit tests never need a DB.
 *
 * EMAIL_FROM env still takes precedence over the branded sender. That
 * lets staging deploys flag themselves as "Cordon · STAGING" without
 * touching the DB.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  tag?: string;
}

export interface EmailDeliveryResult {
  ok: boolean;
  id?: string;
  skipped?: boolean;
  error?: string;
}

function resolveBranding(b?: BrandingConfig): BrandingConfig {
  return b ?? getBrandingSync();
}

function fromAddress(branding?: BrandingConfig): string {
  if (env.EMAIL_FROM) return env.EMAIL_FROM;
  const b = resolveBranding(branding);
  return `${b.email.senderName} <${b.email.senderAddress}>`;
}

export function webUrl(path: string): string {
  const base = (
    env.PUBLIC_WEB_URL ??
    process.env.PUBLIC_WEB_URL ??
    process.env.NEXTAUTH_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function sendEmail(
  msg: EmailMessage,
  opts: { branding?: BrandingConfig } = {},
): Promise<EmailDeliveryResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
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
        from: fromAddress(opts.branding),
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
 * Skinny inline-styled layout — works in Gmail/Outlook without a CSS
 * reset library. Brand visuals come from the branding doc so a rebrand
 * (or future white-label) flows to every transactional touch.
 */
function renderLayout(args: {
  branding?: BrandingConfig;
  heading: string;
  body: string;
  cta?: { label: string; href: string };
  footer?: string;
}) {
  const b = resolveBranding(args.branding);
  const accent = b.email.accentColor ?? b.colors.brand;
  const accentFg = b.colors.brandFg;
  const cta = args.cta
    ? `<p style="margin:32px 0;text-align:center"><a href="${args.cta.href}" style="display:inline-block;padding:12px 22px;background:${accent};color:${accentFg};text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">${args.cta.label}</a></p>`
    : "";
  const footer =
    args.footer ??
    "If you didn't expect this email, it's safe to ignore — no action will be taken on your account.";
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;box-shadow:0 1px 2px rgba(15,23,42,.04)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${accent};box-shadow:0 0 12px ${accent}"></span>
        <span style="font-weight:600;font-size:15px;color:#0f172a;letter-spacing:-0.01em">${escapeHtml(b.name)}</span>
      </div>
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;color:#0f172a">${args.heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#334155">${args.body}</div>
      ${cta}
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;border-top:1px solid #e5e7eb;padding-top:16px">${footer}</p>
    </div>
    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">© ${new Date().getFullYear()} ${escapeHtml(b.name)} · ${escapeHtml(b.email.footer)}</p>
  </div>
</body></html>`;
}

/**
 * Verification email sent at signup. Subject line preserves the literal
 * "verify your email" so the existing test (regex `/verify your email/i`)
 * stays load-bearing across rebrands.
 */
export function buildVerifyEmail(args: {
  businessName: string;
  verifyUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const subject = `Welcome to ${b.name} — verify your email`;
  const html = renderLayout({
    branding: b,
    heading: `Welcome to ${escapeHtml(b.name)}, ${escapeHtml(args.businessName)}.`,
    body: `<p>Your 14-day trial is active. Verify your email so we can keep your workspace secure, then connect Shopify or WooCommerce — ${escapeHtml(b.name)} will start scoring your incoming orders the moment your first webhook lands.</p>
    <p style="color:#94a3b8;font-size:13px">This verification link expires in 24 hours.</p>`,
    cta: { label: "Verify email and start", href: args.verifyUrl },
    footer: b.email.supportLine,
  });
  const text = `Welcome to ${b.name}, ${args.businessName}.\n\nYour 14-day trial is active. Verify your email and start: ${args.verifyUrl}\n\nThis link expires in 24 hours.`;
  return { subject, html, text };
}

export function buildPasswordResetEmail(args: {
  businessName: string;
  resetUrl: string;
  ip?: string | null;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const subject = `Reset your ${b.name} password`;
  const ipNote = args.ip
    ? `<p style="color:#64748b;font-size:13px">Requested from IP <code>${escapeHtml(args.ip)}</code>.</p>`
    : "";
  const html = renderLayout({
    branding: b,
    heading: "Reset your password",
    body: `<p>Hi ${escapeHtml(args.businessName)} — we received a request to reset the password on your ${escapeHtml(b.name)} workspace.</p>
    <p>Click below to choose a new one. The link is valid for 60 minutes and can only be used once.</p>
    ${ipNote}`,
    cta: { label: "Set a new password", href: args.resetUrl },
    footer:
      "If you didn't request a password reset, you can ignore this email — your current password will keep working.",
  });
  const text = `Reset your ${b.name} password: ${args.resetUrl}\n\nThe link expires in 60 minutes. If you didn't request this, you can ignore it.`;
  return { subject, html, text };
}

export function buildTrialEndingEmail(args: {
  businessName: string;
  daysLeft: number;
  pricingUrl: string;
  billingUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const dayWord = args.daysLeft === 1 ? "day" : "days";
  const subject = `Your ${b.name} trial ends in ${args.daysLeft} ${dayWord}`;
  const html = renderLayout({
    branding: b,
    heading: `Your trial ends in ${args.daysLeft} ${dayWord}`,
    body: `<p>Hi ${escapeHtml(args.businessName)} — your 14-day ${escapeHtml(b.name)} trial wraps up soon. Pick a plan to keep orders flowing, fraud reviews running, and your couriers connected.</p>
    <p style="color:#64748b;font-size:13px">No interruption if you upgrade before the trial ends. Manual bKash / Nagad / bank transfers are supported.</p>`,
    cta: { label: "Choose a plan", href: args.pricingUrl },
    footer: `Need help deciding? Reply to this email or open the billing page: ${args.billingUrl}`,
  });
  const text = `Your ${b.name} trial ends in ${args.daysLeft} day(s). Choose a plan: ${args.pricingUrl}`;
  return { subject, html, text };
}

export function buildPaymentApprovedEmail(args: {
  businessName: string;
  planName: string;
  amount: number;
  currency: string;
  periodEnd: Date;
  dashboardUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const subject = `Payment received — ${args.planName} plan is active`;
  const formattedAmount = `${args.currency === "BDT" ? "৳ " : args.currency + " "}${args.amount.toLocaleString()}`;
  const periodEndStr = args.periodEnd.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const html = renderLayout({
    branding: b,
    heading: `You're on ${escapeHtml(args.planName)} 🎉`,
    body: `<p>Hi ${escapeHtml(args.businessName)} — we received your payment of <strong>${formattedAmount}</strong>. Your subscription is now <strong>active</strong>.</p>
    <p>Renews on <strong>${periodEndStr}</strong>. We'll email you a reminder before the next renewal.</p>`,
    cta: { label: "Open dashboard", href: args.dashboardUrl },
    footer: "Receipts and payment history are always available under Billing in your workspace.",
  });
  const text = `Payment of ${formattedAmount} received. ${args.planName} plan is active until ${periodEndStr}. Dashboard: ${args.dashboardUrl}`;
  return { subject, html, text };
}

export function buildPaymentFailedEmail(args: {
  businessName: string;
  gracePeriodEndsAt: Date;
  billingUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const subject = `Action required — your ${b.name} payment failed`;
  const graceStr = args.gracePeriodEndsAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const html = renderLayout({
    branding: b,
    heading: "Your latest invoice didn't go through",
    body: `<p>Hi ${escapeHtml(args.businessName)} — your most recent ${escapeHtml(b.name)} invoice failed to charge. Please update your card on file to keep service active.</p>
    <p style="color:#64748b;font-size:13px">If we don't receive payment by <strong>${graceStr}</strong>, your account will be temporarily suspended. We'll restore access automatically the moment your card succeeds.</p>`,
    cta: { label: "Update payment method", href: args.billingUrl },
    footer:
      "Stripe will retry the charge automatically. You can also update your card immediately from the Customer Portal.",
  });
  const text = `Your ${b.name} payment failed. Update your card by ${graceStr}: ${args.billingUrl}`;
  return { subject, html, text };
}

export function buildSubscriptionSuspendedEmail(args: {
  businessName: string;
  billingUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const subject = `Your ${b.name} workspace is suspended`;
  const html = renderLayout({
    branding: b,
    heading: "Your account is temporarily suspended",
    body: `<p>Hi ${escapeHtml(args.businessName)} — we weren't able to recover payment within the grace window, so your workspace is temporarily suspended.</p>
    <p>Your data is intact. Re-add a working card and your account reactivates instantly.</p>`,
    cta: { label: "Reactivate now", href: args.billingUrl },
    footer:
      "Need a hand? Reply to this email and a billing teammate will help you reactivate.",
  });
  const text = `Your ${b.name} workspace is suspended. Reactivate: ${args.billingUrl}`;
  return { subject, html, text };
}

export function buildAdminAlertEmail(args: {
  severity: "info" | "warning" | "critical";
  kind: string;
  message: string;
  shortCount?: number;
  baselineRate?: number;
  alertsUrl: string;
  branding?: BrandingConfig;
}): { subject: string; html: string; text: string } {
  const b = resolveBranding(args.branding);
  const sevLabel = args.severity.toUpperCase();
  const subject = `[${sevLabel}] ${args.kind} — ${args.message.slice(0, 100)}`;
  const detailRows: string[] = [];
  if (args.shortCount !== undefined) {
    detailRows.push(`<li><strong>Last hour:</strong> ${args.shortCount}</li>`);
  }
  if (args.baselineRate !== undefined) {
    detailRows.push(`<li><strong>24h baseline:</strong> ${args.baselineRate.toFixed(1)}/h</li>`);
  }
  const tone =
    args.severity === "critical"
      ? "color:#b91c1c"
      : args.severity === "warning"
        ? "color:#a16207"
        : "color:#1d4ed8";
  const html = renderLayout({
    branding: b,
    heading: `<span style="${tone}">${sevLabel}</span> · ${escapeHtml(args.kind)}`,
    body: `<p>${escapeHtml(args.message)}</p>
    ${detailRows.length > 0 ? `<ul style="font-size:13px;color:#475569">${detailRows.join("")}</ul>` : ""}
    <p style="color:#64748b;font-size:13px">This alert was generated by the anomaly detector and de-duplicates per hour bucket.</p>`,
    cta: { label: "Open alerts dashboard", href: args.alertsUrl },
    footer:
      "You're receiving this because alert delivery is enabled for your admin account. Update preferences in /admin/alerts.",
  });
  const text = `[${sevLabel}] ${args.kind}\n${args.message}\n\nAlerts: ${args.alertsUrl}`;
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
