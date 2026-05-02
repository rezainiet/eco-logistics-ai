import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSmsTransport,
  __setSmsTransport,
  sendOtpSms,
  sendOrderConfirmationSms,
  sendSms,
  type SmsSendInput,
  type SmsSendResult,
  type SmsTransport,
} from "../src/lib/sms/index.js";
import { normalizeBdPhone, SslWirelessTransport } from "../src/lib/sms/sslwireless.js";

class FakeTransport implements SmsTransport {
  public calls: SmsSendInput[] = [];
  public next: SmsSendResult = { ok: true, providerMessageId: "ref-1", providerStatus: "SUCCESS" };
  async send(input: SmsSendInput): Promise<SmsSendResult> {
    this.calls.push(input);
    return this.next;
  }
}

describe("normalizeBdPhone", () => {
  it("upgrades 11-digit BD-local (01XXXXXXXXX) to 13-digit international", () => {
    expect(normalizeBdPhone("01711111111")).toBe("8801711111111");
  });

  it("preserves 13-digit BD international form", () => {
    expect(normalizeBdPhone("8801711111111")).toBe("8801711111111");
  });

  it("strips formatting (+, spaces, dashes, parentheses)", () => {
    expect(normalizeBdPhone("+88 (017) 1111-1111")).toBe("8801711111111");
  });

  it("rejects inputs that are clearly not phones", () => {
    expect(normalizeBdPhone("abc")).toBeNull();
    expect(normalizeBdPhone("")).toBeNull();
    expect(normalizeBdPhone("123")).toBeNull();
  });

  it("passes through non-BD international numbers (digits only)", () => {
    // E.164 +14155552671 → strip + → 14155552671 (11 digits, not 01-prefixed)
    expect(normalizeBdPhone("+14155552671")).toBe("14155552671");
  });
});

describe("sendSms — dev/test fallback", () => {
  beforeEach(() => {
    __resetSmsTransport();
    delete process.env.SSL_WIRELESS_API_KEY;
    delete process.env.SSL_WIRELESS_USER;
    delete process.env.SSL_WIRELESS_SID;
  });

  afterEach(() => {
    __resetSmsTransport();
    vi.restoreAllMocks();
  });

  it("logs to stdout and reports ok=true when SSL Wireless keys are unset", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await sendSms("01711111111", "Hello world", { tag: "unit" });
    expect(r.ok).toBe(true);
    expect(r.providerStatus).toBe("dev_stdout");
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = String(spy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("8801711111111");
    expect(logged).toContain("Hello world");
    expect(logged).toContain("tag=unit");
  });

  it("rejects clearly-invalid phone numbers without burning a transport call", async () => {
    const fake = new FakeTransport();
    __setSmsTransport(fake);
    const r = await sendSms("garbage", "x", { tag: "unit" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("client_invalid_phone");
    expect(fake.calls).toHaveLength(0);
  });

  it("clamps overlong bodies to 160 chars and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeTransport();
    __setSmsTransport(fake);
    const long = "a".repeat(400);
    const r = await sendSms("01711111111", long, { tag: "long" });
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.body.length).toBeLessThanOrEqual(160);
    expect(warn).toHaveBeenCalled();
  });
});

describe("sendSms — when transport is configured", () => {
  beforeEach(() => __resetSmsTransport());
  afterEach(() => {
    __resetSmsTransport();
    vi.restoreAllMocks();
  });

  it("forwards normalized phone, tag, and csmsId to the transport", async () => {
    const fake = new FakeTransport();
    __setSmsTransport(fake);

    const r = await sendSms("+8801711111111", "Test body", {
      tag: "unit",
      csmsId: "abc-1",
    });

    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("ref-1");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      to: "8801711111111",
      body: "Test body",
      csmsId: "abc-1",
    });
  });

  it("propagates transport failure as ok=false", async () => {
    const fake = new FakeTransport();
    fake.next = { ok: false, error: "rate limited", providerStatus: "429" };
    __setSmsTransport(fake);
    const r = await sendSms("01711111111", "x", { tag: "unit" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate limited");
  });
});

describe("templated helpers", () => {
  beforeEach(() => __resetSmsTransport());
  afterEach(() => {
    __resetSmsTransport();
    vi.restoreAllMocks();
  });

  it("sendOtpSms includes the code, brand, and TTL hint", async () => {
    const fake = new FakeTransport();
    __setSmsTransport(fake);
    await sendOtpSms("01711111111", "123456", { brand: "Acme", ttlMinutes: 7 });
    const body = fake.calls[0]!.body;
    expect(body).toContain("Acme");
    expect(body).toContain("123456");
    expect(body).toContain("7 minutes");
  });

  it("sendOrderConfirmationSms includes order number and BD prompt", async () => {
    const fake = new FakeTransport();
    __setSmsTransport(fake);
    await sendOrderConfirmationSms("01711111111", {
      brand: "Acme",
      orderNumber: "ORD-42",
      codAmount: 1500,
      confirmationCode: "A1B2",
    });
    const body = fake.calls[0]!.body;
    expect(body).toContain("ORD-42");
    expect(body).toContain("1500");
    expect(body).toContain("YES");
  });
});

describe("SslWirelessTransport.send (mock fetch)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts JSON with api_token+sid+msisdn+sms+csms_id and parses SUCCESS", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "SUCCESS",
          smsinfo: [{ sms_status: "SUCCESS", reference_id: "ref-99", msisdn: "8801711111111" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const t = new SslWirelessTransport({
      apiToken: "T",
      user: "U",
      sid: "MYBRAND",
      baseUrl: "https://smsplus.sslwireless.com",
    });
    const r = await t.send({ to: "01711111111", body: "hi" });

    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe("ref-99");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://smsplus.sslwireless.com/api/v3/send-sms/dynamic");
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody).toMatchObject({
      api_token: "T",
      sid: "MYBRAND",
      msisdn: "8801711111111",
      sms: "hi",
    });
    expect(sentBody.csms_id).toMatch(/^auto-\d+$/);
    expect(sentBody.mask).toBe("MYBRAND");
  });

  it("returns ok=false on non-200 transport response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500 })),
    );
    const t = new SslWirelessTransport({
      apiToken: "T",
      user: "U",
      sid: "MYBRAND",
      baseUrl: "https://smsplus.sslwireless.com",
    });
    const r = await t.send({ to: "01711111111", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("500");
  });

  it("returns ok=false when network throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    );
    const t = new SslWirelessTransport({
      apiToken: "T",
      user: "U",
      sid: "MYBRAND",
      baseUrl: "https://smsplus.sslwireless.com",
    });
    const r = await t.send({ to: "01711111111", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("transport_error");
    expect(r.error).toContain("ETIMEDOUT");
  });
});
