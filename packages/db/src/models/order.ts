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

const logisticsSchema = new Schema(
  {
    courier: { type: String, trim: true },
    trackingNumber: { type: String, trim: true },
    estimatedDelivery: { type: Date },
    actualDelivery: { type: Date },
    rtoReason: { type: String, trim: true },
  },
  { _id: false }
);

const fraudSchema = new Schema(
  {
    detected: { type: Boolean, default: false },
    riskScore: { type: Number, min: 0, max: 100, default: 0 },
    reasons: { type: [String], default: [] },
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
    calls: { type: [orderCallSchema], default: [] },
  },
  { timestamps: true }
);

orderSchema.index({ merchantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ merchantId: 1, createdAt: -1, "order.status": 1 });
orderSchema.index({ merchantId: 1, "customer.phone": 1, createdAt: -1 });
orderSchema.index({ merchantId: 1, "fraud.riskScore": -1 });
orderSchema.index({ "logistics.trackingNumber": 1 }, { sparse: true });
orderSchema.index({ merchantId: 1, _id: -1 });
orderSchema.index({ merchantId: 1, "order.status": 1, _id: -1 });

orderSchema.pre("save", function () {
  if (!this.isNew && this.isModified("order.status")) {
    (this as unknown as { _prevStatus?: string })._prevStatus = this.get("order.status", null, {
      getters: false,
    }) as string;
  }
});

orderSchema.post("save", async function (doc) {
  const StatsModel = mongoose.model("MerchantStats");
  if ((doc as unknown as { wasNew?: boolean }).wasNew === false) return;
  // Only track inserts here; status transitions should be handled by the service layer
  // that performs the update, so increments stay accurate under concurrent writes.
  if (this.isNew || (doc as any).$isNew) {
    const status = doc.order?.status ?? "pending";
    await StatsModel.updateOne(
      { merchantId: doc.merchantId },
      { $inc: { totalOrders: 1, [status]: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  }
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
