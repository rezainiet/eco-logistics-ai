import { describe, expect, it } from "vitest";
import { LocalPbxClient } from "../src/lib/calling/providers/localPbx.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("LocalPbxClient", () => {
  it("maps click-to-call originate to the documented PBX endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new LocalPbxClient({
      baseUrl: "https://pbx.example.test/api/v2/",
      apiToken: "token-123",
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ status: "success", data: { call_id: "call-123", status: "queued" } });
      },
    });

    const result = await client.originate({
      customerId: "cust-1",
      extension: "1001",
      phoneNumber: "+8801711111111",
    });

    expect(result).toMatchObject({ providerCallId: "call-123", status: "queued" });
    expect(calls[0]?.url).toBe("https://pbx.example.test/api/v2/customers/cust-1/calls/originate");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer token-123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      extension: "1001",
      phone_number: "+8801711111111",
    });
  });

  it("maps extension provisioning and inbound routes to telephony customer endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new LocalPbxClient({
      baseUrl: "https://pbx.example.test/api/v2",
      apiToken: "token-123",
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ status: "success", data: {} });
      },
    });

    await client.createExtension({
      customerId: "cust-1",
      extension: "1001",
      password: "secret",
      isWebrtc: true,
    });
    await client.createInboundRoute({
      customerId: "cust-1",
      didNumber: "+8809638000001",
      destinationType: "extension",
      destinationId: "1001",
    });

    expect(calls[0]?.url).toBe("https://pbx.example.test/api/v2/telephony/customers/cust-1/extensions");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      extension: "1001",
      password: "secret",
      is_webrtc: true,
    });
    expect(calls[1]?.url).toBe("https://pbx.example.test/api/v2/telephony/customers/cust-1/inbound-routes");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      did_number: "+8809638000001",
      destination_type: "extension",
      destination_id: "1001",
    });
  });

  it("maps CDR sync query parameters and normalizes common response envelopes", async () => {
    const calls: string[] = [];
    const client = new LocalPbxClient({
      baseUrl: "https://pbx.example.test/api/v2",
      apiToken: "token-123",
      fetchFn: async (url) => {
        calls.push(String(url));
        return jsonResponse({
          status: "success",
          data: [{ call_id: "call-1", disposition: "ANSWERED", duration: 61 }],
        });
      },
    });

    const records = await client.getCdr({
      customerId: "cust-1",
      startDate: "2026-08-01",
      endDate: "2026-08-18",
      disposition: "ANSWERED",
    });

    expect(calls[0]).toBe(
      "https://pbx.example.test/api/v2/customers/cust-1/cdr?start_date=2026-08-01&end_date=2026-08-18&disposition=ANSWERED",
    );
    expect(records).toEqual([{ call_id: "call-1", disposition: "ANSWERED", duration: 61 }]);
  });
});
