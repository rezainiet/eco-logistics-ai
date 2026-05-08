import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
import { PHONE_RE } from "./merchant.js";
const { Schema, model, models } = mongoose;

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "packed",
  "shipped",
  "in_transit",
  "delivered",
  "cancelled",
  "rto",
] as const;

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: {
      type: String,
      required: true,
      trim: true,
      validate: { validator: (v: string) => PHONE_RE.test(v), message: "Invalid phone number" },
    },
    address: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true, index: true },
    /**
     * Bangladesh thana / upazila. Optional, populated on a best-effort
     * basis at ingest by `lib/thana-lexicon.ts`'s `extractThana(address,
     * district)`. Undefined when the lexicon couldn't disambiguate
     * (multiple matches across districts, etc) — never guessed.
     *
     * Bangladesh courier delivery is coordinated at the thana level.
     * Read by the Address Intelligence layer + (medium-term) the
     * thana-aware courier-performance scoring path.
     */
    thana: { type: String, trim: true, maxlength: 100 },
  },
  { _id: false }
);

const itemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const orderDetailsSchema = new Schema(
  {
    cod: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ORDER_STATUSES, default: "pending", index: true },
    /**
     * Mirror of `automation.preRejectState` for the high-level order status.
     * Set when reject moves status to `cancelled`; consumed by `restoreOrder`
     * to put status back to its pre-reject value (typically `pending` or
     * `confirmed`).
     */
    preRejectStatus: { type: String, enum: ORDER_STATUSES },
  },
  { _id: false }
);

/**
 * Hard cap on `logistics.trackingEvents` length. Couriers can chatter
 * (Pathao alone emits 8–12 events per delivery, RedX more) so without a
 * slice ceiling the array grows linearly with delivery age and a single
 * order document drifts past 16 MB on long-lived shipments. Writers must
 * use `$push: { trackingEvents: { $each: [...], $slice: -MAX_TRACKING_EVENTS } }`
 * so old events fall off the front as new ones arrive — keeps the most
 * recent N visible to the merchant + tracking page without unbounded growth.
 */
export const MAX_TRACKING_EVENTS = 100;

export const TRACKING_STATUSES = [
  "pending",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "rto",
  "unknown",
] as const;

const trackingEventSchema = new Schema(
  {
    at: { type: Date, required: true },
    providerStatus: { type: String, trim: true, required: true },
    normalizedStatus: { type: String, enum: TRACKING_STATUSES, required: true },
    description: { type: String, trim: true, maxlength: 500 },
    location: { type: String, trim: true, maxlength: 200 },
    // Hash of (at + providerStatus) used to dedupe on repeated polls.
    dedupeKey: { type: String, required: true },
  },
  { _id: false }
);

const logisticsSchema = new Schema(
  {
    courier: { type: String, trim: true },
    trackingNumber: { type: String, trim: true },
    estimatedDelivery: { type: Date },
    actualDelivery: { type: Date },
    /** Stamped when bookSingleShipment succeeds — used to compute delivery hours. */
    shippedAt: { type: Date },
    deliveredAt: { type: Date },
    returnedAt: { type: Date },
    lastPolledAt: { type: Date },
    /** Last time a courier webhook hit this order. Used by the polling
     * worker to skip orders that were just refreshed via push, and by
     * tracking analytics to spot orders that have gone webhook-silent. */
    lastWebhookAt: { type: Date },
    pollErrorCount: { type: Number, default: 0 },
    pollError: { type: String, trim: true, maxlength: 500 },
    trackingEvents: { type: [trackingEventSchema], default: [] },
    rtoReason: { type: String, trim: true },
    /**
     * Exclusive booking lock. Acquired (set true) by an atomic
     * findOneAndUpdate guarded on `bookingInFlight !== true` BEFORE the
     * adapter.createAWB call. Released (set false) on both the success
     * and failure paths of bookSingleShipment. Stale locks (older than
     * the awbReconcile worker's threshold) are broken by the reconciler
     * after probing the upstream and resolving the pending-AWB ledger
     * row.
     */
    bookingInFlight: { type: Boolean, default: false },
    bookingLockedAt: { type: Date },
    /**
     * Monotonically increasing counter — each booking attempt increments
     * this and uses (orderId, attempt) as the idempotency key seed.
     * Deterministic per attempt so a process-crash retry produces the
     * SAME upstream key, letting the courier collapse the duplicate.
     */
    bookingAttempt: { type: Number, default: 0 },
  },
  { _id: false }
);

export const FRAUD_LEVELS = ["low", "medium", "high"] as const;
export const REVIEW_STATUSES = [
  "not_required",
  "optional_review",
  "pending_call",
  "verified",
  "rejected",
  "no_answer",
] as const;

const fraudSignalSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    weight: { type: Number, required: true, min: 0, max: 100 },
    detail: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const fraudSchema = new Schema(
  {
    detected: { type: Boolean, default: false },
    riskScore: { type: Number, min: 0, max: 100, default: 0 },
    level: { type: String, enum: FRAUD_LEVELS, default: "low" },
    reasons: { type: [String], default: [] },
    signals: { type: [fraudSignalSchema], default: [] },
    reviewStatus: {
      type: String,
      enum: REVIEW_STATUSES,
      default: "not_required",
      index: true,
    },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "Merchant" },
    reviewNotes: { type: String, trim: true, maxlength: 1000 },
    scoredAt: { type: Date },
    /** 0–100 inverse of riskScore — surfaced as the merchant trust badge. */
    confidence: { type: Number, min: 0, max: 100, default: 100 },
    confidenceLabel: {
      type: String,
      enum: ["Safe", "Verify", "Risky"],
      default: "Safe",
    },
    /** True when one or more hard-block rules pinned the order to HIGH. */
    hardBlocked: { type: Boolean, default: false },
    /** Most recent SMS-confirmation outcome — adjusts review state. */
    smsFeedback: {
      type: String,
      enum: ["confirmed", "rejected", "no_reply"],
    },
    smsFeedbackAt: { type: Date },
    /**
     * Snapshot of the fraud-side state at reject time. Mirrors the
     * automation.preReject* fields — without these, restoreOrder
     * cannot put a fraud-rejected order back in the review queue,
     * because the queue is query-based on `fraud.reviewStatus`.
     * Cleared on successful restore.
     *
     * Intentionally without `enum:` — Mongoose has a known quirk where
     * a dot-notation $set into an enum-constrained field on a `_id:
     * false` sub-schema gets silently stripped under strict mode, even
     * when the value is a valid enum entry. We rely on the writers
     * (rejectSnapshot helpers) to only emit valid REVIEW_STATUSES /
     * FRAUD_LEVELS values; the read-side cast handles the absent
     * field on legacy rows.
     */
    preRejectReviewStatus: { type: String },
    preRejectLevel: { type: String },
  },
  { _id: false }
);

const orderCallSchema = new Schema(
  {
    timestamp: { type: Date, required: true },
    duration: { type: Number, min: 0, default: 0 },
    answered: { type: Boolean, required: true },
    agentId: { type: Schema.Types.ObjectId },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Where the order originated from. Populated best-effort — `ip` is captured
 * from the tRPC request context (respecting `trust proxy`) and normalized to
 * a single address. `addressHash` is a stable fingerprint of the delivery
 * address used to detect reuse across unrelated phones.
 */
const sourceSchema = new Schema(
  {
    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 500 },
    addressHash: { type: String, trim: true, maxlength: 64, index: true },
    channel: {
      type: String,
      enum: ["dashboard", "bulk_upload", "api", "webhook", "system"],
      default: "dashboard",
    },
    /** Upstream id (Shopify/Woo/custom) used for ingestion idempotency. */
    externalId: { type: String, trim: true, maxlength: 200 },
    /**
     * Caller-supplied idempotency token for dashboard / API order creation.
     * Mirrors `externalId`'s role for non-webhook callers — a re-submitted
     * `createOrder` carrying the same `(merchantId, clientRequestId)` is
     * deduped by a sparse-unique index instead of producing a duplicate
     * order on a double-click.
     */
    clientRequestId: { type: String, trim: true, maxlength: 120 },
    /** Provider that delivered this order — null for dashboard-created. */
    sourceProvider: {
      type: String,
      enum: ["shopify", "woocommerce", "custom_api", "csv", "dashboard"],
    },
    integrationId: { type: Schema.Types.ObjectId, ref: "Integration" },
    customerEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
    placedAt: { type: Date },
  },
  { _id: false }
);


/**
 * Maximum number of couriers we will attempt for a single order. The
 * fallback chain enqueues retries with this cap so a stuck order can't
 * grow attemptedCouriers unbounded (and so the courier intelligence engine
 * runs out of candidates and escalates instead of looping forever).
 */
export const MAX_ATTEMPTED_COURIERS = 3;

export const AUTOMATION_STATES = [
  "not_evaluated",
  "auto_confirmed",
  "pending_confirmation",
  "confirmed",
  "rejected",
  "requires_review",
] as const;

const automationSchema = new Schema(
  {
    state: { type: String, enum: AUTOMATION_STATES, default: "not_evaluated", index: true },
    /** "system" = decided by automation engine; "merchant" / "agent" = human. */
    decidedBy: { type: String, enum: ["system", "merchant", "agent"], default: "system" },
    decidedAt: { type: Date },
    /** Free-form rationale (e.g. "low risk + full_auto"). Capped. */
    reason: { type: String, trim: true, maxlength: 200 },
    confirmedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
    /** True when the order was booked by automation rather than a manual click. */
    bookedByAutomation: { type: Boolean, default: false },
    /** 6-digit one-time code printed in outbound SMS so an inbound */
    /** "YES <code>" reply maps unambiguously to a single order. */
    confirmationCode: { type: String, trim: true, maxlength: 20, index: true },
    /** Last time we attempted to dispatch a customer-facing confirmation message. */
    confirmationSentAt: { type: Date },
    /** Channel used for the most recent confirmation outbound. */
    confirmationChannel: { type: String, enum: ["sms", "whatsapp", "manual"], default: undefined },
    /** SMS provider DLR — pending|delivered|failed|unknown. Default pending. */
    confirmationDeliveryStatus: {
      type: String,
      enum: ["pending", "delivered", "failed", "unknown"],
      default: "pending",
      index: true,
    },
    confirmationDeliveredAt: { type: Date },
    confirmationDeliveryFailedAt: { type: Date },
    /** Free-form provider reference (e.g. SSL Wireless ref_id) — for audit only. */
    confirmationDeliveryProviderRef: { type: String, trim: true, maxlength: 200 },
    /** Last error string surfaced by the provider when status=failed. */
    confirmationDeliveryError: { type: String, trim: true, maxlength: 500 },
    /** Courier picked by the intelligence engine (lowercased name). */
    selectedCourier: { type: String, trim: true, lowercase: true, maxlength: 60 },
    /** Free-form one-line reason ("success 92% / rto 4% over 80 orders"). */
    selectionReason: { type: String, trim: true, maxlength: 200 },
    /** Top-3 candidate breakdown for transparency / future tuning. */
    selectionBreakdown: { type: Schema.Types.Mixed },
    /** Couriers attempted in this order's lifecycle (used by fallback chain). */
    /** Hard-capped at MAX_ATTEMPTED_COURIERS so a buggy retry loop can't */
    /** balloon a single document into kilobytes of duplicate strings. */
    attemptedCouriers: {
      type: [String],
      default: [],
      validate: {
        validator: (arr: unknown) => Array.isArray(arr) && arr.length <= MAX_ATTEMPTED_COURIERS,
        message: `attemptedCouriers cannot exceed ${MAX_ATTEMPTED_COURIERS} entries`,
      },
    },
    /** Per-order pin set by the merchant via createOrder.pinnedCourier — */
    /** the auto-book worker honours it and skips the intelligence engine */
    /** for the FIRST attempt. Fallback chain still runs if it fails. */
    pinnedCourier: { type: String, trim: true, lowercase: true, maxlength: 60 },
    /**
     * State snapshot taken at the moment the order is rejected. `restoreOrder`
     * uses these to put the order back EXACTLY where it was, rather than
     * collapsing every restored order to `not_evaluated`/`pending`. Cleared
     * on successful restore so a second reject + restore round-trips
     * cleanly from the new "current" state.
     */
    preRejectState: { type: String, enum: AUTOMATION_STATES },
    /**
     * Stamped when the inbound SMS handler responds with a courtesy
     * "order expired" message after the customer replies past the
     * auto-reject window. Single field, single timestamp — used as a
     * once-per-order guard so a chatty customer doesn't trigger a
     * loop of expired-notice replies.
     */
    lateReplyAcknowledgedAt: { type: Date },
  },
  { _id: false },
);

export interface OrderAutomation {
  state?: (typeof AUTOMATION_STATES)[number];
  decidedBy?: "system" | "merchant" | "agent";
  decidedAt?: Date;
  reason?: string;
  confirmedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
  bookedByAutomation?: boolean;
  confirmationCode?: string;
  confirmationSentAt?: Date;
  confirmationChannel?: "sms" | "whatsapp" | "manual";
  confirmationDeliveryStatus?: "pending" | "delivered" | "failed" | "unknown";
  confirmationDeliveredAt?: Date;
  confirmationDeliveryFailedAt?: Date;
  confirmationDeliveryProviderRef?: string;
  confirmationDeliveryError?: string;
  selectedCourier?: string;
  selectionReason?: string;
  selectionBreakdown?: unknown;
  attemptedCouriers?: string[];
  pinnedCourier?: string;
  preRejectState?: (typeof AUTOMATION_STATES)[number];
  preRejectAutomation?: Record<string, unknown>;
  lateReplyAcknowledgedAt?: Date;
}

/* -------------------------------------------------------------------------- */
/* Intent Intelligence v1 — observation-only buyer-commitment subdoc.         */
/* Populated fire-and-forget by lib/intent.ts after identity-resolution       */
/* runs at ingest. NOT read by computeRisk; surfaced to the merchant + agent  */
/* UI for visibility. v1 is observation-only by design (Roadmap §STEP 3).     */
/* -------------------------------------------------------------------------- */

const intentSignalSchema = new Schema(
  {
    /**
     * One of the stable keys in `INTENT_SIGNAL_KEYS` (lib/intent.ts).
     * Intentionally NOT enum-constrained at the schema level — adding a new
     * signal key is a code-only change and we don't want a Mongoose strict-
     * mode rejection silently dropping a signal during a deploy lap.
     */
    key: { type: String, required: true, trim: true, maxlength: 60 },
    weight: { type: Number, required: true },
    detail: { type: String, required: true, trim: true, maxlength: 240 },
  },
  { _id: false },
);

export const INTENT_TIERS = ["verified", "implicit", "unverified", "no_data"] as const;
export type IntentTier = (typeof INTENT_TIERS)[number];

const intentSchema = new Schema(
  {
    score: { type: Number, min: 0, max: 100 },
    tier: { type: String, enum: INTENT_TIERS },
    signals: { type: [intentSignalSchema], default: [] },
    /** How many distinct TrackingSessions contributed (0 when no_data). */
    sessionsConsidered: { type: Number, min: 0, default: 0 },
    computedAt: { type: Date },
  },
  { _id: false },
);

/* -------------------------------------------------------------------------- */
/* Address Intelligence v1 — deliverability-quality subdoc. Populated         */
/* synchronously inline at ingest by lib/address-intelligence.ts. Pure-       */
/* function compute, no DB cost, no external calls.                           */
/* -------------------------------------------------------------------------- */

export const ADDRESS_COMPLETENESS = ["complete", "partial", "incomplete"] as const;
export const ADDRESS_SCRIPT_MIX = ["latin", "bangla", "mixed"] as const;
export const ADDRESS_HINT_CODES = [
  "no_anchor",
  "no_landmark",
  "no_number",
  "too_short",
  "too_few_tokens",
  "mixed_script",
] as const;

const addressQualitySchema = new Schema(
  {
    score: { type: Number, min: 0, max: 100 },
    completeness: { type: String, enum: ADDRESS_COMPLETENESS },
    landmarks: { type: [String], default: [] },
    hasNumber: { type: Boolean },
    tokenCount: { type: Number, min: 0 },
    scriptMix: { type: String, enum: ADDRESS_SCRIPT_MIX },
    /** Stable hint codes — UI maps to localized copy. */
    missingHints: { type: [String], default: [] },
    computedAt: { type: Date },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    quality: { type: addressQualitySchema, default: undefined },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    orderNumber: { type: String, required: true, trim: true },
    customer: { type: customerSchema, required: true },
    items: {
      type: [itemSchema],
      validate: { validator: (v: unknown[]) => v.length > 0, message: "Order must have at least one item" },
    },
    order: { type: orderDetailsSchema, required: true },
    logistics: { type: logisticsSchema, default: () => ({}) },
    fraud: { type: fraudSchema, default: () => ({}) },
    automation: { type: automationSchema, default: () => ({}) },
    /**
     * Full reversible-state snapshot taken at reject time. Holds the
     * complete pre-action picture so `restoreOrder` can put the order
     * back EXACTLY where it was — across order/automation/fraud — in
     * one atomic merge. Stored as a top-level Mixed field rather than
     * nested inside `automation.*` because Mongoose's strict-mode +
     * dot-notation $set has a quirk that silently strips `Mixed`
     * payloads on `_id: false` sub-schemas.
     *
     * Cleared on successful restore. Absent on legacy rows (rejected
     * before this PR), in which case restoreOrder falls back to the
     * older split fields (preRejectState / preRejectStatus).
     */
    preActionSnapshot: { type: Schema.Types.Mixed },
    source: { type: sourceSchema, default: () => ({}) },
    /**
     * Intent Intelligence v1. Stamped fire-and-forget post-identity-
     * resolution at ingest. Absent on legacy orders and on orders whose
     * SDK didn't capture a session (CSV / dashboard imports). Observation-
     * only — no automation / fraud paths read this in v1.
     */
    intent: { type: intentSchema, default: undefined },
    /**
     * Address Intelligence v1. Stamped synchronously at ingest by the pure
     * `computeAddressQuality(address, district)`. Absent on legacy orders.
     * Observation-only.
     */
    address: { type: addressSchema, default: undefined },
    calls: { type: [orderCallSchema], default: [] },
    /**
     * Application-level optimistic-concurrency counter. Incremented on
     * EVERY mutating findOneAndUpdate/updateOne that uses the
     * `updateOrderWithVersion` / `runWithOptimisticRetry` helpers
     * (apps/api/src/lib/orderConcurrency.ts).
     *
     * Why an explicit field instead of Mongoose's built-in `__v`:
     * `__v` is only checked by `doc.save()` — every Order mutation in
     * this codebase goes through `findOneAndUpdate` / `updateOne`, where
     * `__v` is silently ignored. An explicit field with a documented
     * read-modify-write contract closes the stale-overwrite class of
     * bugs the audit caught (booking lock vs fraud worker, restore vs
     * riskRecompute, etc).
     *
     * Convention: workers load the doc with `version`, build a CAS
     * filter `{ _id, version }`, and `$inc: { version: 1 }` on success.
     * A version mismatch returns null and the worker either retries
     * (read-modify-write loops) or exits cleanly (idempotent sweepers).
     */
    version: { type: Number, default: 0, required: true },
  },
  { timestamps: true }
);

orderSchema.index({ merchantId: 1, orderNumber: 1 }, { unique: true });
// Primary listing index — ESR rule (Equality, Sort, Range): merchantId is
// always equality, status is the high-selectivity equality filter, and
// createdAt:-1 lands the natural "newest first" sort + supports range
// queries (dateFrom/dateTo). Replaces the old (merchantId, createdAt,
// order.status) index whose prefix forced a date scan with status filtered
// in-memory once a merchant grew past ~50k orders/window.
orderSchema.index({ merchantId: 1, "order.status": 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, "customer.phone": 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, "fraud.riskScore": -1 });
orderSchema.index({ merchantId: 1, "fraud.reviewStatus": 1, createdAt: -1 });
// Fraud queue list — `fraud.list` filters by (merchantId, fraud.reviewStatus)
// and sorts by (fraud.riskScore desc, _id desc). Without this, a busy queue
// of pending_call orders falls back to in-memory sort once the page exceeds
// the previous index's `createdAt` ordering — bad as the queue grows past a
// few hundred items per merchant.
orderSchema.index({
  merchantId: 1,
  "fraud.reviewStatus": 1,
  "fraud.riskScore": -1,
  _id: -1,
});
orderSchema.index({ "logistics.trackingNumber": 1 }, { sparse: true });
orderSchema.index({ merchantId: 1, _id: -1 });
orderSchema.index({ merchantId: 1, "order.status": 1, _id: -1 });
// listOrders + listCouriers + per-courier analytics — slice the merchant's
// orders by courier with status as a secondary filter and recent-first
// pagination. Partial so non-booked orders don't bloat the index.
orderSchema.index(
  { merchantId: 1, "logistics.courier": 1, "order.status": 1, _id: -1 },
  {
    partialFilterExpression: {
      "logistics.courier": { $exists: true, $type: "string" },
    },
  },
);
// IP-velocity lookups: only care about recent orders with a captured IP.
orderSchema.index(
  { merchantId: 1, "source.ip": 1, createdAt: -1 },
  { partialFilterExpression: { "source.ip": { $exists: true, $type: "string" } } },
);
// Address-reuse lookups for the duplicate_address signal.
orderSchema.index(
  { merchantId: 1, "source.addressHash": 1, createdAt: -1 },
  { partialFilterExpression: { "source.addressHash": { $exists: true, $type: "string" } } },
);
// Webhook idempotency — duplicate inbound orders short-circuit here.
orderSchema.index(
  { merchantId: 1, "source.externalId": 1 },
  {
    unique: true,
    partialFilterExpression: { "source.externalId": { $exists: true, $type: "string" } },
  },
);
// Dashboard / API idempotency — same `clientRequestId` from the same
// merchant collapses on the unique key so a double-click never produces a
// second order. Sparse so legacy rows (and webhook-sourced orders) are
// unaffected.
orderSchema.index(
  { merchantId: 1, "source.clientRequestId": 1 },
  {
    unique: true,
    partialFilterExpression: { "source.clientRequestId": { $exists: true, $type: "string" } },
  },
);
// Address Intelligence — analytics cohort joins (completeness × outcome).
// Partial-filter so legacy orders without a quality stamp don't bloat the
// index, and so the planner is happy to use it on filtered scans.
orderSchema.index(
  { merchantId: 1, "address.quality.completeness": 1, createdAt: -1 },
  {
    partialFilterExpression: {
      "address.quality.completeness": { $type: "string" },
    },
  },
);
// Thana-aware lookups (medium-term courier-perf will key on this). Sparse
// partial — most orders won't have a thana populated until coverage grows.
orderSchema.index(
  { merchantId: 1, "customer.thana": 1, createdAt: -1 },
  {
    partialFilterExpression: {
      "customer.thana": { $type: "string" },
    },
  },
);
// Intent Intelligence — analytics cohort (tier × outcome). Partial keeps
// the index narrow until intent stamping is universal.
orderSchema.index(
  { merchantId: 1, "intent.tier": 1, createdAt: -1 },
  {
    partialFilterExpression: { "intent.tier": { $type: "string" } },
  },
);
// Sync worker: find active shipments that need polling, oldest first.
// `$type: "string"` covers the same intent as the previous `$exists + $ne ""`
// expression but stays inside Mongo's partial-filter grammar (which forbids
// `$ne`). String values are non-empty in practice — booking writes the AWB
// or doesn't write the field at all.
orderSchema.index(
  { "order.status": 1, "logistics.lastPolledAt": 1 },
  { partialFilterExpression: { "logistics.trackingNumber": { $type: "string" } } },
);

orderSchema.pre("save", function () {
  (this as unknown as { _wasNew?: boolean })._wasNew = this.isNew;
});

orderSchema.post("save", { document: true, query: false }, async function (doc) {
  const self = this as unknown as { _wasNew?: boolean; $session?: () => unknown };
  if (!self._wasNew) return;
  self._wasNew = false;
  const StatsModel = mongoose.model("MerchantStats");
  const status = doc.order?.status ?? "pending";
  // When the doc was saved inside a transaction (e.g. createOrder's exactly-
  // once tx), the stats $inc MUST run in the same session — otherwise it
  // commits independently and a downstream tx abort leaves stats double-
  // counted. `this.$session()` returns the active session or null; passing
  // null is harmless for unsessioned writes.
  const session =
    typeof self.$session === "function"
      ? (self.$session() as mongoose.ClientSession | null)
      : null;
  await StatsModel.updateOne(
    { merchantId: doc.merchantId },
    { $inc: { totalOrders: 1, [status]: 1 }, $set: { updatedAt: new Date() } },
    session ? { upsert: true, session } : { upsert: true }
  );
});

orderSchema.post("insertMany", async function (docs: any[]) {
  if (!Array.isArray(docs) || docs.length === 0) return;
  const StatsModel = mongoose.model("MerchantStats");
  const byMerchant = new Map<string, Record<string, number>>();
  for (const d of docs) {
    const mid = String(d.merchantId);
    const status = d.order?.status ?? "pending";
    const entry = byMerchant.get(mid) ?? { totalOrders: 0 };
    entry.totalOrders = (entry.totalOrders ?? 0) + 1;
    entry[status] = (entry[status] ?? 0) + 1;
    byMerchant.set(mid, entry);
  }
  await Promise.all(
    [...byMerchant.entries()].map(([mid, inc]) =>
      StatsModel.updateOne(
        { merchantId: new mongoose.Types.ObjectId(mid) },
        { $inc: inc, $set: { updatedAt: new Date() } },
        { upsert: true }
      )
    )
  );
});

export type Order = InferSchemaType<typeof orderSchema> & { _id: Types.ObjectId };

export const Order: Model<Order> =
  (models.Order as Model<Order>) || model<Order>("Order", orderSchema)