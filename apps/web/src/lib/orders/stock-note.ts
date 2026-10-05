/**
 * Merchant copy for an order's inventory note — the API's
 * "<code>:<productId>" written when an order's stock could not be moved
 * (apps/api/src/lib/inventory.ts). The order itself is always kept.
 */

export interface StockNoteCopy {
  /** Badge text for lists. */
  label: string;
  /** What happened and what to do, for the order detail. */
  detail: string;
}

export function stockNoteCopy(note: string | null | undefined, status: string): StockNoteCopy | null {
  if (!note) return null;
  const code = note.split(":")[0];
  if (code === "product_not_found") {
    return {
      label: "Stock not moved",
      detail: "A product on this order is no longer in your catalogue, so its stock could not be moved.",
    };
  }
  if (status === "delivered") {
    return {
      label: "Stock not deducted",
      detail: "The delivered units could not be taken off stock (not enough units on hand). Check the product's stock count.",
    };
  }
  return {
    label: "Waiting for stock",
    detail: "Not enough stock to reserve this order. It was kept — restock the product and it is reserved automatically, or cancel the order.",
  };
}
