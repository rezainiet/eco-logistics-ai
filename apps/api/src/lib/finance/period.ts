import { TRPCError } from "@trpc/server";

/**
 * Accounting periods are calendar days in Bangladesh (Asia/Dhaka, UTC+6,
 * no daylight saving). A period is an inclusive day range plus the matching
 * UTC instants [start, end) for querying timestamps such as deliveredAt.
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest custom range accepted (≈ 10 years). */
const MAX_RANGE_DAYS = 3700;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodInput =
  | { preset: "today" | "month" | "year" }
  | { preset: "custom"; from: string; to: string };

export interface Period {
  /** First day, inclusive ("YYYY-MM-DD", Dhaka). */
  fromDay: string;
  /** Last day, inclusive. */
  toDay: string;
  /** UTC instant of fromDay 00:00 Dhaka. */
  start: Date;
  /** UTC instant of the day AFTER toDay, 00:00 Dhaka (exclusive). */
  end: Date;
}

/** "YYYY-MM-DD" of `d` in Dhaka. */
export function dhakaDay(d: Date): string {
  return new Date(d.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of 00:00 Dhaka on `day`; throws on an invalid calendar day. */
export function dhakaMidnight(day: string): Date {
  if (!DAY_RE.test(day)) throw invalid(`invalid date "${day}"`);
  const utc = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== day) throw invalid(`invalid date "${day}"`);
  return new Date(utc.getTime() - DHAKA_OFFSET_MS);
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)); // month is 1-based here → day 0 of next month
  return d.toISOString().slice(0, 10);
}

export function resolvePeriod(input: PeriodInput, now: Date = new Date()): Period {
  const today = dhakaDay(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  let fromDay: string;
  let toDay: string;
  switch (input.preset) {
    case "today":
      fromDay = toDay = today;
      break;
    case "month":
      fromDay = `${today.slice(0, 7)}-01`;
      toDay = lastDayOfMonth(y, m);
      break;
    case "year":
      fromDay = `${y}-01-01`;
      toDay = `${y}-12-31`;
      break;
    case "custom": {
      const { from, to } = input as { from?: string; to?: string };
      if (!from || !to) throw invalid("custom period needs from and to");
      fromDay = from;
      toDay = to;
      break;
    }
    default:
      throw invalid("unknown period");
  }
  const start = dhakaMidnight(fromDay);
  const end = new Date(dhakaMidnight(toDay).getTime() + DAY_MS);
  if (end <= start) throw invalid("the end date is before the start date");
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) throw invalid("date range is too long");
  return { fromDay, toDay, start, end };
}

function invalid(message: string) {
  return new TRPCError({ code: "BAD_REQUEST", message });
}
