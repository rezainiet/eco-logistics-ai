import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BehaviorLoadError, failedSections } from "./behavior-load-error";

describe("behavior analytics — a failed load is not rendered as zero (audit BA-1 UI)", () => {
  it("lists only the failed sections, in order", () => {
    expect(
      failedSections([
        { label: "Overview", isError: true },
        { label: "Funnel", isError: false },
        { label: "Top products", isError: true },
      ]),
    ).toEqual(["Overview", "Top products"]);
  });

  it("renders nothing when everything loaded", () => {
    expect(renderToStaticMarkup(<BehaviorLoadError failed={[]} onRetry={() => {}} />)).toBe("");
  });

  it("is an alert naming the failed sections, with a Retry", () => {
    const html = renderToStaticMarkup(<BehaviorLoadError failed={["Overview", "Funnel"]} onRetry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Overview, Funnel");
    expect(html).toContain("unavailable, not zero");
    expect(html).toContain("Retry");
  });

  it("the page shows — (not 0) for overview cards when their query failed", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../app/dashboard/analytics/behavior/page.tsx", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("<BehaviorLoadError failed={failed} onRetry={retryFailed} />");
    expect(src.match(/overview\.isError \? UNAVAILABLE/g)).toHaveLength(3);
    expect(src).toContain("repeat.isError ? UNAVAILABLE");
    expect(src).toMatch(/funnel\.isError \? \(\s*<EmptyState/);
  });
});
