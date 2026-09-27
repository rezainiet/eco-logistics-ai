/**
 * Dead-letter (PendingJob) triage — pure classification, no I/O.
 *
 * A PendingJob row is a job that could not be put on BullMQ. Whether it is
 * still worth running depends on the world NOW, not when it was written: a
 * courier booking for an order that has since been delivered, cancelled,
 * booked by hand or simply sat for days must never be replayed, and a
 * verification / reset email whose token has expired is useless. This module
 * decides that per row from facts the caller looked up; it never replays or
 * mutates anything (scripts/deadLetterTriage.ts is the read-only driver).
 */

export type TriageCategory =
  | "safe_candidate"
  | "stale"
  | "token_expired"
  | "already_booked"
  | "order_terminal"
  | "order_not_actionable"
  | "order_missing"
  | "automation_disabled"
  | "invalid"
  | "unsupported_queue";

export interface TriageRow {
  queueName: string;
  jobName: string;
  createdAt: Date;
  data: unknown;
}

export interface TriageOrderFacts {
  status: string;
  hasTrackingNumber: boolean;
  /** automation.state for SMS confirmation jobs. */
  automationState?: string | null;
}

export interface TriageFacts {
  now: Date;
  /** Undefined = not looked up (queue doesn't need it); null = not found. */
  order?: TriageOrderFacts | null;
  merchantAutoBookEnabled?: boolean | null;
  /** Max age before a job that acts on a live order is considered stale. */
  maxOrderJobAgeMs?: number;
}

export interface TriageResult {
  category: TriageCategory;
  reason: string;
}

/** Token lifetimes from server/auth.ts (EMAIL_VERIFY_TTL_MS / PASSWORD_RESET_TTL_MS). */
export const EMAIL_TOKEN_TTL_MS: Readonly<Record<string, number>> = {
  verify_email: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

export const DEFAULT_MAX_ORDER_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const GENERIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESCORE_MAX_AGE_MS = 60 * 60 * 1000;

const TERMINAL = new Set(["delivered", "cancelled", "rto"]);
const BOOKABLE = new Set(["pending", "confirmed", "packed"]);

function idOf(data: unknown, key: string): string | null {
  const v = (data as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && /^[a-f0-9]{24}$/i.test(v) ? v : null;
}

/** The order id a row acts on, when its queue is order-scoped. */
export function orderIdOf(row: Pick<TriageRow, "queueName" | "data">): string | null {
  if (row.queueName === "automation-book" || row.queueName === "automation-sms") {
    return idOf(row.data, "orderId");
  }
  return null;
}

export function merchantIdOf(row: Pick<TriageRow, "data">): string | null {
  return idOf(row.data, "merchantId");
}

export function classifyDeadLetter(row: TriageRow, facts: TriageFacts): TriageResult {
  const ageMs = facts.now.getTime() - new Date(row.createdAt).getTime();
  const maxOrderAge = facts.maxOrderJobAgeMs ?? DEFAULT_MAX_ORDER_JOB_AGE_MS;

  switch (row.queueName) {
    case "automation-book": {
      if (!orderIdOf(row) || !merchantIdOf(row)) return { category: "invalid", reason: "missing orderId/merchantId" };
      if (facts.order === null) return { category: "order_missing", reason: "order no longer exists" };
      if (!facts.order) return { category: "invalid", reason: "order facts not provided" };
      if (facts.order.hasTrackingNumber) return { category: "already_booked", reason: "order already has a tracking number" };
      if (TERMINAL.has(facts.order.status)) return { category: "order_terminal", reason: `order is ${facts.order.status}` };
      if (!BOOKABLE.has(facts.order.status)) return { category: "order_not_actionable", reason: `order is ${facts.order.status}` };
      if (facts.merchantAutoBookEnabled !== true) return { category: "automation_disabled", reason: "merchant auto-book is off" };
      if (ageMs > maxOrderAge) return { category: "stale", reason: `older than ${Math.round(maxOrderAge / 3_600_000)}h` };
      return { category: "safe_candidate", reason: "bookable order, no shipment yet" };
    }
    case "automation-sms": {
      if (!orderIdOf(row) || !merchantIdOf(row)) return { category: "invalid", reason: "missing orderId/merchantId" };
      if (facts.order === null) return { category: "order_missing", reason: "order no longer exists" };
      if (!facts.order) return { category: "invalid", reason: "order facts not provided" };
      if (TERMINAL.has(facts.order.status)) return { category: "order_terminal", reason: `order is ${facts.order.status}` };
      if (facts.order.status !== "pending") return { category: "order_not_actionable", reason: `order is ${facts.order.status}` };
      if (ageMs > maxOrderAge) return { category: "stale", reason: `older than ${Math.round(maxOrderAge / 3_600_000)}h` };
      return { category: "safe_candidate", reason: "order still awaiting confirmation" };
    }
    case "email": {
      const ttl = EMAIL_TOKEN_TTL_MS[row.jobName];
      if (ttl !== undefined) {
        return ageMs > ttl
          ? { category: "token_expired", reason: `${row.jobName} link expired (merchant can request a new one)` }
          : { category: "safe_candidate", reason: `${row.jobName} link still valid` };
      }
      return ageMs > GENERIC_MAX_AGE_MS
        ? { category: "stale", reason: "email older than 24h" }
        : { category: "safe_candidate", reason: "recent email" };
    }
    case "risk-recompute":
      return ageMs > RESCORE_MAX_AGE_MS
        ? { category: "stale", reason: "rescore older than 1h (later events re-trigger it)" }
        : { category: "safe_candidate", reason: "recent rescore" };
    case "commerce-import":
      return ageMs > GENERIC_MAX_AGE_MS
        ? { category: "stale", reason: "import request older than 24h" }
        : { category: "safe_candidate", reason: "recent import request" };
    default:
      return { category: "unsupported_queue", reason: `no triage rule for ${row.queueName}` };
  }
}
