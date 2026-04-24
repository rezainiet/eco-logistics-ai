import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";
const { Schema, model, models } = mongoose;

const PHONE_RE = /^\+?[0-9]{7,15}$/;

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
  },
  { _id: false }
);

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
    deliveredAt: { type: Date },
    returnedAt: { type: Date },
    lastPolledAt: { type: Date },
    pollErrorCount: { type: Number, default: 0 },
    pollError: { type: String, trim: true, maxlength: 500 },
    trackingEvents: { type: [trackingEventSchema], default: [] },
    rtoReason: { type: String, trim: true },
  },
  { _id: false }
);

export const FRAUD_LEVELS = ["low", "medium", "high"] as const;
export const REVIEW_STATUSES = [
  "not_required",
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
  },
  { _id: false }
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
    source: { type: sourceSchema, default: () => ({}) },
    calls: { type: [orderCallSchema], default: [] },
  },
  { timestamps: true }
);

orderSchema.index({ merchantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ merchantId: 1, createdAt: -1, "order.status": 1 });
orderSchema.index({ merchantId: 1, "customer.phone": 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, "fraud.riskScore": -1 });
orderSchema.index({ merchantId: 1, "fraud.reviewStatus": 1, createdAt: -1 });
orderSchema.index({ "logistics.trackingNumber": 1 }, { sparse: true });
orderSchema.index({ merchantId: 1, _id: -1 });
orderSchema.index({ merchantId: 1, "order.status": 1, _id: -1 });
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
// Sync worker: find active shipments that need polling, oldest first.
orderSchema.index(
  { "order.status": 1, "logistics.lastPolledAt": 1 },
  { partialFilterExpression: { "logistics.trackingNumber": { $exists: true, $ne: "" } } },
);

orderSchema.pre("save", function () {
  (this as unknown as { _wasNew?: boolean })._wasNew = this.isNew;
});

orderSchema.post("save", { document: true, query: false }, async function (doc) {
  const self = this as unknown as { _wasNew?: boolean };
  if (!self._wasNew) return;
  self._wasNew = false;
  const StatsModel = mongoose.model("MerchantStats");
  const status = doc.order?.status ?? "pending";
  await StatsModel.updateOne(
    { merchantId: doc.merchantId },
    { $inc: { totalOrders: 1, [status]: 1 }, $set: { updatedAt: new Date() } },
    { upsert: true }
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
  (models.Order as Model<Order>) || model<Order>("Order", orderSchema);
