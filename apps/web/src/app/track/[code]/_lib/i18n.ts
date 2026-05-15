/**
 * Tracking-page localisation.
 *
 * The confirmation SMS a Bangladeshi customer receives is bilingual
 * (EN + Bangla). Until now the tracking link they tapped from that SMS
 * landed on a fully English page — the language flips mid-journey and
 * the customer (and, by reflection, the merchant) looks worse for it
 * (audit 04 §7, 06 B6). Bangla is the default here because the audience
 * is BD COD shoppers; an English toggle stays one tap away.
 *
 * Pure data + a tiny resolver. No client JS — the switch is a plain
 * server-rendered link that re-renders with `?lang=`.
 */

export type Lang = "bn" | "en";

export function resolveLang(value: string | string[] | undefined): Lang {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "en" ? "en" : "bn";
}

type Strings = {
  orderDetails: string;
  orderId: string;
  trackingCode: string;
  cod: string;
  courier: string;
  deliveryAddress: string;
  estimatedDelivery: string;
  timeline: string;
  privacyNote: string;
  callMerchant: string;
  contactSupport: string;
  needHelp: string;
  switchToOther: string;
  notFoundTitle: string;
  notFoundBody: string;
  notFoundHint: string;
  backHome: string;
  steps: readonly [string, string, string, string, string];
};

export const STRINGS: Record<Lang, Strings> = {
  bn: {
    orderDetails: "অর্ডারের বিবরণ",
    orderId: "অর্ডার আইডি",
    trackingCode: "ট্র্যাকিং কোড",
    cod: "ক্যাশ অন ডেলিভারি",
    courier: "কুরিয়ার",
    deliveryAddress: "ডেলিভারি ঠিকানা",
    estimatedDelivery: "সম্ভাব্য ডেলিভারি",
    timeline: "টাইমলাইন",
    privacyNote:
      "এটি আপনার অর্ডারের অফিসিয়াল ট্র্যাকিং পেজ। আপনার গোপনীয়তার জন্য ঠিকানা আংশিক লুকানো — সম্পূর্ণ ঠিকানা শুধু বিক্রেতার কাছে আছে।",
    callMerchant: "📞 দোকানে কল করুন",
    contactSupport: "✉️ সাপোর্টে যোগাযোগ",
    needHelp: "সাহায্য দরকার?",
    switchToOther: "English",
    notFoundTitle: "অর্ডারটি খুঁজে পাওয়া যায়নি",
    notFoundBody: "এই ট্র্যাকিং কোডটি আমাদের সিস্টেমের কোনো অর্ডারের সাথে মিলছে না।",
    notFoundHint:
      "আপনার মেসেজের লিংকটি আবার দেখুন, অথবা বিক্রেতার সাথে যোগাযোগ করুন — তারা নতুন ট্র্যাকিং লিংক পাঠাতে পারবেন।",
    backHome: "হোমে ফিরুন",
    steps: ["প্রসেসিং", "প্যাকড", "শিপড", "ডেলিভারির পথে", "ডেলিভারড"],
  },
  en: {
    orderDetails: "Order details",
    orderId: "Order ID",
    trackingCode: "Tracking code",
    cod: "Cash on delivery",
    courier: "Courier",
    deliveryAddress: "Delivery address",
    estimatedDelivery: "Estimated delivery",
    timeline: "Timeline",
    privacyNote:
      "This is the official tracking page for your order. The address is masked for your privacy — only the merchant has the full delivery details.",
    callMerchant: "📞 Call merchant",
    contactSupport: "✉️ Contact support",
    needHelp: "Need help?",
    switchToOther: "বাংলা",
    notFoundTitle: "We couldn't find that order",
    notFoundBody: "doesn't match any order on our system.",
    notFoundHint:
      "Double-check the link from your message, or contact the merchant directly — they can re-send a working tracking link.",
    backHome: "Back to home",
    steps: ["Processing", "Packed", "Shipped", "Out for delivery", "Delivered"],
  },
};

/**
 * Bangla for each customer-facing status, keyed by the English `label`
 * that `statusPresentation` already returns (labels are unique, so this
 * needs no change to status.ts). `en` is a pass-through.
 */
const STATUS_BN: Record<string, { label: string; hint: string }> = {
  Processing: { label: "প্রসেসিং", hint: "আপনার অর্ডার প্রস্তুত করা হচ্ছে।" },
  Confirmed: {
    label: "নিশ্চিত",
    hint: "আপনার অর্ডার নিশ্চিত, প্যাকিং শুরু হয়েছে।",
  },
  Packed: {
    label: "প্যাকড",
    hint: "প্যাক করা হয়েছে, কুরিয়ার পিকআপের জন্য প্রস্তুত।",
  },
  Shipped: {
    label: "শিপড",
    hint: "কুরিয়ার পিকআপ করেছে, পথে আছে।",
  },
  "In transit": {
    label: "ট্রানজিটে",
    hint: "আপনার পার্সেল কুরিয়ার নেটওয়ার্কে চলছে।",
  },
  "Out for delivery": {
    label: "ডেলিভারির পথে",
    hint: "রাইডার আজ আপনার ঠিকানার দিকে আসছেন।",
  },
  Delivered: {
    label: "ডেলিভারড",
    hint: "ডেলিভার হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!",
  },
  Cancelled: { label: "বাতিল", hint: "এই অর্ডারটি বাতিল করা হয়েছে।" },
  Returned: {
    label: "ফেরত",
    hint: "পার্সেলটি প্রেরকের কাছে ফেরত গেছে।",
  },
  Unknown: { label: "অজানা", hint: "এখনও কোনো আপডেট পাওয়া যায়নি।" },
};

export function localizeStatus(
  lang: Lang,
  englishLabel: string,
  englishHint: string,
): { label: string; hint: string } {
  if (lang === "en") return { label: englishLabel, hint: englishHint };
  return STATUS_BN[englishLabel] ?? { label: englishLabel, hint: englishHint };
}
