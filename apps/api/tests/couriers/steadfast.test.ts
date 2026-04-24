import { beforeEach, describe, expect, it } from "vitest";
import {
  MockSteadfastTransport,
  SteadfastAdapter,
  type SteadfastTransport,
} from "../../src/lib/couriers/steadfast.js";
import { CourierError } from "../../src/lib/couriers/types.js";

const creds = {
  accountId: "acc-sf",
  apiKey: "sk_sf_api",
  apiSecret: "sk_sf_secret",
};

function makeAdapter(transport: SteadfastTransport): SteadfastAdapter {
  return new SteadfastAdapter({ credentials: creds, transport });
}

describe("SteadfastAdapter (mock transport)", () => {
  beforeEach(() => {
    MockSteadfastTransport.reset();
  });

  it("validateCredentials succeeds on the balance endpoint", async () => {
    const res = await makeAdapter(new MockSteadfastTransport()).validateCredentials();
    expect(res.valid).toBe(true);
  });

  it("createAWB returns a tracking code and consignment id", async () => {
    const adapter = makeAdapter(new MockSteadfastTransport());
    const awb = await adapter.createAWB({
      orderNumber: "ORD-SF-1",
      customer: {
        name: "Jane",
        phone: "+8801712345678",
        address: "Road 5",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(awb.trackingNumber).toMatch(/^SF/);
    expect(awb.providerOrderId).toBeTruthy();
  });

  it("getTracking normalizes delivery_status to lifecycle enum", async () => {
    const transport = new MockSteadfastTransport();
    const adapter = makeAdapter(transport);
    const awb = await adapter.createAWB({
      orderNumber: "ORD-SF-2",
      customer: { name: "A", phone: "+8801700000000", address: "x", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
    });
    const info = await adapter.getTracking(awb.trackingNumber);
    expect(info.trackingNumber).toBe(awb.trackingNumber);
    expect([
      "pending",
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "rto",
      "failed",
      "unknown",
    ]).toContain(info.normalizedStatus);
    expect(info.events.length).toBeGreaterThan(0);
  });

  it("priceQuote computes BDT charges from district/weight/cod", async () => {
    const quote = await makeAdapter(new MockSteadfastTransport()).priceQuote({
      district: "Dhaka",
      weight: 1,
      cod: 1000,
    });
    expect(quote.currency).toBe("BDT");
    expect(quote.amount).toBeGreaterThan(0);
  });

  it("retries transient failures before giving up", async () => {
    let calls = 0;
    const flaky: SteadfastTransport = {
      async request<T>(path: string): Promise<{ status: number; ok: boolean; data: T }> {
        if (path.endsWith("/create_order")) {
          calls++;
          if (calls < 2) {
            throw new CourierError("network", "econnreset", { retryable: true, provider: "steadfast" });
          }
          return {
            status: 200,
            ok: true,
            data: {
              status: 200,
              consignment: { consignment_id: 42, tracking_code: "SF-OK-1" },
            } as unknown as T,
          };
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
    expect(awb.trackingNumber).toBe("SF-OK-1");
    expect(calls).toBe(2);
  });

  it("does not retry 4xx provider errors", async () => {
    let calls = 0;
    const rejecting: SteadfastTransport = {
      async request<T>(): Promise<{ status: number; ok: boolean; data: T }> {
        calls++;
        return { status: 422, ok: false, data: { message: "invalid" } as unknown as T };
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
