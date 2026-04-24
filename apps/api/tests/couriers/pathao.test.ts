import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MockPathaoTransport,
  PathaoAdapter,
  __clearPathaoTokenCache,
} from "../../src/lib/couriers/pathao.js";
import { beforeEach } from "vitest";
import { CourierError } from "../../src/lib/couriers/types.js";
import type { PathaoTransport } from "../../src/lib/couriers/pathao.js";

const creds = {
  accountId: "client-123",
  apiKey: "sk_test_demo",
  apiSecret: "secret-abc",
};

function makeAdapter(transport: PathaoTransport): PathaoAdapter {
  return new PathaoAdapter({ credentials: creds, transport });
}

describe("PathaoAdapter (mock transport)", () => {
  beforeEach(() => {
    MockPathaoTransport.reset();
  });
  afterEach(() => {
    __clearPathaoTokenCache();
    vi.restoreAllMocks();
  });

  it("validateCredentials returns valid=true for good creds", async () => {
    const adapter = makeAdapter(new MockPathaoTransport());
    const res = await adapter.validateCredentials();
    expect(res.valid).toBe(true);
  });

  it("validateCredentials returns valid=false on auth failure", async () => {
    const adapter = new PathaoAdapter({
      credentials: { ...creds, accountId: "" },
      transport: new MockPathaoTransport(),
    });
    const res = await adapter.validateCredentials();
    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/invalid/i);
  });

  it("createAWB returns a trackingNumber + consignment id", async () => {
    const adapter = makeAdapter(new MockPathaoTransport());
    const awb = await adapter.createAWB({
      orderNumber: "ORD-1",
      customer: {
        name: "Jane",
        phone: "+8801712345678",
        address: "Road 5, Dhaka",
        district: "Dhaka",
      },
      items: [{ name: "Shirt", quantity: 1, price: 500 }],
      cod: 500,
    });
    expect(awb.trackingNumber).toMatch(/^PTH-/);
    expect(awb.providerOrderId).toBe(awb.trackingNumber);
    expect(awb.estimatedDeliveryAt).toBeInstanceOf(Date);
    expect(typeof awb.fee).toBe("number");
  });

  it("getTracking normalizes provider status to lifecycle enum", async () => {
    const transport = new MockPathaoTransport();
    const adapter = makeAdapter(transport);
    const awb = await adapter.createAWB({
      orderNumber: "ORD-2",
      customer: { name: "A", phone: "+8801700000000", address: "x", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
    });
    const info = await adapter.getTracking(awb.trackingNumber);
    expect(info.trackingNumber).toBe(awb.trackingNumber);
    expect(["pending", "picked_up", "in_transit", "out_for_delivery"]).toContain(info.normalizedStatus);
    expect(info.events.length).toBeGreaterThan(0);
  });

  it("priceQuote returns a numeric amount in BDT", async () => {
    const adapter = makeAdapter(new MockPathaoTransport());
    const quote = await adapter.priceQuote({ district: "Dhaka", weight: 1.5, cod: 1000 });
    expect(quote.currency).toBe("BDT");
    expect(quote.amount).toBeGreaterThan(0);
  });

  it("retries transient transport failures before giving up", async () => {
    let calls = 0;
    const flaky: PathaoTransport = {
      async request<T>(path: string): Promise<{ status: number; ok: boolean; data: T }> {
        if (path.endsWith("/issue-token")) {
          return {
            status: 200,
            ok: true,
            data: { access_token: "tok", expires_in: 3600 } as unknown as T,
          };
        }
        if (path.endsWith("/orders")) {
          calls++;
          if (calls < 2) {
            throw new CourierError("network", "econnreset", { retryable: true, provider: "pathao" });
          }
          return { status: 200, ok: true, data: { consignment_id: "PTH-OK-1" } as unknown as T };
        }
        return { status: 404, ok: false, data: null as unknown as T };
      },
    };
    const adapter = makeAdapter(flaky);
    const awb = await adapter.createAWB({
      orderNumber: "ORD-R",
      customer: { name: "X", phone: "+8801700000000", address: "x", district: "Dhaka" },
      items: [{ name: "Item", quantity: 1, price: 100 }],
      cod: 100,
    });
    expect(awb.trackingNumber).toBe("PTH-OK-1");
    expect(calls).toBe(2);
  });

  it("does not retry non-retryable (4xx) provider errors", async () => {
    let calls = 0;
    const rejecting: PathaoTransport = {
      async request<T>(path: string): Promise<{ status: number; ok: boolean; data: T }> {
        if (path.endsWith("/issue-token")) {
          return {
            status: 200,
            ok: true,
            data: { access_token: "tok", expires_in: 3600 } as unknown as T,
          };
        }
        calls++;
        return {
          status: 422,
          ok: false,
          data: { message: "invalid district" } as unknown as T,
        };
      },
    };
    const adapter = makeAdapter(rejecting);
    await expect(
      adapter.createAWB({
        orderNumber: "ORD-X",
        customer: { name: "X", phone: "+8801700000000", address: "x", district: "Invalid" },
        items: [{ name: "Item", quantity: 1, price: 100 }],
        cod: 100,
      }),
    ).rejects.toBeInstanceOf(CourierError);
    expect(calls).toBe(1);
  });
});
