/**
 * Classes of the floating cart button (landing-commerce.tsx).
 *
 * Without a mobile order bar this is exactly the original button. With one
 * (`mobileActionBar` section, shown below 768px), the button sits above the
 * bar on phones — 5rem + the device's bottom safe area clears the bar's
 * height (MobileActionBar in @ecom/landing) with room to spare — and returns
 * to its usual corner from 768px up, where the bar is hidden.
 */
const BASE =
  "fixed z-40 inline-flex min-h-14 items-center gap-2 rounded-full bg-[var(--lp-primary)] px-5 py-3 font-semibold text-[color:var(--lp-on-primary)] shadow-lg ring-1 ring-black/10";

export const CART_BUTTON_CLASS =
  "fixed bottom-4 right-4 z-40 inline-flex min-h-14 items-center gap-2 rounded-full bg-[var(--lp-primary)] px-5 py-3 font-semibold text-[color:var(--lp-on-primary)] shadow-lg ring-1 ring-black/10 sm:bottom-6 sm:right-6";

export const CART_BUTTON_CLASS_WITH_ACTION_BAR = `${BASE} bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] right-4 sm:right-6 md:bottom-6`;

export function cartButtonClass(actionBar: boolean): string {
  return actionBar ? CART_BUTTON_CLASS_WITH_ACTION_BAR : CART_BUTTON_CLASS;
}
