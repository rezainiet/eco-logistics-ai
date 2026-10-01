import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { Types } from "mongoose";
import {
  AuditLog,
  EmailEvent,
  EmailSuppression,
  InventoryMovement,
  Merchant,
  Order,
  Product,
  RecoveryTask,
  TrackingEvent,
  TrackingSession,
} from "@ecom/db";
import { ensureSystemTemplates, __resetTemplateCacheForTests } from "../src/lib/landing/templates.js";
import { placeLandingOrder, type PlaceOrderInput } from "../src/lib/commerce/landing-orders.js";
import {
  linkRecoveredOrder,
  recordLandingActivity,
  restoreRecoveryCart,
} from "../src/lib/recovery/landing.js";
import { deriveRecoveryToken, hashRecoveryToken } from "../src/lib/recovery/token.js";
import { RECOVERY_EMAIL_DELAY_MS, sendDueRecoveryEmails } from "../src/lib/recovery/email.js";
import { recordServerTrackingEvents } from "../src/server/tracking/collector.js";
import { sweepCartRecovery } from "../src/workers/cartRecovery.js";
import { landingActivityRouter, landingRecoverRouter } from "../src/server/landing-recovery.js";
import { __TEST as resendWebhook } from "../src/server/webhooks/resend.js";
import type { EmailDeliveryResult, EmailMessage } from "../src/lib/email.js";
import { authUserFor, callerFor, createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Cart recovery, end to end on the API: a landing-page cart is abandoned,
 * the sweep creates one task and (for entitled merchants, after a delay)
 * sends exactly one email through an injected transport — no real email —
 * whose link restores the cart; the buyer's normal checkout then links the
 * order back to the task and the revenue shows up once delivered.
 */

beforeAll(async () => {
  await ensureDb();
  await Promise.all([Product.syncIndexes(), InventoryMovement.syncIndexes(), Order.syncIndexes(), RecoveryTask.syncIndexes(), TrackingEvent.syncIndexes()]);
});
afterAll(disconnectDb);
beforeEach(async () => {
  await resetDb();
  __resetTemplateCacheForTests();
});

const MIN = 60_000;
/** Late enough for the sweep to create the task (30 min idle) AND send (60 min). */
const later = () => Date.now() + RECOVERY_EMAIL_DELAY_MS + 5 * MIN;
/** Late enough to create the task, too early to email. */
const soon = () => Date.now() + 31 * MIN;

const customer = { name: "Rahim Uddin", phone: "01712345678", address: "House 12, Road 5, Dhanmondi", district: "Dhaka" };
const BUYER_EMAIL = "buyer@example.test";
let keySeq = 0;
const key = () => `rec-key-${Date.now()}-${++keySeq}-abcdef`;

async function shop(slug: string, tier: "growth" | "scale" | "enterprise" = "growth", businessName = "Rahim Fashion") {
  await ensureSystemTemplates();
  const merchant = await createMerchant({ email: `${slug}@shop.test`, tier, businessName });
  const caller = callerFor(authUserFor(merchant));
  const shirt = await caller.products.create({ name: "Premium Cotton Shirt", price: 1290, initialStock: 20 });
  const knife = await caller.products.create({ name: "Kitchen Knife Set", price: 890, initialStock: 8 });
  const tpl = (await caller.landingPages.templates()).find((t) => t.key === "bd-modern-shop")!;
  const page = await caller.landingPages.create({ templateId: tpl.id, name: "Shop" });
  const got = await caller.landingPages.get({ id: page.id });
  const bn = (got.draftContent as Record<string, Record<string, Record<string, unknown>>>).bn!;
  bn.order!.cta = { label: "Order", action: { kind: "whatsapp", phone: "+8801711000000", message: "" } };
  const saved = await caller.landingPages.saveDraft({ id: page.id, content: { bn }, expectedRevision: 1 });
  const linked = await caller.landingPages.setProducts({
    id: page.id,
    expectedRevision: saved.page.draftRevision,
    products: [{ productId: shirt.id }, { productId: knife.id }],
  });
  await caller.landingPages.setSlug({ id: page.id, slug });
  await caller.landingPages.publish({ id: page.id, expectedRevision: linked.page.draftRevision });
  return { merchant, merchantId: merchant._id as Types.ObjectId, caller, page, shirt, knife, host: `${slug}.localhost` };
}

type Shop = Awaited<ReturnType<typeof shop>>;

async function act(s: Shop, sessionId: string, type: string, cart: unknown[], extra: Record<string, unknown> = {}, clientEventId = randomUUID()) {
  return recordLandingActivity({ host: s.host, locale: null, sessionId, type, clientEventId, cart, ...extra });
}

/** The buyer adds two shirts and a knife, starts checkout, types contact details, leaves. */
async function abandon(s: Shop, contact: { email?: string; phone?: string } = { email: BUYER_EMAIL, phone: customer.phone }) {
  const sid = randomUUID();
  const shirt1 = [{ productId: s.shirt.id, quantity: 1 }];
  const shirt2 = [{ productId: s.shirt.id, quantity: 2 }];
  const full = [...shirt2, { productId: s.knife.id, quantity: 1 }];
  await act(s, sid, "add_to_cart", shirt1, { item: { productId: s.shirt.id, quantity: 1 } });
  await act(s, sid, "add_to_cart", shirt2, { item: { productId: s.shirt.id, quantity: 1 } });
  await act(s, sid, "add_to_cart", full, { item: { productId: s.knife.id, quantity: 1 } });
  await act(s, sid, "checkout_start", full);
  await act(s, sid, "identify", full, contact);
  return { sid, cart: full };
}

function mailbox(result: (n: number) => EmailDeliveryResult = (n) => ({ ok: true, id: `re_test_${n}` })) {
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => {
    sent.push(m);
    return result(sent.length);
  };
  return { sent, send };
}

const tokenIn = (m: EmailMessage) => /cx_recover=([A-Za-z0-9_-]{43})/.exec(m.text ?? "")?.[1] ?? "";

function order(host: string, items: PlaceOrderInput["items"], extra: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return { host, locale: null, idempotencyKey: key(), items, customer: { ...customer, email: BUYER_EMAIL }, deliveryOptionId: null, ...extra };
}

async function placeWithDelivery(s: Shop, items: PlaceOrderInput["items"], extra: Partial<PlaceOrderInput> = {}) {
  const resolved = await (await import("../src/lib/landing/resolve.js")).resolvePublishedForOrder(s.host, null);
  const zone = resolved!.delivery[0];
  return placeLandingOrder(order(s.host, items, { deliveryOptionId: zone?.id ?? null, ...extra }), { ip: "203.0.113.7", userAgent: "vitest" });
}

describe("abandonment → recovery task", () => {
  it("a landing-page cart with a contact becomes ONE task, with the exact saved cart", async () => {
    const s = await shop("rec-one");
    const { sid } = await abandon(s);
    const session = await TrackingSession.findOne({ merchantId: s.merchantId, sessionId: sid }).lean();
    expect(session).toMatchObject({ addToCartCount: 3, abandonedCart: true, email: BUYER_EMAIL, phone: "+8801712345678" });

    const { send, sent } = mailbox();
    const r1 = await sweepCartRecovery({ now: soon(), sendEmail: send });
    const r2 = await sweepCartRecovery({ now: soon(), sendEmail: send });
    expect(r1.created).toBe(1);
    expect(r2.created).toBe(0);
    const tasks = await RecoveryTask.find({ merchantId: s.merchantId }).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "pending",
      source: "landing_page",
      landingHost: s.host,
      cartValue: 2 * 1290 + 890,
      emailRecovery: { state: "queued", attempts: 0 },
    });
    expect(String(tasks[0]!.landingPageId)).toBe(s.page.id);
    // Not emailed the moment the task exists: the send waits for its delay.
    expect(sent).toHaveLength(0);
  });

  it("retried and duplicate activity events never inflate the session or create a second task", async () => {
    const s = await shop("rec-dup");
    const sid = randomUUID();
    const eid = randomUUID();
    const cart = [{ productId: s.shirt.id, quantity: 1 }];
    await act(s, sid, "add_to_cart", cart, { item: cart[0] }, eid);
    await act(s, sid, "add_to_cart", cart, { item: cart[0] }, eid); // same event retried
    expect((await TrackingSession.findOne({ sessionId: sid }).lean())?.addToCartCount).toBe(1);
    expect((await TrackingSession.findOne({ sessionId: sid }).lean())?.abandonedCart).toBe(false);
    await act(s, sid, "add_to_cart", [{ productId: s.shirt.id, quantity: 2 }], { item: cart[0] });
    await act(s, sid, "identify", cart, { email: BUYER_EMAIL });
    const { send } = mailbox();
    await Promise.all([sweepCartRecovery({ now: soon(), sendEmail: send }), sweepCartRecovery({ now: soon(), sendEmail: send })]);
    expect(await RecoveryTask.countDocuments({ merchantId: s.merchantId })).toBe(1);
  });

  it("an order placed in the same session clears the abandonment — no task", async () => {
    const s = await shop("rec-buy");
    const { sid, cart } = await abandon(s);
    await act(s, sid, "checkout_submit", cart);
    const { send } = mailbox();
    expect((await sweepCartRecovery({ now: later(), sendEmail: send })).created).toBe(0);
  });

  it("product ids that are not on the page (or another merchant's) are dropped from the saved cart", async () => {
    const a = await shop("rec-own-a");
    const b = await shop("rec-own-b");
    const sid = randomUUID();
    await act(a, sid, "checkout_start", [{ productId: b.shirt.id, quantity: 1 }, { productId: a.knife.id, quantity: 1 }]);
    const ev = await TrackingEvent.findOne({ merchantId: a.merchantId, sessionId: sid }).lean();
    expect((ev!.properties as { cart: Array<{ productId: string; name: string; price: number }> }).cart).toEqual([
      { productId: a.knife.id, quantity: 1, name: "Kitchen Knife Set", price: 890 },
    ]);
  });

  it("storefront-SDK carts stay merchant-assisted: a task, but no automatic email", async () => {
    const s = await shop("rec-sdk");
    const sid = randomUUID();
    const ev = (type: "add_to_cart" | "identify", extra: Record<string, unknown> = {}) => ({
      sessionId: sid,
      type,
      clientEventId: randomUUID(),
      occurredAt: new Date(),
      properties: { productId: "p1", name: "Shirt", price: 900 },
      ...extra,
    });
    await recordServerTrackingEvents(s.merchantId, [ev("add_to_cart"), ev("add_to_cart"), ev("identify", { email: BUYER_EMAIL })]);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    const task = await RecoveryTask.findOne({ merchantId: s.merchantId }).lean();
    expect(task).toMatchObject({ source: "storefront", status: "pending" });
    expect(task?.emailRecovery).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

describe("entitlement", () => {
  it("Starter: landing activity is not collected, no task, no email", async () => {
    const s = await shop("rec-starter");
    await Merchant.updateOne({ _id: s.merchantId }, { $set: { "subscription.tier": "starter" } });
    const r = await act(s, randomUUID(), "add_to_cart", [{ productId: s.shirt.id, quantity: 1 }], { item: { productId: s.shirt.id, quantity: 1 } });
    expect(r).toEqual({ ok: true, recorded: false });
    expect(await TrackingEvent.countDocuments({ merchantId: s.merchantId })).toBe(0);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(await RecoveryTask.countDocuments({ merchantId: s.merchantId })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("Growth, Pro (scale) and Enterprise are emailed", async () => {
    for (const tier of ["growth", "scale", "enterprise"] as const) {
      await resetDb();
      __resetTemplateCacheForTests();
      const s = await shop(`rec-tier-${tier}`, tier);
      await abandon(s);
      const { send, sent } = mailbox();
      await sweepCartRecovery({ now: later(), sendEmail: send });
      expect(sent, tier).toHaveLength(1);
    }
  });

  it("expired trial, suspended and cancelled merchants: a queued email is never sent", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["trial-expired", { "subscription.status": "trial", "subscription.trialEndsAt": new Date(Date.now() - MIN) }],
      ["suspended", { "subscription.status": "suspended" }],
      ["cancelled", { "subscription.status": "cancelled" }],
      ["grace-over", { "subscription.status": "past_due", "subscription.gracePeriodEndsAt": new Date(Date.now() - MIN) }],
    ];
    for (const [name, set] of cases) {
      await resetDb();
      __resetTemplateCacheForTests();
      const s = await shop(`rec-blocked-${name}`);
      await abandon(s);
      const { send, sent } = mailbox();
      await sweepCartRecovery({ now: soon(), sendEmail: send }); // task queued while billable
      await Merchant.updateOne({ _id: s.merchantId }, { $set: set });
      const r = await sweepCartRecovery({ now: later(), sendEmail: send });
      expect(sent, name).toHaveLength(0);
      expect(r.ineligible, name).toBe(1);
      expect((await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())?.emailRecovery?.state, name).toBe("queued");
    }
  });

  it("past_due inside its grace period still recovers (same rule as the API)", async () => {
    const s = await shop("rec-grace");
    await abandon(s);
    await Merchant.updateOne(
      { _id: s.merchantId },
      { $set: { "subscription.status": "past_due", "subscription.gracePeriodEndsAt": new Date(Date.now() + 3 * 24 * 60 * MIN) } },
    );
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(sent).toHaveLength(1);
  });
});

describe("the recovery email", () => {
  it("sends exactly one email, carrying only what the buyer needs", async () => {
    const s = await shop("rec-mail");
    const { sid } = await abandon(s);
    const { send, sent } = mailbox();
    const r = await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(r.emailsSent).toBe(1);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    const task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(m.to).toBe(BUYER_EMAIL);
    expect(m.tag).toBe("cart_recovery");
    expect(m.idempotencyKey).toBe(`cart-recovery-${String(task._id)}`);
    expect(m.subject).toContain("Rahim Fashion");
    expect(m.html).toContain("Premium Cotton Shirt");
    expect(m.html).toContain("Complete your order");
    expect(m.text).toContain("http://rec-mail.localhost:3002/?utm_source=confirmx&utm_medium=email&utm_campaign=cart_recovery#cx_recover=");
    // No internal identifiers, no other personal data in the message.
    for (const secret of [String(task._id), String(s.merchantId), sid, s.shirt.id, customer.phone, "+8801712345678"]) {
      expect(m.html).not.toContain(secret);
      expect(m.text).not.toContain(secret);
    }
    // Only the token's hash is stored.
    const token = tokenIn(m);
    expect(task.emailRecovery?.tokenHash).toBe(hashRecoveryToken(token));
    expect(JSON.stringify(task)).not.toContain(token);
    expect(task).toMatchObject({ status: "contacted", lastChannel: "email", emailRecovery: { state: "sent", attempts: 1, providerMessageId: "re_test_1" } });
    expect(await AuditLog.countDocuments({ merchantId: s.merchantId, action: "recovery.email_sent" })).toBe(1);
  });

  it("a retried or concurrent sweep never sends a second email", async () => {
    const s = await shop("rec-retry");
    await abandon(s);
    const { send, sent } = mailbox();
    await Promise.all([sweepCartRecovery({ now: later(), sendEmail: send }), sweepCartRecovery({ now: later(), sendEmail: send })]);
    await sweepCartRecovery({ now: later() + 10 * MIN, sendEmail: send });
    expect(sent).toHaveLength(1);
  });

  it("two send passes racing on the same task: only one claims it", async () => {
    const s = await shop("rec-race");
    await abandon(s);
    await sweepCartRecovery({ now: soon(), sendEmail: mailbox().send }); // task queued
    const sent: EmailMessage[] = [];
    const slow = async (m: EmailMessage): Promise<EmailDeliveryResult> => {
      sent.push(m);
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, id: "re_race" };
    };
    const now = later();
    const [a, b] = await Promise.all([
      sendDueRecoveryEmails({ merchantId: s.merchantId, now, send: slow }),
      sendDueRecoveryEmails({ merchantId: s.merchantId, now, send: slow }),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a worker that crashed mid-send is retried with the identical message and idempotency key", async () => {
    const s = await shop("rec-crash");
    await abandon(s);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    // Simulate: the provider accepted it but the worker died before recording.
    await RecoveryTask.updateOne(
      { merchantId: s.merchantId },
      { $set: { status: "pending", "emailRecovery.state": "sending", "emailRecovery.lockedUntil": new Date(later() - MIN) } },
    );
    await sweepCartRecovery({ now: later() + MIN, sendEmail: send });
    expect(sent).toHaveLength(2);
    // Same key + same payload → the provider answers from its record, no second delivery.
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(sent[1]!.text).toBe(sent[0]!.text);
    expect(sent[1]!.html).toBe(sent[0]!.html);
  });

  it("a failed send is not recorded as sent, retries with backoff, and gives up after 3 attempts", async () => {
    const s = await shop("rec-fail");
    await abandon(s);
    const { send, sent } = mailbox(() => ({ ok: false, error: "resend_503" }));
    const t0 = later();
    const r = await sweepCartRecovery({ now: t0, sendEmail: send });
    expect(r.emailsFailed).toBe(1);
    let task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(task.status).toBe("pending");
    expect(task.emailRecovery).toMatchObject({ state: "failed", attempts: 1, lastError: "resend_503" });
    expect(task.emailRecovery?.sentAt).toBeUndefined();
    await sweepCartRecovery({ now: t0 + MIN, sendEmail: send }); // inside the backoff
    expect(sent).toHaveLength(1);
    await sweepCartRecovery({ now: t0 + 16 * MIN, sendEmail: send });
    await sweepCartRecovery({ now: t0 + 60 * MIN, sendEmail: send });
    await sweepCartRecovery({ now: t0 + 180 * MIN, sendEmail: send });
    expect(sent).toHaveLength(3);
    task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(task.emailRecovery).toMatchObject({ state: "failed", attempts: 3 });
    expect(task.emailRecovery?.nextAttemptAt).toBeUndefined();
    expect(await RecoveryTask.countDocuments({ merchantId: s.merchantId })).toBe(1);
  });

  it("a permanent provider error is not retried", async () => {
    const s = await shop("rec-perm");
    await abandon(s);
    const { send, sent } = mailbox(() => ({ ok: false, error: "resend_422" }));
    await sweepCartRecovery({ now: later(), sendEmail: send });
    await sweepCartRecovery({ now: later() + 120 * MIN, sendEmail: send });
    expect(sent).toHaveLength(1);
  });

  it("a suppressed recipient (hard bounce via the Resend webhook) is never emailed", async () => {
    const s = await shop("rec-supp");
    await abandon(s);
    await resendWebhook.processResendEvent(`msg_${randomUUID()}`, {
      type: "email.bounced",
      data: { email_id: "re_x", to: [BUYER_EMAIL], bounce: { type: "hard", message: "no mailbox" } },
    });
    expect(await EmailSuppression.countDocuments({ address: BUYER_EMAIL })).toBe(1);
    expect(await EmailEvent.countDocuments()).toBe(1);
    const { send, sent } = mailbox();
    const r = await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(sent).toHaveLength(0);
    expect(r.emailsSuppressed).toBe(1);
    expect((await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())?.emailRecovery?.state).toBe("suppressed");
  });

  it("a buyer who already ordered another way is not emailed", async () => {
    const s = await shop("rec-other");
    await abandon(s);
    await placeWithDelivery(s, [{ productId: s.knife.id, quantity: 1 }]); // normal order, no recovery link
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(sent).toHaveLength(0);
    const task = await RecoveryTask.findOne({ merchantId: s.merchantId }).lean();
    if (task) expect(task.emailRecovery).toMatchObject({ state: "cancelled", cancelReason: "order_exists" });
  });

  it("a cart whose products are all unavailable is not emailed", async () => {
    const s = await shop("rec-oos");
    await abandon(s);
    await Product.updateMany({ merchantId: s.merchantId }, { $set: { "inventory.onHand": 0 } });
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(sent).toHaveLength(0);
    expect((await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())?.emailRecovery).toMatchObject({ state: "cancelled", cancelReason: "cart_unavailable" });
  });

  it("the merchant acting first cancels the queued email", async () => {
    const s = await shop("rec-manual");
    await abandon(s);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: soon(), sendEmail: send });
    const task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    await s.caller.recovery.update({ id: String(task._id), status: "contacted", channel: "call" });
    await sweepCartRecovery({ now: later(), sendEmail: send });
    expect(sent).toHaveLength(0);
    expect((await RecoveryTask.findById(task._id).lean())?.emailRecovery).toMatchObject({ state: "cancelled", cancelReason: "merchant_action" });
  });
});

describe("recovery link → cart → normal checkout → attribution", () => {
  async function emailed(slug: string) {
    const s = await shop(slug);
    const { cart } = await abandon(s);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    return { s, cart, token: tokenIn(sent[0]!) };
  }

  it("rejects malformed and unknown tokens", async () => {
    const { s } = await emailed("rec-bad");
    expect(await restoreRecoveryCart({ host: s.host, locale: null, token: "nope" })).toEqual({ ok: false, code: "invalid" });
    expect(await restoreRecoveryCart({ host: s.host, locale: null, token: deriveRecoveryToken(new Types.ObjectId().toHexString(), "x") })).toEqual({
      ok: false,
      code: "invalid",
    });
    expect((await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())?.emailRecovery?.clicks).toBe(0);
  });

  it("rejects an expired, dismissed or already-recovered link", async () => {
    const { s, token } = await emailed("rec-exp");
    await RecoveryTask.updateOne({ merchantId: s.merchantId }, { $set: { expiresAt: new Date(Date.now() - MIN) } });
    expect(await restoreRecoveryCart({ host: s.host, locale: null, token })).toEqual({ ok: false, code: "expired" });
    await RecoveryTask.updateOne({ merchantId: s.merchantId }, { $set: { expiresAt: new Date(Date.now() + 60 * MIN), status: "dismissed" } });
    expect(await restoreRecoveryCart({ host: s.host, locale: null, token })).toEqual({ ok: false, code: "expired" });
  });

  it("a token never opens another merchant's page or cart", async () => {
    const { s, token } = await emailed("rec-ten-a");
    const other = await shop("rec-ten-b");
    expect(await restoreRecoveryCart({ host: other.host, locale: null, token })).toEqual({ ok: false, code: "invalid" });
    // ...and can't attribute an order on the other merchant's page either.
    const placed = await placeWithDelivery(other, [{ productId: other.knife.id, quantity: 1 }], { recoveryToken: token });
    expect(placed.ok).toBe(true);
    expect((await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())?.status).toBe("contacted");
  });

  it("restores exactly the saved cart, counts the click, and creates no order", async () => {
    const { s, token } = await emailed("rec-restore");
    const r = await restoreRecoveryCart({ host: s.host, locale: null, token });
    expect(r).toEqual({
      ok: true,
      lines: [
        { productId: s.shirt.id, quantity: 2 },
        { productId: s.knife.id, quantity: 1 },
      ],
    });
    await restoreRecoveryCart({ host: s.host, locale: null, token });
    const task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(task.emailRecovery?.clicks).toBe(2);
    expect(task.emailRecovery?.clickedAt).toBeInstanceOf(Date);
    expect(task.status).toBe("contacted");
    expect(await Order.countDocuments({ merchantId: s.merchantId })).toBe(0);
  });

  it("normal checkout from the restored cart creates a normal order linked to the recovery", async () => {
    const { s, token } = await emailed("rec-convert");
    const restored = await restoreRecoveryCart({ host: s.host, locale: null, token });
    if (!restored.ok) throw new Error("restore failed");
    const withLink = await placeWithDelivery(s, restored.lines, { recoveryToken: token });
    expect(withLink.ok).toBe(true);
    if (!withLink.ok) return;
    const o = (await Order.findById(withLink.orderId).lean())!;
    // A completely normal order: same status, prices, stock reservation and source as any landing order.
    expect(o.order).toMatchObject({ status: "pending", subtotal: 2 * 1290 + 890 });
    expect(o.source).toMatchObject({ channel: "landing_page" });
    expect(o.inventory).toMatchObject({ state: "reserved" });
    expect(JSON.stringify(o)).not.toContain(token);

    const task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(task.status).toBe("recovered");
    expect(String(task.recoveredOrderId)).toBe(withLink.orderId);
    expect(task.emailRecovery?.checkoutStartedAt).toBeInstanceOf(Date);
    expect(await AuditLog.countDocuments({ merchantId: s.merchantId, action: "recovery.converted" })).toBe(1);

    // A converted cart never gets another email, and the link can't be attributed twice.
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later() + 60 * MIN, sendEmail: send });
    expect(sent).toHaveLength(0);
    const again = await placeWithDelivery(s, [{ productId: s.knife.id, quantity: 1 }], { recoveryToken: token });
    expect(again.ok).toBe(true);
    expect(String((await RecoveryTask.findById(task._id).lean())?.recoveredOrderId)).toBe(withLink.orderId);
    expect(await linkRecoveredOrder({ host: s.host, locale: null, token, orderId: new Types.ObjectId(), merchantId: s.merchantId })).toBe(false);
  });

  it("recovered revenue follows the existing rule: only once the order is delivered", async () => {
    const { s, token } = await emailed("rec-revenue");
    const restored = await restoreRecoveryCart({ host: s.host, locale: null, token });
    if (!restored.ok) throw new Error("restore failed");
    const placed = await placeWithDelivery(s, restored.lines, { recoveryToken: token });
    if (!placed.ok) throw new Error("order failed");

    let sum = await s.caller.recovery.summary({ days: 30 });
    expect(sum).toMatchObject({
      abandonedCarts: 1,
      tasks: 1,
      emailsSent: 1,
      clicked: 1,
      checkoutsStarted: 1,
      recovered: 1,
      recoveredOrders: 1,
      recoveredOrderValue: placed.total,
      recoveredRevenue: 0,
      recoveryRate: 1,
    });
    await Order.updateOne({ _id: placed.orderId }, { $set: { "order.status": "delivered" } });
    sum = await s.caller.recovery.summary({ days: 30 });
    expect(sum.recoveredRevenue).toBe(placed.total);

    const rows = await s.caller.recovery.list({ limit: 10 });
    expect(rows[0]).toMatchObject({ status: "recovered", emailStatus: "sent", source: "landing_page", recoveredOrder: { status: "delivered", total: placed.total } });
  });

  it("an out-of-stock item at checkout is refused by the normal rules — no order, no conversion", async () => {
    const { s, token } = await emailed("rec-stock");
    const restored = await restoreRecoveryCart({ host: s.host, locale: null, token });
    if (!restored.ok) throw new Error("restore failed");
    await Product.updateOne({ _id: s.knife.id }, { $set: { "inventory.onHand": 0 } });
    const r = await placeWithDelivery(s, restored.lines, { recoveryToken: token });
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(await Order.countDocuments({ merchantId: s.merchantId })).toBe(0);
    const task = (await RecoveryTask.findOne({ merchantId: s.merchantId }).lean())!;
    expect(task.status).toBe("contacted");
    expect(task.emailRecovery?.checkoutStartedAt).toBeInstanceOf(Date);
  });

  it("orders without a recovery token are untouched by recovery", async () => {
    const s = await shop("rec-normal");
    const r = await placeWithDelivery(s, [{ productId: s.shirt.id, quantity: 1 }]);
    expect(r.ok).toBe(true);
    expect(await RecoveryTask.countDocuments()).toBe(0);
  });
});

describe("HTTP endpoints", () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use("/api/landing/activity", landingActivityRouter);
    a.use("/api/landing/recover", landingRecoverRouter);
    return a;
  }
  async function post(path: string, body: unknown) {
    return new Promise<{ status: number; body: any; headers: Headers }>((resolve, reject) => {
      const server = app().listen(0, () => {
        const port = (server.address() as { port: number }).port;
        fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => {
            const json = await r.json().catch(() => ({}));
            server.close();
            resolve({ status: r.status, body: json, headers: r.headers });
          })
          .catch((e) => {
            server.close();
            reject(e);
          });
      });
    });
  }

  it("activity: accepted for a live page, rejected for junk and unknown hosts", async () => {
    const s = await shop("rec-http");
    const ok = await post("/api/landing/activity", {
      host: s.host,
      sessionId: randomUUID(),
      type: "add_to_cart",
      clientEventId: randomUUID(),
      cart: [{ productId: s.shirt.id, quantity: 1 }],
      item: { productId: s.shirt.id, quantity: 1 },
    });
    expect(ok).toMatchObject({ status: 202, body: { ok: true, recorded: true } });
    expect((await post("/api/landing/activity", { host: s.host, sessionId: "x", type: "add_to_cart", clientEventId: randomUUID() })).status).toBe(400);
    expect((await post("/api/landing/activity", { host: s.host, sessionId: randomUUID(), type: "purchase", clientEventId: randomUUID() })).status).toBe(400);
    expect((await post("/api/landing/activity", { host: "nobody.localhost", sessionId: randomUUID(), type: "add_to_cart", clientEventId: randomUUID() })).status).toBe(404);
  });

  it("recover: no-store, 400 for an invalid token, 200 with ids + quantities only", async () => {
    const s = await shop("rec-http2");
    await abandon(s);
    const { send, sent } = mailbox();
    await sweepCartRecovery({ now: later(), sendEmail: send });
    const bad = await post("/api/landing/recover", { host: s.host, token: "A".repeat(43) });
    expect(bad.status).toBe(400);
    const good = await post("/api/landing/recover", { host: s.host, token: tokenIn(sent[0]!) });
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(good.body)).toEqual(["ok", "lines"]);
    expect(JSON.stringify(good.body)).not.toMatch(/buyer@|8801|Rahim/);
  });
});
