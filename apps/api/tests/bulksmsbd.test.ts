import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSmsBdTransport } from "../src/lib/sms/bulksmsbd.js";

const baseCfg = {
  apiKey: "uGBrgkxrN8WKnRZnnu7f",
  senderId: "8809617621489",
  baseUrl: "http://bulksmsbd.net",
};

function mockFetch(body: string, status = 200, contentType = "application/json") {
  const fakeFetch = vi.fn(
    async () =>
      new Response(body, { status, headers: { "content-type": contentType } }),
  );
  vi.stubGlobal("fetch", fakeFetch);
  return fakeFetch;
}

describe("BulkSmsBdTransport.send", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds the documented URL with api_key, senderid, number, message + percent-encodes Bangla", async () => {
    const fetchSpy = mockFetch(
      JSON.stringify({
        response_code: 202,
        message_id: 99887,
        success_message: "SMS Submitted Successfully",
        error_message: "",
      }),
    );
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({
      to: "+88 (017) 1111-1111",
      body: "নিশ্চিত করুন: YES 482917",
    });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe("bulksmsbd");
    expect(r.providerStatus).toBe("202");
    expect(r.providerMessageId).toBe("99887");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^http:\/\/bulksmsbd\.net\/api\/smsapi\?/);
    expect(url).toContain(`api_key=${baseCfg.apiKey}`);
    expect(url).toContain(`senderid=${baseCfg.senderId}`);
    // Phone normalized to 13-digit no-plus form
    expect(url).toContain("number=8801711111111");
    expect(url).toContain("type=text");
    // Bangla body MUST be percent-encoded — never raw bytes in the query string
    const params = new URL(url).searchParams;
    expect(params.get("message")).toBe("নিশ্চিত করুন: YES 482917");
    // Raw URL must not contain the literal Bangla characters
    expect(url.includes("নিশ্চিত")).toBe(false);
  });

  it("normalizes 11-digit BD local (01XXXXXXXXX) → 8801XXXXXXXXX", async () => {
    const fetchSpy = mockFetch(JSON.stringify({ response_code: 202 }));
    const t = new BulkSmsBdTransport(baseCfg);
    await t.send({ to: "01711111111", body: "x" });
    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("number=8801711111111");
  });

  it("treats response_code=202 as success (the documented submitted signal)", async () => {
    mockFetch(JSON.stringify({ response_code: 202, message_id: 42 }));
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "01711111111", body: "x" });
    expect(r.ok).toBe(true);
    expect(r.providerStatus).toBe("202");
    expect(r.providerMessageId).toBe("42");
  });

  it("treats plain-text 'SMS Submitted Successfully' as success", async () => {
    mockFetch("SMS Submitted Successfully", 200, "text/plain");
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "01711111111", body: "x" });
    expect(r.ok).toBe(true);
    expect(r.providerStatus).toBe("202");
  });

  it("returns ok=false for documented error response_code (e.g. 1001 Invalid Number)", async () => {
    mockFetch(
      JSON.stringify({
        response_code: 1001,
        error_message: "Invalid Number",
      }),
    );
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "01711111111", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("1001");
    expect(r.error).toContain("Invalid Number");
  });

  it("returns ok=false on non-2xx HTTP status", async () => {
    mockFetch("Server error", 500, "text/plain");
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "01711111111", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("500");
  });

  it("returns ok=false on network/transport error without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "01711111111", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("transport_error");
    expect(r.error).toContain("ETIMEDOUT");
  });

  it("rejects clearly-invalid phones before burning an HTTP call", async () => {
    const fetchSpy = mockFetch(JSON.stringify({ response_code: 202 }));
    const t = new BulkSmsBdTransport(baseCfg);
    const r = await t.send({ to: "garbage", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("client_invalid_phone");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors a per-call sender override", async () => {
    const fetchSpy = mockFetch(JSON.stringify({ response_code: 202 }));
    const t = new BulkSmsBdTransport(baseCfg);
    await t.send({ to: "01711111111", body: "x", sender: "OVERRIDE-SID" });
    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("senderid=OVERRIDE-SID");
  });

  it("trims trailing slash on baseUrl", async () => {
    const fetchSpy = mockFetch(JSON.stringify({ response_code: 202 }));
    const t = new BulkSmsBdTransport({ ...baseCfg, baseUrl: "http://bulksmsbd.net/" });
    await t.send({ to: "01711111111", body: "x" });
    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^http:\/\/bulksmsbd\.net\/api\/smsapi\?/);
    expect(url.includes("//api/")).toBe(false);
  });
});
