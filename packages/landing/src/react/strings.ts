import type { Locale } from "../locales.js";
import type { PaymentMethod } from "../vocab.js";

/**
 * The few words components print themselves (labels around merchant
 * content). Everything else on a page is merchant content from the editor.
 */
export interface UiStrings {
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  hours: string;
  hotline: string;
  contact: string;
  follow: string;
  links: string;
  area: string;
  time: string;
  charge: string;
  free: string;
  off: (pct: string) => string;
  stars: (n: number) => string;
  payment: Record<PaymentMethod, string>;
}

const en: UiStrings = {
  phone: "Phone",
  whatsapp: "WhatsApp",
  email: "Email",
  address: "Address",
  hours: "Opening hours",
  hotline: "Hotline",
  contact: "Contact",
  follow: "Follow us",
  links: "Links",
  area: "Area",
  time: "Delivery time",
  charge: "Charge",
  free: "Free",
  off: (pct) => `-${pct}`,
  stars: (n) => `${n} out of 5 stars`,
  payment: {
    cod: "Cash on Delivery",
    bkash: "bKash",
    nagad: "Nagad",
    rocket: "Rocket",
    upay: "Upay",
    card: "Card",
    bank: "Bank transfer",
  },
};

const bn: UiStrings = {
  phone: "ফোন",
  whatsapp: "হোয়াটসঅ্যাপ",
  email: "ইমেইল",
  address: "ঠিকানা",
  hours: "খোলার সময়",
  hotline: "হটলাইন",
  contact: "যোগাযোগ",
  follow: "আমাদের ফলো করুন",
  links: "লিংক",
  area: "এলাকা",
  time: "ডেলিভারি সময়",
  charge: "চার্জ",
  free: "ফ্রি",
  off: (pct) => `${pct} ছাড়`,
  stars: (n) => `৫-এর মধ্যে ${n} রেটিং`,
  payment: {
    cod: "ক্যাশ অন ডেলিভারি",
    bkash: "বিকাশ",
    nagad: "নগদ",
    rocket: "রকেট",
    upay: "উপায়",
    card: "কার্ড",
    bank: "ব্যাংক ট্রান্সফার",
  },
};

export function uiStrings(locale: Locale): UiStrings {
  return locale === "bn" ? bn : en;
}
