import mongoose, { type InferSchemaType, type Model, type Types } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * Manual merchant accounting entries: expenses (ads, rent, salary, …) and
 * income that does NOT come from ConfirmX orders.
 *
 * Realized sales revenue is never stored here — it is computed from
 * delivered orders, so it cannot be double-counted. Order-level product
 * cost (items[].unitCost) and courier fees (logistics.courierFee) are read
 * from the orders too; the `product_cost` / `courier` categories are for
 * costs that were not recorded on an order.
 *
 * Entries are never deleted: `status: "void"` keeps the row and its audit
 * trail while removing it from every total.
 */

export const FINANCE_ENTRY_TYPES = ["income", "expense"] as const;
export type FinanceEntryType = (typeof FINANCE_ENTRY_TYPES)[number];

export const FINANCE_ENTRY_STATUSES = ["active", "void"] as const;
export type FinanceEntryStatus = (typeof FINANCE_ENTRY_STATUSES)[number];

/** Report bucket each category rolls up into on the accounting overview. */
export type FinanceBucket =
  | "other_income"
  | "product_cost"
  | "courier"
  | "advertising"
  | "office"
  | "salary"
  | "other_expense";

export interface FinanceCategory {
  key: string;
  type: FinanceEntryType;
  label: string;
  bucket: FinanceBucket;
}

/**
 * The category catalogue. Stored on entries as a plain string (no schema
 * enum), so adding a category is a code change only — no migration.
 * Keys must never be renamed once used; retire a category by removing it
 * from this list (existing entries keep it and report under `other_*`).
 */
export const FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  { key: "sales_other", type: "income", label: "Sales (not from ConfirmX orders)", bucket: "other_income" },
  { key: "other_income", type: "income", label: "Other income", bucket: "other_income" },
  { key: "product_cost", type: "expense", label: "Product cost", bucket: "product_cost" },
  { key: "courier", type: "expense", label: "Courier", bucket: "courier" },
  { key: "ads_meta", type: "expense", label: "Meta / Facebook ads", bucket: "advertising" },
  { key: "ads_google", type: "expense", label: "Google ads", bucket: "advertising" },
  { key: "ads_tiktok", type: "expense", label: "TikTok ads", bucket: "advertising" },
  { key: "office_rent", type: "expense", label: "Office rent", bucket: "office" },
  { key: "salary", type: "expense", label: "Salary", bucket: "salary" },
  { key: "other", type: "expense", label: "Other", bucket: "other_expense" },
];

export function financeCategory(key: string): FinanceCategory | undefined {
  return FINANCE_CATEGORIES.find((c) => c.key === key);
}

/** Accounting is BDT-only for now; the field keeps the model open for more. */
export const FINANCE_CURRENCIES = ["BDT"] as const;

const financeEntrySchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    type: { type: String, enum: FINANCE_ENTRY_TYPES, required: true },
    category: { type: String, required: true, trim: true, maxlength: 40 },
    /** Positive amount in `currency` (2 decimals max). */
    amount: { type: Number, required: true, min: 0.01, max: 1_000_000_000 },
    currency: { type: String, enum: FINANCE_CURRENCIES, default: "BDT", required: true },
    /** Calendar day the income/expense belongs to (Asia/Dhaka), "YYYY-MM-DD". */
    occurredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    /** Merchant's own reference (invoice no., bill no., …). */
    reference: { type: String, trim: true, maxlength: 120, default: "" },
    /** Where the entry came from. "manual" today; imports (ads spend) later. */
    source: {
      kind: { type: String, enum: ["manual", "import"], default: "manual", required: true },
      refId: { type: String, trim: true, maxlength: 120 },
    },
    status: { type: String, enum: FINANCE_ENTRY_STATUSES, default: "active", required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    updatedBy: { type: Schema.Types.ObjectId },
    voidedAt: { type: Date },
    voidedBy: { type: Schema.Types.ObjectId },
    voidReason: { type: String, trim: true, maxlength: 300 },
    /** Client-generated per submission; a retried/double-clicked save returns the first entry. */
    idempotencyKey: { type: String, trim: true, maxlength: 80 },
  },
  { timestamps: true, collection: "finance_entries" },
);

// Period totals / lists: active entries of a merchant by day.
financeEntrySchema.index({ merchantId: 1, status: 1, occurredOn: -1 });
financeEntrySchema.index(
  { merchantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "finance_entry_idempotency" },
);

export type FinanceEntry = InferSchemaType<typeof financeEntrySchema> & { _id: Types.ObjectId };
export const FinanceEntry: Model<FinanceEntry> =
  (models.FinanceEntry as Model<FinanceEntry>) || model<FinanceEntry>("FinanceEntry", financeEntrySchema);
