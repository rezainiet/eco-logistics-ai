import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Merchant, Order } from "@ecom/db";
import { __TEST as book, MAX_AUTO_BOOK_AGE_MS } from "../src/workers/automationBook.js";
import { runAutomationWatchdog } from "../src/workers/automationWatchdog.js";
import { createMerchant, disconnectDb, ensureDb, resetDb } from "./helpers.js";

/**
 * Automatic courier booking must only ever act on a fresh confirmation for
 * a merchant who has auto-book switched on. Production had three orders
 * from April/May re-enqueued every 5 minutes by the watchdog; with valid
 * job ids that would have turned into real courier bookings.
 */

async function merchant(autoBookEnabled: boolean) {
  const m = await createMerchant();
  await Merchant.updateOne(
    { _id: m._id },
    { $set: { "automationConfig.enabled": true, "automationConfig.mode": "full_auto", "automationConfig.autoBookEnabled": autoBookEnabled } },
  );
  return m._id as Types.ObjectId;
}

async function confirmedOrder(merchantId: Types.ObjectId, confirmedMinutesAgo: number, status = "confirmed") {
  return Order.create({
    merchantId,
    orderNumber: `ORD-${new Types.ObjectId().toHexString().slice(-8)}`,
    customer: { name: "C", phone: "+8801711111111", address: "House 1", district: "Dhaka" },
    items: [{ name: "Item", quantity: 1, price: 500 }],
    order: { cod: 500, total: 500, status },
    automation: { state: "confirmed", confirmedAt: new Date(Date.now() - confirmedMinutesAgo * 60_000) },
  });
}

beforeAll(ensureDb);
afterAll(disconnectDb);
beforeEach(resetDb);

describe("automation watchdog only re-enqueues orders auto-book still applies to", () => {
  it("skips merchants with auto-book off, stale confirmations and non-bookable orders", async () => {
    const on = await merchant(true);
    const off = await merchant(false);
    await confirmedOrder(on, 30); // stuck 30 min, auto-book on → re-enqueue
    await confirmedOrder(off, 30); // auto-book off → never
    await confirmedOrder(on, 5 * 30 * 24 * 60); // ~5 months old → never
    await confirmedOrder(on, 30, "cancelled"); // not bookable → never
    await confirmedOrder(on, 30, "delivered");

    const r = await runAutomationWatchdog();
    expect(r.scanned).toBe(2); // the fresh bookable orders of both merchants
    expect(r.reEnqueued).toBe(1); // only the merchant with auto-book on
  });
});

describe("auto-book worker refuses stale or disabled bookings at run time", () => {
  it("auto-book switched off → skipped, nothing booked", async () => {
    const off = await merchant(false);
    const o = await confirmedOrder(off, 30);
    const r = await book.bookOrThrow({ orderId: String(o._id), merchantId: String(off), userId: "u" });
    expect(r).toMatchObject({ ok: true, status: "skipped", error: "auto_book_disabled" });
  });

  it("confirmation older than the limit → skipped as stale", async () => {
    const on = await merchant(true);
    const o = await confirmedOrder(on, MAX_AUTO_BOOK_AGE_MS / 60_000 + 60);
    const r = await book.bookOrThrow({ orderId: String(o._id), merchantId: String(on), userId: "u" });
    expect(r).toMatchObject({ ok: true, status: "skipped", error: "stale_confirmation" });
    const after = await Order.findById(o._id).lean();
    expect(after!.logistics?.trackingNumber).toBeFalsy();
  });
});
