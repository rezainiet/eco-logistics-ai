import { Types } from "mongoose";
import {
  DEFAULT_ADMIN_ALERT_PREFS,
  Merchant,
  Notification,
  type AdminAlertPrefs,
  type AdminAlertSeverity,
} from "@ecom/db";
import { buildAdminAlertEmail, sendEmail, webUrl } from "./email.js";
import { sendCriticalAlertSms } from "./sms/index.js";
import { loadBrandingFromStore } from "./branding-store.js";
import type { Alert } from "./anomaly.js";

/**
 * Admin alert delivery system.
 *
 * The anomaly worker writes one `alert.fired` audit row per detector that
 * trips. That audit IS the source of truth — it carries the full payload,
 * dedupeKey, and severity. This module is a *side-effect*: it fans the
 * alert out to every role=admin merchant via:
 *
 *   - An always-on in-app Notification row (kind: "admin.alert"),
 *     dedupe-keyed off the alert's hour-bucket so a sustained anomaly
 *     produces ONE inbox row per admin per hour, not one per detector tick.
 *   - Optional email, gated by the admin's `adminAlertPrefs[severity].email`.
 *   - Optional SMS, gated by `adminAlertPrefs[severity].sms` AND a
 *     phone number on the merchant doc.
 *
 * Every channel is best-effort and isolated — an SMS failure does not
 * suppress the email, an email failure does not suppress the in-app row.
 * The function NEVER throws into the caller; the anomaly worker uses
 * `void deliverAdminAlert(...)` to fire and forget.
 *
 * Defaults (for an admin with no explicit prefs):
 *   info     — in-app only
 *   warning  — in-app + email
 *   critical — in-app + email + SMS
 */

export interface AdminAlertDeliveryResult {
  /** Number of admins the alert was fanned out to. */
  admins: number;
  /** Per-channel counts. inApp may be < admins when the dedupe key collapses to an existing row. */
  inApp: number;
  emails: number;
  sms: number;
  /** Channels that errored — useful for tests + telemetry. */
  errors: { channel: "in_app" | "email" | "sms"; admin: string; error: string }[];
}

interface AdminContact {
  id: string;
  email: string;
  phone: string | null;
  businessName: string;
  prefs: AdminAlertPrefs;
}

function resolvePrefs(
  raw: unknown,
): AdminAlertPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_ADMIN_ALERT_PREFS;
  const r = raw as Partial<AdminAlertPrefs>;
  return {
    info: {
      email: r.info?.email ?? DEFAULT_ADMIN_ALERT_PREFS.info.email,
      sms: r.info?.sms ?? DEFAULT_ADMIN_ALERT_PREFS.info.sms,
    },
    warning: {
      email: r.warning?.email ?? DEFAULT_ADMIN_ALERT_PREFS.warning.email,
      sms: r.warning?.sms ?? DEFAULT_ADMIN_ALERT_PREFS.warning.sms,
    },
    critical: {
      email: r.critical?.email ?? DEFAULT_ADMIN_ALERT_PREFS.critical.email,
      sms: r.critical?.sms ?? DEFAULT_ADMIN_ALERT_PREFS.critical.sms,
    },
  };
}

async function listAdminRecipients(): Promise<AdminContact[]> {
  const docs = await Merchant.find({ role: "admin" })
    .select("email phone businessName adminAlertPrefs")
    .lean();
  return docs.map((d) => ({
    id: String(d._id),
    email: d.email,
    phone: d.phone ?? null,
    businessName: d.businessName,
    prefs: resolvePrefs((d as { adminAlertPrefs?: unknown }).adminAlertPrefs),
  }));
}

/**
 * Per-(admin, alert) dedupe key. The alert's hour-bucket key keeps the
 * audit log de-duplicated; we extend that with the admin id so two admins
 * each get their own inbox row but a single admin doesn't get the same
 * alert twice if the worker accidentally fires it again.
 */
function dedupeKeyFor(adminId: string, alertDedupeKey: string): string {
  return `admin_alert:${alertDedupeKey}:${adminId}`;
}

interface DispatchOpts {
  /** Override the admin recipient list — used by tests. */
  recipients?: AdminContact[];
  /** Skip SMS even if prefs allow — used when relaying historical alerts. */
  skipSms?: boolean;
  /** Skip email — used when relaying historical alerts. */
  skipEmail?: boolean;
}

export async function deliverAdminAlert(
  alert: Alert & { dedupeKey: string },
  opts: DispatchOpts = {},
): Promise<AdminAlertDeliveryResult> {
  const result: AdminAlertDeliveryResult = {
    admins: 0,
    inApp: 0,
    emails: 0,
    sms: 0,
    errors: [],
  };
  let recipients: AdminContact[];
  try {
    recipients = opts.recipients ?? (await listAdminRecipients());
  } catch (err) {
    console.error(
      "[admin-alerts] failed to list admins",
      (err as Error).message,
    );
    return result;
  }
  result.admins = recipients.length;
  if (recipients.length === 0) return result;

  const severity: AdminAlertSeverity = alert.severity;
  const alertsUrl = webUrl("/admin/alerts");

  await Promise.all(
    recipients.map(async (admin) => {
      // 1. In-app row — always, regardless of prefs. The inbox is the
      // safety net so an admin who muted email + SMS still sees alerts.
      try {
        const r = await Notification.updateOne(
          {
            merchantId: new Types.ObjectId(admin.id),
            dedupeKey: dedupeKeyFor(admin.id, alert.dedupeKey),
          },
          {
            $setOnInsert: {
              merchantId: new Types.ObjectId(admin.id),
              kind: "admin.alert",
              severity,
              title: `${severity.toUpperCase()} · ${alert.kind}`,
              body: alert.message,
              link: "/admin/alerts",
              subjectType: "system",
              meta: {
                kind: alert.kind,
                shortCount: alert.shortCount,
                baselineRate: alert.baselineRate,
                shortRate: alert.shortRate,
                alertDedupeKey: alert.dedupeKey,
              },
              dedupeKey: dedupeKeyFor(admin.id, alert.dedupeKey),
            },
          },
          { upsert: true },
        );
        if ((r.upsertedCount ?? 0) > 0) result.inApp++;
      } catch (err) {
        result.errors.push({
          channel: "in_app",
          admin: admin.id,
          error: (err as Error).message,
        });
      }

      // 2. Email — gated by per-severity preference.
      if (!opts.skipEmail && admin.prefs[severity].email && admin.email) {
        try {
          const tpl = buildAdminAlertEmail({
            severity,
            kind: alert.kind,
            message: alert.message,
            shortCount: alert.shortCount,
            baselineRate: alert.baselineRate,
            alertsUrl,
          });
          const r = await sendEmail({
            to: admin.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            tag: `admin_alert_${alert.kind}`,
          });
          if (r.ok) result.emails++;
          else if (r.error) {
            result.errors.push({
              channel: "email",
              admin: admin.id,
              error: r.error,
            });
          }
        } catch (err) {
          result.errors.push({
            channel: "email",
            admin: admin.id,
            error: (err as Error).message,
          });
        }
      }

      // 3. SMS — gated by per-severity preference AND phone presence. We
      // intentionally only blast SMS for severities the admin has opted
      // into; the default has SMS enabled only for `critical`.
      if (
        !opts.skipSms &&
        admin.prefs[severity].sms &&
        admin.phone
      ) {
        try {
          // SMS sender brand reads from centralized branding so a rebrand
          // (or future white-label) propagates to every alert channel
          // without code changes. Default = "Cordon Ops" today.
          const branding = await loadBrandingFromStore();
          const r = await sendCriticalAlertSms(
            admin.phone,
            `${severity.toUpperCase()} ${alert.kind}: ${alert.message.slice(0, 120)}`,
            { brand: branding.operational.smsBrand, tag: `admin_alert_${alert.kind}` },
          );
          if (r.ok) result.sms++;
          else if (r.error) {
            result.errors.push({
              channel: "sms",
              admin: admin.id,
              error: r.error,
            });
          }
        } catch (err) {
          result.errors.push({
            channel: "sms",
            admin: admin.id,
            error: (err as Error).message,
          });
        }
      }
    }),
  );

  return result;
}

/**
 * Public test/admin helper — fire a synthetic alert without going through
 * the anomaly detector. Used by the "Send test alert" button on the alert
 * preferences UI so an admin can verify their channels actually work.
 */
export async function deliverTestAlert(opts: {
  severity: AdminAlertSeverity;
  recipients?: AdminContact[];
}): Promise<AdminAlertDeliveryResult> {
  const hour = Math.floor(Date.now() / 3_600_000);
  return deliverAdminAlert(
    {
      kind: "fraud_spike",
      severity: opts.severity,
      shortCount: 0,
      baselineRate: 0,
      shortRate: 0,
      message: `Test ${opts.severity} alert dispatched from /admin/alerts.`,
      dedupeKey: `test:${opts.severity}:${hour}:${Date.now()}`,
    },
    { recipients: opts.recipients },
  );
}

export const __TEST = { resolvePrefs, dedupeKeyFor };
