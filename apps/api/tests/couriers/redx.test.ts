import { beforeEach, describe, expect, it } from "vitest";
import {
  MockRedxTransport,
  RedxAdapter,
  type RedxTransport,
} from "../../src/lib/couriers/redx.js";
import { CourierError } from "../../src/lib/couriers/types.js";

const creds = {
  accountId: "acc-redx",
  apiKey: "redx_token_demo",
};

function makeAdapter(transport: RedxTransport): RedxAdapter {
  return new RedxAdapter({ credentials: creds, transport });
}

describe("RedxAdapter (mock transport)", () => {
  beforeEach(() => {
    MockRedxTransport.reset();
  });

  it("validateCredentials succeeds when /v1.0.0-beta/areas returns data", async () => {
    const res = await makeAdapter(new MockRedxTransport()).validateCredentials();
    expect(res.valid).toBe(true);
  });

  it("createAWB returns a tracking_id", async () => {
    const awb = await makeAdapter(new MockRedxTransport()).createAWB({
      orderNumber: "ORD-RX-1",
      customer: {
        name: "Jane",
        phone: "+8801712345678",
        address: "Road 5",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(awb.trackingNumber).toMatch(/^RDX-/);
    expect(awb.providerOrderId).toBe(awb.trackingNumber);
  });

  it("getTracking surfaces timeline events with normalized status", async () => {
    const transport = new MockRedxTransport();
    const adapter = makeAdapter(transport);
    const awb = await adapter.createAWB({
      orderNumber: "ORD-RX-2",
      customer: { name: "A", phone: "+8801700000000", address: "x", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
    });
    const info = await adapter.getTracking(awb.trackingNumber);
    expect(info.trackingNumber).toBe(awb.trackingNumber);
    expect(info.events.length).toBeGreaterThanOrEqual(2);
    expect(["pending", "picked_up", "in_transit"]).toContain(info.normalizedStatus);
  });

  it("priceQuote returns a BDT amount", async () => {
    const quote = await makeAdapter(new MockRedxTransport()).priceQuote({
      district: "Dhaka",
      weight: 1,
      cod: 1000,
      deliveryAreaId: 12,
      pickupAreaId: 1,
    });
    expect(quote.currency).toBe("BDT");
    expect(quote.amount).toBeGreaterThan(0);
  });

  // Official contract (redx.com.bd/developer-api, "Calculate Parcel Charge"):
  // GET /charge/charge_calculator?delivery_area_id&pickup_area_id&cash_collection_amount&weight(grams)
  // → { deliveryCharge, codCharge }
  it("priceQuote calls the official charge calculator and maps its response", async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const t: RedxTransport = {
      async request<T>(path: string, opts: { method?: string; body?: unknown }) {
        calls.push({ path, method: opts.method, body: opts.body });
        return { status: 200, ok: true, data: { deliveryCharge: 60, codCharge: 13 } as unknown as T };
      },
    };
    const quote = await makeAdapter(t).priceQuote({ district: "Dhaka", weight: 1.5, cod: 1300, deliveryAreaId: 12, pickupAreaId: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    const [path, qs] = calls[0]!.path.split("?");
    expect(path).toBe("/v1.0.0-beta/charge/charge_calculator");
    expect(Object.fromEntries(new URLSearchParams(qs))).toEqual({
      delivery_area_id: "12",
      pickup_area_id: "1",
      cash_collection_amount: "1300",
      weight: "1500",
    });
    expect(quote).toMatchObject({ amount: 73, currency: "BDT", breakdown: { delivery: 60, cod: 13 } });
  });

  it("priceQuote refuses without RedX area ids instead of guessing them", async () => {
    let called = false;
    const t: RedxTransport = {
      async request<T>() {
        called = true;
        return { status: 200, ok: true, data: {} as unknown as T };
      },
    };
    await expect(makeAdapter(t).priceQuote({ district: "Dhaka", weight: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(called).toBe(false);
  });

  it("retries transient failures", async () => {
    let calls = 0;
    const flaky: RedxTransport = {
      async request<T>(path: string): Promise<{ status: number; ok: boolean; data: T }> {
        if (path.endsWith("/v1.0.0-beta/parcel")) {
          calls++;
          if (calls < 2) {
            throw new CourierError("network", "econnreset", { retryable: true, provider: "redx" });
          }
          return { status: 200, ok: true, data: { tracking_id: "RDX-OK-1" } as unknown as T };
        }
        return { status: 404, ok: false, data: null as unknown as T };
      },
    };
    const awb = await makeAdapter(flaky).createAWB({
      orderNumber: "ORD-R",
      customer: { name: "X", phone: "+8801700000000", address: "x", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
    });
    expect(awb.trackingNumber).toBe("RDX-OK-1");
    expect(calls).toBe(2);
  });

  it("wraps 4xx errors as CourierError without retrying", async () => {
    let calls = 0;
    const rejecting: RedxTransport = {
      async request<T>(): Promise<{ status: number; ok: boolean; data: T }> {
        calls++;
        return { status: 400, ok: false, data: { message: "bad" } as unknown as T };
      },
    };
    await expect(
      makeAdapter(rejecting).createAWB({
        orderNumber: "ORD-X",
        customer: { name: "X", phone: "+8801700000000", address: "x", district: "Dhaka" },
        items: [{ name: "Item", quantity: 1, price: 100 }],
        cod: 100,
      }),
    ).rejects.toBeInstanceOf(CourierError);
    expect(calls).toBe(1);
  });
});
