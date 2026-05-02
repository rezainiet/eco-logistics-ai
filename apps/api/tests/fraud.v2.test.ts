import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { Merchant, Notification, Order } from "@ecom/db";
import { __TEST, computeRisk, hashAddress } from "../src/server/risk.js";
import { processRescoreJob } from "../src/workers/riskRecompute.js";
import {
  authUserFor,
  callerFor,
  createMerchant,
  disconnectDb,
  resetDb,
} from "./helpers.js";

const cleanCustomer = {
  name: "Rahim Uddin",
  phone: "+8801711111111",
  address: "House 1, Road 2, Block A",
  district: "Dhaka",
};

const zeroHistory = {
  phoneOrdersCount: 0,
  phoneReturnedCount: 0,
  phoneCancelledCount: 0,
  phoneUnreachableCount: 0,
  ipRecentCount: 0,
  phoneVelocityCount: 0,
  addressDistinctPhones: 0,
  addressReturnedCount: 0,
};

describe("risk engine v2 — expanded heuristics", () => {
  it("hashAddress normalizes token order and casing", () => {
    const a = hashAddress("House 1, Road 2", "Dhaka");
    const b = hashAddress("road 2 house 1", "dhaka");
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("hashAddress returns null for junk / too-short input", () => {
    expect(hashAddress("", "")).toBeNull();
    expect(hashAddress("a", "")).toBeNull();
  });

  it("blocked_phone signal fires a HIGH score on a single hit", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      zeroHistory,
      { blockedPhones: ["+8801711111111"] },
    );
    expect(r.signals.map((s) => s.key)).toContain("blocked_phone");
    expect(r.level).toBe("high");
    expect(r.reviewStatus).toBe("pending_call");
  });

  it("blocked_phone ignores formatting differences", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      zeroHistory,
      { blockedPhones: ["8801711111111"] },
    );
    expect(r.signals.map((s) => s.key)).toContain("blocked_phone");
  });

  it("blocked_address signal fires when order carries a blocked hash", () => {
    const hash = hashAddress("House 5, Road 10", "Dhaka");
    expect(hash).not.toBeNull();
    const r = computeRisk(
      {
        cod: 500,
        customer: { ...cleanCustomer, address: "House 5, Road 10", district: "Dhaka" },
        addressHash: hash,
      },
      zeroHistory,
      { blockedAddresses: [hash!] },
    );
    expect(r.signals.map((s) => s.key)).toContain("blocked_address");
    expect(r.level).toBe("high");
  });

  it("duplicate_address fires at the distinct-phones threshold", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer, addressHash: "abc" },
      { ...zeroHistory, addressDistinctPhones: __TEST.ADDRESS_REUSE_THRESHOLD },
    );
    expect(r.signals.map((s) => s.key)).toContain("duplicate_address");
  });

  it("duplicate_address half-weight fires for any prior return at the address", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer, addressHash: "abc" },
      { ...zeroHistory, addressReturnedCount: 1 },
    );
    const sig = r.signals.find((s) => s.key === "duplicate_address");
    expect(sig).toBeDefined();
    expect(sig!.weight).toBe(__TEST.WEIGHTS.duplicateAddress / 2);
  });

  it("velocity_breach respects the merchant threshold", () => {
    const below = computeRisk(
      { cod: 500, customer: cleanCustomer },
      { ...zeroHistory, phoneVelocityCount: 2 },
      { velocityThreshold: 3 },
    );
    expect(below.signals.map((s) => s.key)).not.toContain("velocity_breach");

    const at = computeRisk(
      { cod: 500, customer: cleanCustomer },
      { ...zeroHistory, phoneVelocityCount: 3 },
      { velocityThreshold: 3 },
    );
    expect(at.signals.map((s) => s.key)).toContain("velocity_breach");
  });

  it("velocityThreshold=0 disables the signal entirely", () => {
    const r = computeRisk(
      { cod: 500, customer: cleanCustomer },
      { ...zeroHistory, phoneVelocityCount: 100 },
      { velocityThreshold: 0 },
    );
    expect(r.signals.map((s) => s.key)).not.toContain("velocity_breach");
  });

  it("expanded fake-name heuristic catches placeholder names", () => {
    const fakes = [
      "name",
      "customer",
      "nobody",
      "john doe",
      "John Doe",
      "qwerty123",
      "asdfgh",
      "bcdfg",
      "Jane Doe",
      "unknown",
    ];
    for (const n of fakes) {
      const r = computeRisk(
        { cod: 500, customer: { ...cleanCustomer, name: n } },
        zeroHistory,
      );
      expect(r.signals.map((s) => s.key), `should flag "${n}"`).toContain(
        "fake_name_pattern",
      );
    }
  });

  it("decayWeight halves at the half-life", () => {
    const halfLife = 30;
    expect(__TEST.decayWeight(0, halfLife)).toBe(1);
    expect(__TEST.decayWeight(halfLife, halfLife)).toBeCloseTo(0.5, 4);
    expect(__TEST.decayWeight(halfLife * 2, halfLife)).toBeCloseTo(0.25, 4);
    // Half-life 0 disables decay.
    expect(__TEST.decayWeight(999, 0)).toBe(1);
  });

  it("merchant-configurable COD thresholds override defaults", () => {
    // With a high-ticket merchant override, ৳5000 shouldn't trip high_cod.
    const noop = computeRisk(
      { cod: 5000, customer: cleanCustomer },
      zeroHistory,
      { highCodBdt: 20_000, extremeCodBdt: 50_000 },
    );
    expect(noop.signals.map((s) => s.key)).not.toContain("high_cod");
    // A low-ticket merchant override turns ৳3000 into an extreme_cod.
    const extreme = computeRisk(
      { cod: 3000, customer: cleanCustomer },
      zeroHistory,
      { highCodBdt: 1_000, extremeCodBdt: 2_000 },
    );
    expect(extreme.signals.map((s) => s.key)).toContain("extreme_cod");
  });
});

describe("merchants.updateFraudConfig", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("hashes raw blocked addresses and dedupes suspicious districts", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const res = await caller.merchants.updateFraudConfig({
      blockedAddressesRaw: [
        { address: "House 1, Road 2", district: "Dhaka" },
        { address: "House 1, Road 2", district: "Dhaka" }, // duplicate
      ],
      suspiciousDistricts: ["Sandwip", " Sandwip ", "Bhola"],
    });
    expect(res.blockedAddresses).toHaveLength(1);
    expect(res.blockedAddresses[0]).toMatch(/^[a-f0-9]{16,}$/);
    expect(res.suspiciousDistricts).toEqual(["Sandwip", "Bhola"]);
  });

  it("scoring picks up merchant tunables end-to-end", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await caller.merchants.updateFraudConfig({
      blockedPhones: ["+8801799999999"],
      alertOnPendingReview: true,
    });

    const created = await caller.orders.createOrder({
      customer: {
        name: "Some One",
        phone: "+8801799999999",
        address: "House 2, Road 4",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(created.risk.level).toBe("high");
    expect(created.risk.reasons).toContain("Phone is on the merchant block-list");

    const notifications = await Notification.find({ merchantId: m._id }).lean();
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0]!.kind).toBe("fraud.pending_review");
  });

  it("null threshold reverts to platform default", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await caller.merchants.updateFraudConfig({
      highCodThreshold: 1000,
    });
    let cfg = await caller.merchants.getFraudConfig();
    expect(cfg.highCodThreshold).toBe(1000);
    await caller.merchants.updateFraudConfig({ highCodThreshold: null });
    cfg = await caller.merchants.getFraudConfig();
    expect(cfg.highCodThreshold).toBeNull();
  });
});

describe("createOrder fraud v2 — IP + alerts", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("captures request IP, userAgent, and addressHash on Order.create", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m), {
      ip: "203.0.113.42",
      userAgent: "VitestRunner/1.0",
    });
    const created = await caller.orders.createOrder({
      customer: {
        name: "Karim Ahmed",
        phone: "+8801700000001",
        address: "House 1, Road 5",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    const doc = await Order.findById(created.id).lean();
    expect(doc?.source?.ip).toBe("203.0.113.42");
    expect(doc?.source?.userAgent).toBe("VitestRunner/1.0");
    expect(doc?.source?.addressHash).toBeTruthy();
    expect(doc?.source?.channel).toBe("dashboard");
  });

  it("writes a fraud.pending_review notification when score lands HIGH", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    // Seed a prior RTO so the risky order crosses into HIGH.
    await Order.create({
      merchantId: m._id,
      orderNumber: "PRIOR-X",
      customer: {
        name: "Prior",
        phone: "+8801788888888",
        address: "Prior addr",
        district: "Dhaka",
      },
      items: [{ name: "Thing", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "rto" },
    });
    const created = await caller.orders.createOrder({
      customer: {
        name: "xxx",
        phone: "+8801788888888",
        address: "Somewhere",
        district: "unknown",
      },
      items: [{ name: "Phone", quantity: 1, price: 12000 }],
      cod: 12000,
    });
    expect(created.risk.level).toBe("high");
    const notifications = await Notification.find({ merchantId: m._id }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.kind).toBe("fraud.pending_review");
    expect(notifications[0]!.severity).toBe("critical");
    expect(notifications[0]!.readAt).toBeNull();
  });
});

describe("bulkUpload fraud v2 — history integrity", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("applies real phone history to every uploaded row", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const phone = "+8801766666666";
    // Seed 2 prior RTOs so the prior_returns signal should fire on the bulk row.
    for (let i = 0; i < 2; i++) {
      await Order.create({
        merchantId: m._id,
        orderNumber: `PR-${i}`,
        customer: { name: "Prior", phone, address: "Prev", district: "Dhaka" },
        items: [{ name: "X", quantity: 1, price: 500 }],
        order: { cod: 500, total: 500, status: "rto" },
      });
    }
    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod",
      `BULK-1,Karim,${phone},House 3 Road 4,Dhaka,Shirt,1,500,500`,
    ].join("\n");
    const res = await caller.orders.bulkUpload({ csv });
    expect(res.inserted).toBe(1);
    const bulk = await Order.findOne({ orderNumber: "BULK-1" }).lean();
    expect(
      bulk?.fraud?.reasons?.some((r) => /failed deliver|RTO/i.test(r)),
    ).toBe(true);
  });

  it("prevents within-CSV duplicate-phone bypass via dedup pass", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const phone = "+8801755555555";
    const rows = ["orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod"];
    for (let i = 0; i < __TEST.DUP_PHONE_HEAVY + 1; i++) {
      rows.push(`BULK-${i},Karim,${phone},House 3 Road 4,Dhaka,Shirt,1,500,500`);
    }
    const res = await caller.orders.bulkUpload({ csv: rows.join("\n") });
    // Only the FIRST row inserts; the rest are reported as duplicates of an
    // earlier row in the same CSV. This is a stronger defense than letting
    // them all in and lighting up duplicate_phone_heavy on the last one.
    expect(res.inserted).toBe(1);
    expect(res.duplicates.length).toBe(__TEST.DUP_PHONE_HEAVY);
    expect(res.duplicates[0]!.matchedOrderNumber).toMatch(/another row/i);
    const persistedCount = await Order.countDocuments({ "customer.phone": phone });
    expect(persistedCount).toBe(1);
  });

  it("captures uploader IP + bulk_upload channel on every row", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m), { ip: "198.51.100.7", userAgent: "CsvBot" });
    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod",
      `BULK-A,Karim,+8801722000001,House 1,Dhaka,Shirt,1,500,500`,
      `BULK-B,Rahim,+8801722000002,House 2,Dhaka,Shirt,1,500,500`,
    ].join("\n");
    await caller.orders.bulkUpload({ csv });
    const orders = await Order.find({ orderNumber: { $in: ["BULK-A", "BULK-B"] } }).lean();
    expect(orders).toHaveLength(2);
    for (const o of orders) {
      expect(o.source?.ip).toBe("198.51.100.7");
      expect(o.source?.channel).toBe("bulk_upload");
    }
  });

  it("fires notifications for HIGH rows that actually landed", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    await caller.merchants.updateFraudConfig({
      blockedPhones: ["+8801733333333"],
    });
    const csv = [
      "orderNumber,customerName,customerPhone,customerAddress,customerDistrict,itemName,quantity,price,cod",
      `BULK-H,Karim,+8801733333333,House 1,Dhaka,Shirt,1,500,500`,
      `BULK-OK,Rahim,+8801744444444,House 2,Dhaka,Shirt,1,500,500`,
    ].join("\n");
    const res = await caller.orders.bulkUpload({ csv });
    expect(res.inserted).toBe(2);
    expect(res.flagged).toBe(1);
    const notifications = await Notification.find({ merchantId: m._id }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.subjectId?.toString()).toBeTruthy();
    const target = await Order.findById(notifications[0]!.subjectId).lean();
    expect(target?.orderNumber).toBe("BULK-H");
  });
});

describe("risk-recompute worker", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("rescores open orders when a sibling order flips to RTO", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const phone = "+8801777000001";

    // Two clean pending orders from the same phone → low risk today.
    const a = await caller.orders.createOrder({
      customer: { name: "Karim", phone, address: "H1 R1", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      cod: 500,
    });
    const b = await caller.orders.createOrder({
      customer: { name: "Karim", phone, address: "H2 R2", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(a.risk.level).not.toBe("high");
    expect(b.risk.level).not.toBe("high");

    // Simulate a sibling order that already hit RTO.
    const rtoDoc = await Order.create({
      merchantId: m._id,
      orderNumber: "RTO-1",
      customer: { name: "Karim", phone, address: "Prev", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "rto" },
    });
    // And a second one so the decayed prior_returns count stays >= 1
    // independent of fractional weighting.
    await Order.create({
      merchantId: m._id,
      orderNumber: "RTO-2",
      customer: { name: "Karim", phone, address: "Prev", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "rto" },
    });

    const res = await processRescoreJob({
      merchantId: String(m._id),
      phone,
      trigger: "order.rto",
      triggerOrderId: String(rtoDoc._id),
    });

    expect(res.rescored).toBe(2);
    const after = await Order.find({ _id: { $in: [a.id, b.id].map((x) => new Types.ObjectId(x)) } }).lean();
    for (const o of after) {
      expect(
        (o.fraud?.reasons ?? []).some((r) => /failed deliver|rto/i.test(r)),
      ).toBe(true);
    }
  });

  it("does not overwrite terminal review states", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const phone = "+8801777000002";

    // Seed prior RTO to push scoring toward HIGH.
    await Order.create({
      merchantId: m._id,
      orderNumber: "PR-1",
      customer: { name: "Karim", phone, address: "Prev", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      order: { cod: 500, total: 500, status: "rto" },
    });
    const created = await caller.orders.createOrder({
      customer: {
        name: "xxx",
        phone,
        address: "H1 R1",
        district: "unknown",
      },
      items: [{ name: "Phone", quantity: 1, price: 12000 }],
      cod: 12000,
    });
    expect(created.risk.reviewStatus).toBe("pending_call");
    await caller.fraud.markVerified({ id: created.id });

    const res = await processRescoreJob({
      merchantId: String(m._id),
      phone,
      trigger: "manual",
    });
    // Rescored, but the terminal review status is preserved.
    expect(res.rescored).toBeGreaterThanOrEqual(1);
    const after = await Order.findById(created.id).lean();
    expect(after?.fraud?.reviewStatus).toBe("verified");
  });

  it("emits an alert on elevation to HIGH", async () => {
    const m = await createMerchant({ tier: "growth" });
    const caller = callerFor(authUserFor(m));
    const phone = "+8801777000003";

    // Clean order first.
    const open = await caller.orders.createOrder({
      customer: { name: "Karim", phone, address: "H1 R1", district: "Dhaka" },
      items: [{ name: "X", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(open.risk.level).not.toBe("high");

    // Now add the merchant block so a rescore lights up HIGH.
    await caller.merchants.updateFraudConfig({ blockedPhones: [phone] });

    const res = await processRescoreJob({
      merchantId: String(m._id),
      phone,
      trigger: "review.rejected",
    });
    expect(res.elevatedToHigh).toBe(1);
    expect(res.alerts).toBe(1);
    const notifications = await Notification.find({ merchantId: m._id, kind: "fraud.rescored_high" }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.subjectId?.toString()).toBe(open.id);
  });

  it("gracefully returns zero when merchant has no open orders", async () => {
    const m = await createMerchant({ tier: "growth" });
    const res = await processRescoreJob({
      merchantId: String(m._id),
      phone: "+8801799990000",
      trigger: "manual",
    });
    expect(res.rescored).toBe(0);
    expect(res.errors).toBe(0);
  });
});

describe("notifications router", () => {
  beforeEach(resetDb);
  afterAll(disconnectDb);

  it("lists unread fraud alerts with an accurate counter", async () => {
    const m = await createMerchant({ tier: "growth" });
    await Merchant.updateOne(
      { _id: m._id },
      { $set: { "fraudConfig.blockedPhones": ["+8801799999991"] } },
    );
    const caller = callerFor(authUserFor(m));
    const created = await caller.orders.createOrder({
      customer: {
        name: "Any",
        phone: "+8801799999991",
        address: "House 9",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(created.risk.level).toBe("high");

    const list = await caller.notifications.list({
      cursor: null,
      limit: 25,
      onlyUnread: true,
    });
    expect(list.unread).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.kind).toBe("fraud.pending_review");

    const { unread: unreadAfter } = await caller.notifications.unreadCount();
    expect(unreadAfter).toBe(1);

    await caller.notifications.markAllRead();
    const after = await caller.notifications.unreadCount();
    expect(after.unread).toBe(0);
  });
});
