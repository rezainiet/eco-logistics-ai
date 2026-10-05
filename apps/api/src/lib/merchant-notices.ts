import type { Types } from "mongoose";
import { dispatchNotification } from "./notifications.js";

/**
 * Merchant inbox notices for order and account events. Each goes through
 * the one notification store with a deterministic dedupe key, so a retried
 * webhook, a replayed job or a repeated request can never add a second
 * row. Best-effort: a failure here never affects the event itself.
 */

const SOURCE_LABEL: Record<string, string> = {
  landing_page: "landing page",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  custom_api: "your store",
};

function money(n: number | null | undefined, currency?: string | null): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${currency && currency !== "BDT" ? `${currency} ` : "৳"}${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * A customer placed an order — a landing-page checkout or a live store
 * webhook. Callers skip it for orders the merchant created or imported,
 * and when a review alert was already written for the same order (that
 * alert is the more useful notice). No customer name or phone in the text.
 */
export async function notifyNewOrder(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  total?: number | null;
  currency?: string | null;
  district?: string | null;
  source: string;
}): Promise<void> {
  try {
    const where = args.district ? ` · ${args.district}` : "";
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.new",
      severity: "info",
      title: `New order ${args.orderNumber}`,
      body: `${money(args.total, args.currency)}${where} · from ${SOURCE_LABEL[args.source] ?? "your store"}`,
      link: `/dashboard/orders?focus=${String(args.orderId)}`,
      subjectType: "order",
      subjectId: args.orderId,
      dedupeKey: `order_new:${String(args.orderId)}`,
      meta: { source: args.source },
    });
  } catch (err) {
    console.error("[merchant-notices] new order failed", (err as Error).message);
  }
}

/** The customer answered NO to the confirmation SMS; the order was cancelled for them. */
export async function notifyCustomerRejected(args: {
  merchantId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber?: string | null;
}): Promise<void> {
  try {
    const ref = args.orderNumber ?? String(args.orderId).slice(-6);
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "order.customer_rejected",
      severity: "warning",
      title: `Customer cancelled order ${ref}`,
      body: "The customer replied NO to the confirmation SMS, so the order was cancelled and its stock released. No courier was booked.",
      link: `/dashboard/orders?focus=${String(args.orderId)}`,
      subjectType: "order",
      subjectId: args.orderId,
      dedupeKey: `customer_rejected:${String(args.orderId)}`,
    });
  } catch (err) {
    console.error("[merchant-notices] customer rejected failed", (err as Error).message);
  }
}

/** Once per merchant account, when it is created (signup or Shopify install). */
export async function notifyWelcome(args: { merchantId: Types.ObjectId; businessName?: string | null }): Promise<void> {
  try {
    await dispatchNotification({
      merchantId: args.merchantId,
      kind: "account.welcome",
      severity: "info",
      title: `Welcome to ConfirmX${args.businessName ? `, ${args.businessName}` : ""}`,
      body: "Connect your store, add a courier, turn on automation and send a test SMS — the setup checklist walks you through each step.",
      link: "/dashboard/getting-started",
      subjectType: "merchant",
      subjectId: args.merchantId,
      dedupeKey: `welcome:${String(args.merchantId)}`,
    });
  } catch (err) {
    console.error("[merchant-notices] welcome failed", (err as Error).message);
  }
}
