import { describe, expect, it } from "vitest";
import {
  classifyMerchantHealth,
  type MerchantHealthInput,
} from "../src/lib/merchant-health.js";

const base: MerchantHealthInput = {
  accountAgeDays: 10,
  ordersAllTime: 50,
  lastOrderAgeDays: 0,
  pending: 1,
  oldestPendingAgeHours: 2,
  confirmAttempts7d: 20,
  replyRate7dPct: 60,
  failedImports: 0,
};

describe("classifyMerchantHealth", () => {
  it("healthy baseline", () => {
    expect(classifyMerchantHealth(base).status).toBe("healthy");
  });

  it("onboarding_stuck takes top priority", () => {
    expect(
      classifyMerchantHealth({
        ...base,
        ordersAllTime: 0,
        accountAgeDays: 3,
        failedImports: 2, // would be sync_issues, but onboarding wins
      }).status,
    ).toBe("onboarding_stuck");
  });

  it("a brand-new (<2d) merchant with no orders is NOT flagged", () => {
    expect(
      classifyMerchantHealth({
        ...base,
        ordersAllTime: 0,
        accountAgeDays: 1,
      }).status,
    ).toBe("healthy");
  });

  it("sync_issues on failed imports", () => {
    expect(
      classifyMerchantHealth({ ...base, failedImports: 1 }).status,
    ).toBe("sync_issues");
  });

  it("queue_neglected when oldest pending >= 24h", () => {
    expect(
      classifyMerchantHealth({ ...base, oldestPendingAgeHours: 30 }).status,
    ).toBe("queue_neglected");
  });

  it("low_confirmation only with enough volume", () => {
    expect(
      classifyMerchantHealth({
        ...base,
        confirmAttempts7d: 10,
        replyRate7dPct: 5,
      }).status,
    ).toBe("low_confirmation");
    // too few attempts → not enough signal, stays healthy
    expect(
      classifyMerchantHealth({
        ...base,
        confirmAttempts7d: 3,
        replyRate7dPct: 0,
      }).status,
    ).toBe("healthy");
  });

  it("inactive when had orders but went quiet", () => {
    expect(
      classifyMerchantHealth({
        ...base,
        lastOrderAgeDays: 9,
      }).status,
    ).toBe("inactive");
  });
});
