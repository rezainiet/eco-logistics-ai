import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Production behaviour of the email / SMS senders when their provider is
 * not configured: fail visibly, never report success, and never write the
 * message body (verification / reset links) or a full phone number to logs.
 */
vi.mock("../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env.js")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      NODE_ENV: "production",
      RESEND_API_KEY: undefined,
      SSL_WIRELESS_API_KEY: undefined,
      SSL_WIRELESS_USER: undefined,
      SSL_WIRELESS_SID: undefined,
    },
  };
});

function captureConsole() {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => vi.restoreAllMocks());

describe("email without RESEND_API_KEY in production", () => {
  const secretLink = "https://app.confirmx.ai/reset-password?token=SECRET-TOKEN-123";
  const msg = {
    to: "merchant@example.com",
    subject: "Reset your password",
    html: `<p>Click <a href="${secretLink}">here</a></p>`,
    text: `Reset: ${secretLink}`,
    tag: "password_reset",
  };

  it("returns a failure, not a skipped success, and logs no body or link", async () => {
    const { sendEmail, EMAIL_NOT_CONFIGURED } = await import("../src/lib/email.js");
    const cap = captureConsole();
    const r = await sendEmail(msg);
    cap.restore();
    expect(r).toEqual({ ok: false, error: EMAIL_NOT_CONFIGURED });
    const logged = cap.lines.join("\n");
    expect(logged).toContain("email.not_configured");
    expect(logged).not.toContain("SECRET-TOKEN-123");
    expect(logged).not.toContain("reset-password");
    expect(logged).not.toContain("merchant@example.com");
  });

  it("the worker fails the job without retrying", async () => {
    const { UnrecoverableError } = await import("bullmq");
    const { __TEST } = await import("../src/workers/email.worker.js");
    const cap = captureConsole();
    const err = await __TEST.processEmailJob({ correlationId: "reset:x:y", ...msg }).catch((e: unknown) => e);
    cap.restore();
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(cap.lines.join("\n")).not.toContain("SECRET-TOKEN-123");
  });
});

describe("SMS without a provider in production", () => {
  it("fails and never logs the full phone number or the body", async () => {
    const { sendSms, __setSmsTransport } = await import("../src/lib/sms/index.js");
    __setSmsTransport(null);
    const cap = captureConsole();
    const r = await sendSms("01711223344", "Your code is 482913", { tag: "otp" });
    const bad = await sendSms("12", "x", { tag: "otp" });
    cap.restore();
    expect(r.ok).toBe(false);
    expect(r.providerStatus).toBe("no_provider");
    const logged = cap.lines.join("\n");
    expect(logged).not.toContain("1711223344");
    expect(logged).not.toContain("482913");
    expect(logged).toContain("***3344");
    expect(bad.error).not.toContain("12 ");
    expect(bad.error).toBe("invalid phone: ***");
  });
});
