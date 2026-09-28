import { sanitizeAttribution, type Touch } from "@ecom/landing";
import { classifyTouch, type MarketingChannel } from "./channel.js";

export interface StoredTouch extends Omit<Touch, "at"> {
  at: Date;
  channel: MarketingChannel;
  paid: boolean;
}

export interface StoredAttribution {
  firstTouch: StoredTouch;
  lastTouch: StoredTouch;
}

function stored(t: Touch): StoredTouch {
  const { channel, paid } = classifyTouch(t);
  return { ...t, at: new Date(t.at), channel, paid };
}

/**
 * Attribution to persist on a new order, from the (untrusted) checkout
 * body: validated field by field (@ecom/landing sanitizeAttribution) and
 * classified on the server. Returns null — the order is still placed — when
 * nothing usable was sent. Never influences tenant, price or stock.
 */
export function orderAttribution(raw: unknown, now: Date = new Date()): StoredAttribution | null {
  const a = sanitizeAttribution(raw, now);
  if (!a?.firstTouch || !a.lastTouch) return null;
  return { firstTouch: stored(a.firstTouch), lastTouch: stored(a.lastTouch) };
}
