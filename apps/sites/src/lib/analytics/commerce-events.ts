/**
 * Commerce → analytics bridge. The cart/checkout UI never talks to a
 * pixel: it announces what really happened as a DOM event, and the
 * analytics layer (mounted only on published pages with a Pixel) decides
 * what to send. No personal data is ever put on these events.
 */
export const COMMERCE_EVENT = "confirmx:commerce";

export interface CommerceLine {
  id: string;
  quantity: number;
  price: number;
}

export type CommerceEvent =
  | { type: "add_to_cart"; line: CommerceLine; name: string; currency: string }
  | { type: "initiate_checkout"; lines: CommerceLine[]; value: number; currency: string }
  /** A real order the server accepted (cash on delivery — placed, not paid). `orderRef` = public order number. */
  | { type: "purchase"; orderRef: string; lines: CommerceLine[]; value: number; currency: string };

export function emitCommerceEvent(event: CommerceEvent): void {
  try {
    window.dispatchEvent(new CustomEvent<CommerceEvent>(COMMERCE_EVENT, { detail: event }));
  } catch {
    // Analytics must never break checkout.
  }
}
