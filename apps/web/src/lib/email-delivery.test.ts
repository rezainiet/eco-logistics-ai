import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMAIL_UNAVAILABLE_COPY,
  emailDeliveryFromBody,
  parseEmailDelivery,
  verifyPromptState,
} from "./email-delivery";

const base = { loaded: true, emailVerified: false, dismissed: false, delivery: "available" as const, resent: false };

describe("parseEmailDelivery / emailDeliveryFromBody", () => {
  it("only an explicit 'unavailable' is unavailable", () => {
    expect(parseEmailDelivery("unavailable")).toBe("unavailable");
    expect(parseEmailDelivery("available")).toBe("available");
    expect(parseEmailDelivery(undefined)).toBe("available");
  });
  it("reads the auth endpoint body; older APIs without the field stay 'available'", () => {
    expect(emailDeliveryFromBody({ ok: true, delivery: "unavailable" })).toBe("unavailable");
    expect(emailDeliveryFromBody({ ok: true, delivery: "available" })).toBe("available");
    expect(emailDeliveryFromBody({ ok: true })).toBe("available");
    expect(emailDeliveryFromBody(null)).toBe("available");
  });
});

describe("verifyPromptState", () => {
  it("regression: with no email provider it never offers resend or claims 'sent'", () => {
    expect(verifyPromptState({ ...base, delivery: "unavailable" })).toBe("unavailable");
    expect(verifyPromptState({ ...base, delivery: "unavailable", resent: true })).toBe("unavailable");
  });
  it("normal flow: prompt, then sent", () => {
    expect(verifyPromptState(base)).toBe("prompt");
    expect(verifyPromptState({ ...base, resent: true })).toBe("sent");
  });
  it("hidden when verified, dismissed or not loaded", () => {
    expect(verifyPromptState({ ...base, emailVerified: true, delivery: "unavailable" })).toBe("hidden");
    expect(verifyPromptState({ ...base, dismissed: true })).toBe("hidden");
    expect(verifyPromptState({ ...base, loaded: false })).toBe("hidden");
  });
  it("unavailable copy never tells the merchant to check their inbox", () => {
    for (const text of Object.values(EMAIL_UNAVAILABLE_COPY)) {
      expect(text).not.toMatch(/check your inbox|we sent|email(ed)? you/i);
    }
  });
});

describe("every email-sending UI honours the delivery signal (source)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it.each([
    ["../components/billing/verify-email-banner.tsx", "verifyPromptState"],
    ["../components/onboarding/dashboard-hero.tsx", "verifyPromptState"],
    ["../app/forgot-password/page.tsx", "emailDeliveryFromBody"],
    ["../app/verify-email-sent/page.tsx", "emailDeliveryFromBody"],
    ["../app/dashboard/settings/_sections/security-section.tsx", "emailDeliveryFromBody"],
  ])("%s uses %s", (file, fn) => {
    expect(read(file)).toContain(fn);
  });

  it("no other web code calls the auth email endpoints without honouring the signal", () => {
    // Guards against a new resend/reset call site that would claim "sent" again.
    const guarded = new Set([
      "components/billing/verify-email-banner.tsx",
      "components/onboarding/dashboard-hero.tsx",
      "app/forgot-password/page.tsx",
      "app/verify-email-sent/page.tsx",
      "app/dashboard/settings/_sections/security-section.tsx",
    ]);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
      });
    const callers = walk(root)
      .filter((p) => /auth\/(resend-verification|request-reset)/.test(readFileSync(p, "utf8")) && !p.endsWith("email-delivery.ts"))
      .map((p) => relative(root, p).replace(/\\/g, "/"));
    for (const c of callers) expect(guarded.has(c), `${c} calls an auth email endpoint`).toBe(true);
    expect(callers.length).toBe(guarded.size);
  });
});
