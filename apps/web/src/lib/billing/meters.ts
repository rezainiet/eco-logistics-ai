/**
 * One classification for usage meters, shared by every surface that turns a
 * meter into a warning (notification bell + drawer, subscription banner,
 * billing usage panel) so they can never disagree.
 *
 * `billing.getUsage` flags a meter `blocked` whenever `used >= limit`. For a
 * feature the plan doesn't include (`limit: 0`) that is already true at zero
 * usage — the merchant hasn't hit anything, the feature just isn't in their
 * plan. That is `not_included`, never an alert. Enforcement is server-side
 * and unaffected; this only decides what the UI claims.
 */
export interface UsageMeterLike {
  metric: string;
  used?: number | null;
  limit: number | null;
  ratio?: number;
  warning: boolean;
  blocked: boolean;
}

export type MeterState = "ok" | "warning" | "blocked" | "not_included";

export function classifyMeter(m: UsageMeterLike): MeterState {
  const used = m.used ?? 0;
  if (m.limit === null) return "ok";
  // Nothing used yet: a zero-limit meter is a feature outside the plan, and
  // any other "blocked"/"warning" flag at zero usage is stale init data.
  if (used <= 0) return m.limit === 0 ? "not_included" : "ok";
  if (m.blocked) return "blocked";
  if (m.warning) return "warning";
  return "ok";
}

/** True when the meter should raise a plan-limit alert (blocked or near the limit). */
export function isMeterAlert(m: UsageMeterLike): boolean {
  const s = classifyMeter(m);
  return s === "blocked" || s === "warning";
}
