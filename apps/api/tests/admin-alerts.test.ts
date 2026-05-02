import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Merchant, Notification } from "@ecom/db";
import {
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";
import {
  deliverAdminAlert,
  deliverTestAlert,
} from "../src/lib/admin-alerts.js";
import { invalidateAdminProfile } from "../src/lib/admin-rbac.js";
import { __setSmsTransport } from "../src/lib/sms/index.js";
import type { Alert } from "../src/lib/anomaly.js";
import type { SmsTransport, SmsSendInput, SmsSendResult } from "../src/lib/sms/index.js";

/**
 * Admin alert delivery integration tests. Real Mongo (so we can assert
 * the in-app Notification row), captured SMS transport (so we can see
 * which severities actually triggered SMS), and dev-mode email (which
 * returns ok:true without hitting Resend). Each spec resets the DB and
 * the SMS transport.
 */

interface CapturedSms extends SmsSendInput {}
class FakeSmsTransport implements SmsTransport {
  public sent: CapturedSms[] = [];
  async send(input: SmsSendInput): Promise<SmsSendResult> {
    this.sent.push(input);
    return {
      ok: true,
      providerMessageId: `fake-${this.sent.length}`,
      providerStatus: "fake",
    };
  }
}

let smsTransport: FakeSmsTransport;

beforeEach(async () => {
  await resetDb();
  smsTransport = new FakeSmsTransport();
  __setSmsTransport(smsTransport);
});

afterAll(disconnectDb);

async function createAdmin(opts?: {
  email?: string;
  phone?: string | null;
  prefs?: {
    info?: { email?: boolean; sms?: boolean };
    warning?: { email?: boolean; sms?: boolean };
    critical?: { email?: boolean; sms?: boolean };
  };
}) {
  const m = await createMerchant({
    role: "admin",
    email:
      opts?.email ??
      `admin-${Date.now()}-${Math.random()}@test.com`,
  });
  if (opts?.phone !== undefined) {
    await Merchant.updateOne({ _id: m._id }, { $set: { phone: opts.phone ?? null } });
  }
  if (opts?.prefs) {
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { adminAlertPrefs: opts.prefs } },
    );
  }
  invalidateAdminProfile(String(m._id));
  return m;
}

function buildAlert(severity: Alert["severity"]): Alert & { dedupeKey: string } {
  const hour = Math.floor(Date.now() / 3_600_000);
  return {
    kind: "fraud_spike",
    severity,
    shortCount: 25,
    baselineRate: 4,
    shortRate: 25,
    message: "High-risk orders spiking",
    dedupeKey: `fraud_spike:${hour}:${Math.random()}`,
  };
}

describe("admin alert delivery — defaults", () => {
  it("info alert: in-app only (no email, no sms)", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    const result = await deliverAdminAlert(buildAlert("info"));
    expect(result.admins).toBe(1);
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(0);
    expect(result.sms).toBe(0);
    const rows = await Notification.find({ merchantId: admin._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("admin.alert");
    expect(rows[0]!.severity).toBe("info");
    expect(smsTransport.sent).toHaveLength(0);
  });

  it("warning alert: in-app + email (no sms)", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    const result = await deliverAdminAlert(buildAlert("warning"));
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(1);
    expect(result.sms).toBe(0);
    expect(smsTransport.sent).toHaveLength(0);
    const row = await Notification.findOne({ merchantId: admin._id }).lean();
    expect(row?.severity).toBe("warning");
  });

  it("critical alert: in-app + email + SMS", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    const result = await deliverAdminAlert(buildAlert("critical"));
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(1);
    expect(result.sms).toBe(1);
    expect(smsTransport.sent).toHaveLength(1);
    expect(smsTransport.sent[0]!.body).toMatch(/CRITICAL fraud_spike/);
    void admin;
  });

  it("admin without a phone is skipped on SMS even on critical", async () => {
    await createAdmin({ phone: null });
    const result = await deliverAdminAlert(buildAlert("critical"));
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(1);
    expect(result.sms).toBe(0); // no phone — sms path silently skipped
  });
});

describe("admin alert delivery — explicit preferences", () => {
  it("admin who muted email still gets in-app", async () => {
    await createAdmin({
      phone: "+8801711111111",
      prefs: {
        info: { email: false, sms: false },
        warning: { email: false, sms: false }, // muted
        critical: { email: false, sms: false }, // muted entirely
      },
    });
    const result = await deliverAdminAlert(buildAlert("critical"));
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(0);
    expect(result.sms).toBe(0);
  });

  it("admin who enabled SMS for warning gets paged on warning", async () => {
    await createAdmin({
      phone: "+8801711111111",
      prefs: {
        info: { email: false, sms: false },
        warning: { email: true, sms: true }, // explicit opt-in
        critical: { email: true, sms: true },
      },
    });
    const result = await deliverAdminAlert(buildAlert("warning"));
    expect(result.sms).toBe(1);
    expect(smsTransport.sent[0]!.body).toMatch(/WARNING/);
  });

  it("admin who enabled email for info gets emailed on info", async () => {
    await createAdmin({
      phone: "+8801711111111",
      prefs: {
        info: { email: true, sms: false }, // explicit opt-in
        warning: { email: true, sms: false },
        critical: { email: true, sms: true },
      },
    });
    const result = await deliverAdminAlert(buildAlert("info"));
    expect(result.emails).toBe(1);
    expect(result.sms).toBe(0);
  });
});

describe("admin alert delivery — fan-out + dedup", () => {
  it("delivers to every admin merchant", async () => {
    await createAdmin({ phone: "+8801711111111" });
    await createAdmin({ phone: "+8801722222222" });
    await createAdmin({ phone: null });
    // a non-admin merchant should NOT receive the alert
    await createMerchant();
    const result = await deliverAdminAlert(buildAlert("critical"));
    expect(result.admins).toBe(3);
    expect(result.inApp).toBe(3);
    expect(result.emails).toBe(3);
    // 2 admins have phones — 2 SMS
    expect(result.sms).toBe(2);
    const rows = await Notification.find({ kind: "admin.alert" }).lean();
    expect(rows).toHaveLength(3);
  });

  it("re-delivering the same alert dedups in-app rows per admin", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    const alert = buildAlert("warning");
    const r1 = await deliverAdminAlert(alert);
    const r2 = await deliverAdminAlert(alert);
    expect(r1.inApp).toBe(1);
    // Second delivery — Notification upsert finds the existing row and
    // does NOT bump inApp (upsertedCount === 0).
    expect(r2.inApp).toBe(0);
    const rows = await Notification.find({ merchantId: admin._id }).lean();
    expect(rows).toHaveLength(1);
  });

  it("two admins each get their own in-app row keyed independently", async () => {
    const a1 = await createAdmin();
    const a2 = await createAdmin();
    const alert = buildAlert("warning");
    await deliverAdminAlert(alert);
    const r1 = await Notification.find({ merchantId: a1._id }).lean();
    const r2 = await Notification.find({ merchantId: a2._id }).lean();
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]!.dedupeKey).not.toBe(r2[0]!.dedupeKey);
  });

  it("returns admins:0 when no role=admin merchants exist", async () => {
    await createMerchant(); // role=merchant by default
    const result = await deliverAdminAlert(buildAlert("critical"));
    expect(result.admins).toBe(0);
    expect(result.inApp).toBe(0);
  });
});

describe("deliverTestAlert helper", () => {
  it("dispatches a synthetic alert through the same pipeline", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    const result = await deliverTestAlert({
      severity: "critical",
      recipients: [
        {
          id: String(admin._id),
          email: admin.email,
          phone: "+8801711111111",
          businessName: admin.businessName,
          prefs: {
            info: { email: false, sms: false },
            warning: { email: true, sms: false },
            critical: { email: true, sms: true },
          },
        },
      ],
    });
    expect(result.inApp).toBe(1);
    expect(result.emails).toBe(1);
    expect(result.sms).toBe(1);
    const row = await Notification.findOne({
      merchantId: admin._id,
      kind: "admin.alert",
    }).lean();
    expect(row?.body).toMatch(/Test critical alert/);
  });
});

describe("anomaly worker → alert delivery hook", () => {
  it("runAnomalyDetection writes audit row AND dispatches to admins", async () => {
    const admin = await createAdmin({ phone: "+8801711111111" });
    // Seed 12 manual payments in the last hour to trip the spike detector.
    const Payment = (await import("@ecom/db")).Payment;
    for (let i = 0; i < 12; i++) {
      await Payment.create({
        merchantId: admin._id,
        plan: "growth",
        amount: 999,
        method: "bkash",
        status: "pending",
        provider: "manual",
      } as never);
    }
    const { runAnomalyDetection } = await import("../src/lib/anomaly.js");
    const fired = await runAnomalyDetection();
    expect(fired.map((f) => f.kind)).toContain("payment_spike");
    // The audit row went down synchronously; the admin notification is
    // fire-and-forget — give it a tick to land.
    await new Promise((r) => setTimeout(r, 100));
    const rows = await Notification.find({
      merchantId: admin._id,
      kind: "admin.alert",
    }).lean();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.meta).toMatchObject({ kind: "payment_spike" });
  });
});
