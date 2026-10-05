import type { TemplateSpec, TemplateSpecSection } from "./spec.js";
import type { SystemTemplateDef } from "./templates.js";

/**
 * Bangladesh e-commerce landing templates. Bangla-first (default locale
 * bn) with complete English copy. In the two shop templates the sample
 * products, prices and payment methods are displayed content and the order
 * section leads to the merchant's order channel (WhatsApp by default). BD
 * Single Product is built around the page's linked product and its checkout.
 */

type Bi = { en: unknown; bn: unknown };
const bi = (en: unknown, bn: unknown): Bi => ({ en, bn });

interface SectionPlan {
  id: string;
  type: string;
  /** Section type version; 1 unless stated (e.g. theme@2 for scroll animation). */
  version?: number;
  label?: string;
  /** Locked (not merchant-editable) values. */
  locked?: Record<string, unknown>;
  /** Fields a page cannot be published without. */
  required?: string[];
  /** Editable defaults: plain value (both locales) or bi(en, bn). */
  fields?: Record<string, unknown>;
}

function isBi(v: unknown): v is Bi {
  return typeof v === "object" && v !== null && "en" in v && "bn" in v && Object.keys(v).length === 2;
}

/** Build a spec whose English copy lives in field defaults and Bangla in localeDefaults.bn. */
function build(plans: SectionPlan[]): TemplateSpec {
  const sections: TemplateSpecSection[] = [];
  const bn: Record<string, Record<string, unknown>> = {};
  for (const plan of plans) {
    const fields: NonNullable<TemplateSpecSection["fields"]> = {};
    for (const [key, value] of Object.entries(plan.locked ?? {})) fields[key] = { editable: false, default: value };
    for (const [key, value] of Object.entries(plan.fields ?? {})) {
      if (isBi(value)) {
        fields[key] = { default: value.en };
        (bn[plan.id] ??= {})[key] = value.bn;
      } else {
        fields[key] = { default: value };
      }
    }
    for (const key of plan.required ?? []) fields[key] = { ...(fields[key] ?? {}), required: true };
    sections.push({
      id: plan.id,
      type: plan.type,
      typeVersion: plan.version ?? 1,
      ...(plan.label ? { label: plan.label } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    });
  }
  return { specVersion: 1, locales: ["bn", "en"], defaultLocale: "bn", localeDefaults: { bn }, sections };
}

const toSection = (label: string, sectionId: string) => ({ label, action: { kind: "section", sectionId } });
const noAction = (label: string) => ({ label, action: { kind: "none" } });
const biCta = (en: string, bnLabel: string, sectionId?: string) =>
  bi(sectionId ? toSection(en, sectionId) : noAction(en), sectionId ? toSection(bnLabel, sectionId) : noAction(bnLabel));

function product(
  en: string,
  bnName: string,
  price: number,
  oldPrice: number | null,
  badge: [string, string] | null,
  rating: string,
  ctaTo = "order",
) {
  const base = { image: null, price, oldPrice, rating };
  return {
    en: { ...base, name: en, badge: badge?.[0] ?? "", cta: toSection("Add to cart", ctaTo) },
    bn: { ...base, name: bnName, badge: badge?.[1] ?? "", cta: toSection("কার্টে যোগ করুন", ctaTo) },
  };
}

function productList(items: ReturnType<typeof product>[]): Bi {
  return bi(
    items.map((i) => i.en),
    items.map((i) => i.bn),
  );
}

const review = (enQuote: string, bnQuote: string, enName: string, bnName: string, enRole: string, bnRole: string, rating: string) => ({
  en: { quote: enQuote, name: enName, role: enRole, avatar: null, rating },
  bn: { quote: bnQuote, name: bnName, role: bnRole, avatar: null, rating },
});

// ─── BD Modern Shop ─────────────────────────────────────────────────────────

const modernShop: SystemTemplateDef = {
  key: "bd-modern-shop",
  name: "BD Modern Shop",
  description:
    "A bright, busy Bangladeshi online-shop page: offer bar, category circles, flash sale, product grid with taka prices and discounts, delivery charges and COD.",
  category: "ecommerce",
  spec: build([
    {
      id: "theme",
      type: "theme",
      fields: {
        primary: "#ea580c",
        onPrimary: "#ffffff",
        accent: "#facc15",
        background: "#ffffff",
        surface: "#fff7ed",
        text: "#1c1917",
        muted: "#57534e",
        font: "bengali",
        radius: "soft",
        numerals: "auto",
      },
    },
    {
      id: "seo",
      type: "seo",
      fields: {
        title: bi("Online shopping in Bangladesh | Bazar Mart", "বাংলাদেশে অনলাইন শপিং | বাজার মার্ট"),
        description: bi(
          "Great products, fast delivery and easy cash-on-delivery ordering.",
          "সেরা পণ্য, দ্রুত ডেলিভারি এবং সহজ অর্ডার সুবিধা।",
        ),
      },
    },
    {
      id: "topbar",
      type: "announcement",
      locked: { style: "dark" },
      fields: {
        icon: "truck",
        text: bi("Cash on delivery all over Bangladesh · Delivery in 1–3 days", "সারা বাংলাদেশে ক্যাশ অন ডেলিভারি · ১–৩ দিনে ডেলিভারি"),
      },
    },
    {
      id: "header",
      type: "shopHeader",
      locked: { style: "bold" },
      fields: {
        brandName: bi("Bazar Mart", "বাজার মার্ট"),
        links: bi(
          [
            { label: "Categories", url: "#categories" },
            { label: "Offers", url: "#offer" },
            { label: "Products", url: "#products" },
            { label: "Delivery", url: "#delivery" },
          ],
          [
            { label: "ক্যাটাগরি", url: "#categories" },
            { label: "অফার", url: "#offer" },
            { label: "পণ্য", url: "#products" },
            { label: "ডেলিভারি", url: "#delivery" },
          ],
        ),
        cta: biCta("Order now", "অর্ডার করুন", "order"),
      },
    },
    {
      id: "hero",
      type: "promoHero",
      locked: { layout: "split" },
      fields: {
        badge: bi("Up to 50% off", "৫০% পর্যন্ত ছাড়"),
        headline: bi("Your favourite products, now in your hands", "আপনার পছন্দের পণ্য এখন হাতের মুঠোয়"),
        subheadline: bi(
          "Fast delivery anywhere in Bangladesh, with cash on delivery.",
          "বাংলাদেশের যেকোনো প্রান্তে দ্রুত ডেলিভারি এবং ক্যাশ অন ডেলিভারি সুবিধা।",
        ),
        primaryCta: biCta("Shop now", "এখনই কিনুন", "products"),
        secondaryCta: biCta("Today's offer", "আজকের অফার", "offer"),
        note: bi("Pay when you receive · Easy 7-day returns", "পণ্য হাতে পেয়ে টাকা দিন · ৭ দিনে সহজ রিটার্ন"),
      },
    },
    {
      id: "categories",
      type: "categoryGrid",
      locked: { style: "circles" },
      fields: {
        heading: bi("Shop by category", "ক্যাটাগরি অনুযায়ী কিনুন"),
        items: bi(
          ["Clothing", "Shoes", "Cosmetics", "Electronics", "Home & living", "Kids"].map((name) => ({ name, image: null, link: "#products" })),
          ["পোশাক", "জুতা", "কসমেটিকস", "ইলেকট্রনিক্স", "ঘর ও সাজসজ্জা", "শিশুদের পণ্য"].map((name) => ({ name, image: null, link: "#products" })),
        ),
      },
    },
    {
      id: "offer",
      type: "offerBanner",
      locked: { style: "bold" },
      fields: {
        badge: bi("Flash sale", "ফ্ল্যাশ সেল"),
        heading: bi("Premium Cotton Shirt", "প্রিমিয়াম কটন শার্ট"),
        text: bi(
          "100% breathable cotton — comfortable in Bangladesh's heat and humidity.",
          "১০০% কটন — বাংলাদেশের গরম ও আর্দ্র আবহাওয়াতেও আরামদায়ক।",
        ),
        deadline: bi("Offer valid while stock lasts", "স্টক থাকা পর্যন্ত অফার চলবে"),
        price: 1290,
        oldPrice: 1650,
        cta: biCta("Order now", "এখনই অর্ডার করুন", "order"),
      },
    },
    {
      id: "products",
      type: "productGrid",
      locked: { style: "cards" },
      fields: {
        heading: bi("Popular products", "জনপ্রিয় পণ্য"),
        intro: bi("Hand-picked favourites our customers order again and again.", "কাস্টমাররা বারবার অর্ডার করেন এমন বাছাই করা পণ্য।"),
        columns: "4",
        items: productList([
          product("Premium Cotton Shirt", "প্রিমিয়াম কটন শার্ট", 1290, 1650, ["Hot", "হট"], "5"),
          product("Leather Sneakers", "লেদার স্নিকার্স", 2450, 2990, ["New", "নতুন"], "4"),
          product("Herbal Face Wash", "হারবাল ফেস ওয়াশ", 350, null, null, "5"),
          product("Wireless Earbuds", "ওয়্যারলেস ইয়ারবাডস", 1890, 2400, null, "4"),
          product("Cotton Saree", "সুতি শাড়ি", 2200, 2800, ["Popular", "জনপ্রিয়"], "5"),
          product("Kids' T-shirt", "শিশুদের টি-শার্ট", 450, 550, null, "0"),
          product("Kitchen Knife Set", "কিচেন নাইফ সেট", 990, 1290, null, "4"),
          product("Smart Watch", "স্মার্ট ওয়াচ", 3290, 3990, ["New", "নতুন"], "4"),
        ]),
        viewAll: bi(noAction("View all products"), noAction("সব পণ্য দেখুন")),
      },
    },
    {
      id: "why",
      type: "trustFeatures",
      locked: { style: "strip" },
      fields: {
        heading: bi("Why shop with us", "কেন আমাদের থেকে কিনবেন"),
        items: bi(
          [
            { icon: "cash", title: "Cash on delivery", text: "Pay when it arrives" },
            { icon: "truck", title: "Fast delivery", text: "1–3 days nationwide" },
            { icon: "return", title: "Easy returns", text: "7-day return policy" },
            { icon: "lock", title: "Safe payment", text: "Cash, bKash or Nagad" },
          ],
          [
            { icon: "cash", title: "ক্যাশ অন ডেলিভারি", text: "পণ্য হাতে পেয়ে টাকা দিন" },
            { icon: "truck", title: "দ্রুত ডেলিভারি", text: "সারা দেশে ১–৩ দিনে" },
            { icon: "return", title: "সহজ রিটার্ন", text: "৭ দিনের রিটার্ন সুবিধা" },
            { icon: "lock", title: "নিরাপদ পেমেন্ট", text: "ক্যাশ, বিকাশ বা নগদ" },
          ],
        ),
      },
    },
    {
      id: "reviews",
      type: "testimonials",
      fields: {
        heading: bi("What our customers say", "কাস্টমারদের মতামত"),
        items: (() => {
          const r = [
            review("Great quality shirt and it arrived in two days. Paying on delivery made it easy.", "শার্টের মান খুব ভালো, দুই দিনেই হাতে পেয়েছি। ক্যাশ অন ডেলিভারি থাকায় নিশ্চিন্তে অর্ডার করেছি।", "Sadia Rahman", "সাদিয়া রহমান", "Dhaka", "ঢাকা", "5"),
            review("Exactly as pictured. The delivery man called before coming — very professional.", "ছবির সাথে হুবহু মিল। ডেলিভারির আগে ফোন করেছিল — খুবই পেশাদার।", "Mahmudul Hasan", "মাহমুদুল হাসান", "Rajshahi", "রাজশাহী", "5"),
            review("Good prices and quick replies on WhatsApp. Will order again.", "দাম ভালো, WhatsApp-এ দ্রুত উত্তর দেয়। আবার অর্ডার করব।", "Farzana Akter", "ফারজানা আক্তার", "Khulna", "খুলনা", "4"),
          ];
          return bi(r.map((x) => x.en), r.map((x) => x.bn));
        })(),
      },
    },
    {
      id: "delivery",
      type: "deliveryInfo",
      fields: {
        heading: bi("Delivery information", "ডেলিভারি তথ্য"),
        intro: bi("We deliver to all 64 districts through trusted courier partners.", "বিশ্বস্ত কুরিয়ারের মাধ্যমে আমরা দেশের ৬৪ জেলাতেই ডেলিভারি দিই।"),
        zones: bi(
          [
            { area: "Inside Dhaka", time: "1–2 days", charge: 60 },
            { area: "Dhaka suburbs", time: "2–3 days", charge: 100 },
            { area: "Outside Dhaka", time: "3–5 days", charge: 120 },
          ],
          [
            { area: "ঢাকার ভিতরে", time: "১–২ দিন", charge: 60 },
            { area: "ঢাকার আশেপাশে", time: "২–৩ দিন", charge: 100 },
            { area: "ঢাকার বাইরে", time: "৩–৫ দিন", charge: 120 },
          ],
        ),
        paymentHeading: bi("We accept", "পেমেন্ট মাধ্যম"),
        payments: [{ method: "cod" }, { method: "bkash" }, { method: "nagad" }],
        note: bi("The delivery charge is paid together with the product on delivery.", "ডেলিভারি চার্জ পণ্য গ্রহণের সময় একসাথে পরিশোধ করতে হবে।"),
      },
    },
    {
      id: "order",
      type: "cta",
      label: "Order call to action",
      locked: { style: "band" },
      required: ["cta"],
      fields: {
        heading: bi("Order with one message", "এক মেসেজেই অর্ডার করুন"),
        text: bi("Send us the product name on WhatsApp — we'll confirm your order in minutes.", "WhatsApp-এ পণ্যের নাম পাঠান — কয়েক মিনিটেই অর্ডার কনফার্ম করে দেব।"),
        cta: bi(noAction("Order on WhatsApp"), noAction("WhatsApp-এ অর্ডার করুন")),
      },
    },
    {
      id: "footer",
      type: "shopFooter",
      fields: {
        brandName: bi("Bazar Mart", "বাজার মার্ট"),
        tagline: bi("Everyday shopping, delivered across Bangladesh.", "প্রতিদিনের কেনাকাটা, সারা বাংলাদেশে ডেলিভারি।"),
        address: bi("Dhaka, Bangladesh", "ঢাকা, বাংলাদেশ"),
        payments: [{ method: "cod" }, { method: "bkash" }, { method: "nagad" }],
        copyright: bi("© Bazar Mart. All rights reserved.", "© বাজার মার্ট। সর্বস্বত্ব সংরক্ষিত।"),
      },
    },
  ]),
};

// ─── BD Premium Brand ───────────────────────────────────────────────────────

const premiumBrand: SystemTemplateDef = {
  key: "bd-premium-brand",
  name: "BD Premium Brand",
  description:
    "A calm, editorial brand page for premium Bangladeshi labels: serif typography, large imagery, featured collection, brand story and a quiet delivery & payment section.",
  category: "ecommerce",
  spec: build([
    {
      id: "theme",
      type: "theme",
      locked: { radius: "sharp" },
      fields: {
        primary: "#1f1b16",
        onPrimary: "#faf7f2",
        accent: "#b08d57",
        background: "#faf7f2",
        surface: "#ffffff",
        text: "#1f1b16",
        muted: "#6b6258",
        font: "serif",
        numerals: "auto",
      },
    },
    {
      id: "seo",
      type: "seo",
      fields: {
        title: bi("Nakshi & Co. | Handwoven in Bangladesh", "নকশি অ্যান্ড কো. | বাংলাদেশের তাঁতে বোনা"),
        description: bi(
          "Handwoven jamdani, nakshi kantha and fine cotton, delivered across Bangladesh.",
          "হাতে বোনা জামদানি, নকশিকাঁথা ও মসৃণ সুতি — সারা বাংলাদেশে ডেলিভারি।",
        ),
      },
    },
    {
      id: "header",
      type: "shopHeader",
      locked: { style: "minimal" },
      fields: {
        brandName: bi("Nakshi & Co.", "নকশি অ্যান্ড কো."),
        links: bi(
          [
            { label: "Collection", url: "#collection" },
            { label: "Best sellers", url: "#bestsellers" },
            { label: "Our story", url: "#story" },
          ],
          [
            { label: "কালেকশন", url: "#collection" },
            { label: "সেরা বিক্রিত", url: "#bestsellers" },
            { label: "আমাদের গল্প", url: "#story" },
          ],
        ),
        cta: biCta("Shop", "কিনুন", "showcase"),
      },
    },
    {
      id: "hero",
      type: "editorialHero",
      fields: {
        eyebrow: bi("Autumn collection 2026", "শরৎ কালেকশন ২০২৬"),
        headline: bi("Timeless craft, woven in Bangladesh", "চিরন্তন কারুকাজ, বাংলাদেশের তাঁতে বোনা"),
        subheadline: bi(
          "Handwoven jamdani, nakshi kantha and fine cotton — made by artisans, delivered to your door.",
          "হাতে বোনা জামদানি, নকশিকাঁথা আর মসৃণ সুতি — কারিগরদের হাতে তৈরি, পৌঁছে যাবে আপনার দরজায়।",
        ),
        cta: biCta("Explore the collection", "কালেকশন দেখুন", "collection"),
      },
    },
    {
      id: "collection",
      type: "categoryGrid",
      locked: { style: "tiles" },
      fields: {
        heading: bi("Featured collection", "বিশেষ কালেকশন"),
        intro: bi("Three crafts, one standard: made slowly, made to last.", "তিনটি কারুশিল্প, একটাই মান: ধীরে তৈরি, টেকসই।"),
        items: bi(
          [
            { name: "Jamdani", image: null, link: "#showcase" },
            { name: "Nakshi Kantha", image: null, link: "#showcase" },
            { name: "Fine Cotton", image: null, link: "#showcase" },
          ],
          [
            { name: "জামদানি", image: null, link: "#showcase" },
            { name: "নকশিকাঁথা", image: null, link: "#showcase" },
            { name: "মসৃণ সুতি", image: null, link: "#showcase" },
          ],
        ),
      },
    },
    {
      id: "showcase",
      type: "productGrid",
      locked: { style: "minimal" },
      fields: {
        heading: bi("The signature pieces", "আমাদের বিশেষ সংগ্রহ"),
        columns: "3",
        items: productList([
          product("Dhakai Jamdani Saree", "ঢাকাই জামদানি শাড়ি", 12500, null, ["Handwoven", "হাতে বোনা"], "0"),
          product("Nakshi Kantha Throw", "নকশিকাঁথা থ্রো", 6800, null, null, "0"),
          product("Fine Cotton Panjabi", "মসৃণ সুতির পাঞ্জাবি", 3450, 3950, null, "0"),
        ]),
      },
    },
    {
      id: "promo",
      type: "offerBanner",
      locked: { style: "editorial" },
      fields: {
        badge: bi("Limited edition", "সীমিত সংস্করণ"),
        heading: bi("Festive jamdani, 15% off", "উৎসবের জামদানিতে ১৫% ছাড়"),
        text: bi(
          "A small run of festive jamdani, woven for this season only.",
          "শুধু এই মৌসুমের জন্য বোনা সীমিত সংখ্যক উৎসবের জামদানি।",
        ),
        deadline: bi("Until 15 October", "১৫ অক্টোবর পর্যন্ত"),
        price: 10625,
        oldPrice: 12500,
        cta: biCta("Reserve yours", "আপনারটি সংরক্ষণ করুন", "order"),
      },
    },
    {
      id: "story",
      type: "about",
      fields: {
        heading: bi("Our story", "আমাদের গল্প"),
        body: bi(
          "Nakshi & Co. began in a weaving village near Narayanganj, where the same families have kept jamdani alive for generations.\n\nWe pay artisans fairly, work in small batches, and check every piece by hand before it leaves our studio.",
          "নকশি অ্যান্ড কো.-এর যাত্রা শুরু নারায়ণগঞ্জের এক তাঁতপল্লিতে, যেখানে একই পরিবারগুলো প্রজন্মের পর প্রজন্ম ধরে জামদানিকে বাঁচিয়ে রেখেছে।\n\nআমরা কারিগরদের ন্যায্য মজুরি দিই, অল্প পরিমাণে কাজ করি, আর স্টুডিও থেকে পাঠানোর আগে প্রতিটি পণ্য হাতে যাচাই করি।",
        ),
        stats: bi(
          [
            { value: "120+", label: "Artisan families" },
            { value: "64", label: "Districts delivered" },
            { value: "2016", label: "Weaving since" },
          ],
          [
            { value: "১২০+", label: "কারিগর পরিবার" },
            { value: "৬৪", label: "জেলায় ডেলিভারি" },
            { value: "২০১৬", label: "সাল থেকে যাত্রা" },
          ],
        ),
      },
    },
    {
      id: "bestsellers",
      type: "productGrid",
      locked: { style: "minimal" },
      fields: {
        heading: bi("Best sellers", "সেরা বিক্রিত"),
        columns: "4",
        items: productList([
          product("Cotton Tangail Saree", "টাঙ্গাইলের সুতি শাড়ি", 4200, 4800, null, "5"),
          product("Handloom Gamchha Set", "তাঁতের গামছা সেট", 950, null, null, "5"),
          product("Embroidered Shawl", "নকশা করা শাল", 3800, null, ["New", "নতুন"], "4"),
          product("Linen Kurta", "লিনেন কুর্তা", 2650, 2990, null, "4"),
        ]),
      },
    },
    {
      id: "reviews",
      type: "testimonials",
      fields: {
        heading: bi("Loved by our customers", "কাস্টমারদের ভালোবাসা"),
        items: (() => {
          const r = [
            review("The jamdani is even more beautiful in person. Packaging felt like a gift.", "সামনাসামনি জামদানিটা আরও সুন্দর। প্যাকেজিং দেখে মনে হয়েছে উপহার পেয়েছি।", "Anika Chowdhury", "আনিকা চৌধুরী", "Dhaka", "ঢাকা", "5"),
            review("Genuine handloom quality — you can feel the difference.", "খাঁটি তাঁতের মান — পার্থক্যটা হাতে নিলেই বোঝা যায়।", "Tanvir Ahmed", "তানভীর আহমেদ", "Chattogram", "চট্টগ্রাম", "5"),
            review("Ordered for my mother's birthday. Delivered on time to Sylhet.", "মায়ের জন্মদিনে অর্ডার করেছিলাম। সময়মতো সিলেটে পৌঁছে গেছে।", "Rumana Begum", "রুমানা বেগম", "Sylhet", "সিলেট", "5"),
          ];
          return bi(r.map((x) => x.en), r.map((x) => x.bn));
        })(),
      },
    },
    {
      id: "trust",
      type: "deliveryInfo",
      fields: {
        heading: bi("Delivery & payment", "ডেলিভারি ও পেমেন্ট"),
        intro: bi("Every order is packed by hand and insured in transit.", "প্রতিটি অর্ডার হাতে প্যাক করা হয় এবং পরিবহনের সময় সুরক্ষিত থাকে।"),
        zones: bi(
          [
            { area: "Inside Dhaka", time: "1–2 days", charge: 80 },
            { area: "Outside Dhaka", time: "3–5 days", charge: 150 },
          ],
          [
            { area: "ঢাকার ভিতরে", time: "১–২ দিন", charge: 80 },
            { area: "ঢাকার বাইরে", time: "৩–৫ দিন", charge: 150 },
          ],
        ),
        paymentHeading: bi("Payment options", "পেমেন্ট অপশন"),
        payments: [{ method: "cod" }, { method: "bkash" }, { method: "nagad" }, { method: "card" }],
        note: bi("Exchanges are free within 7 days of delivery.", "ডেলিভারির ৭ দিনের মধ্যে বিনামূল্যে পরিবর্তন করা যাবে।"),
      },
    },
    {
      id: "order",
      type: "cta",
      label: "Order call to action",
      locked: { style: "card" },
      required: ["cta"],
      fields: {
        heading: bi("Find your piece", "আপনার পছন্দের পণ্যটি বেছে নিন"),
        text: bi("Message us and our team will help you choose, size and order.", "মেসেজ দিন — পছন্দ, মাপ ও অর্ডারে আমাদের টিম সাহায্য করবে।"),
        cta: bi(noAction("Message us on WhatsApp"), noAction("WhatsApp-এ মেসেজ দিন")),
      },
    },
    {
      id: "footer",
      type: "shopFooter",
      fields: {
        brandName: bi("Nakshi & Co.", "নকশি অ্যান্ড কো."),
        tagline: bi("Handwoven in Bangladesh.", "বাংলাদেশের তাঁতে বোনা।"),
        address: bi("Narayanganj, Bangladesh", "নারায়ণগঞ্জ, বাংলাদেশ"),
        payments: [{ method: "cod" }, { method: "bkash" }, { method: "nagad" }, { method: "card" }],
        copyright: bi("© Nakshi & Co.", "© নকশি অ্যান্ড কো."),
      },
    },
  ]),
};

// ─── BD Single Product ──────────────────────────────────────────────────────

/**
 * One product, sold COD to mobile visitors from a Facebook ad. Unlike the
 * shops above it sells through the page's own checkout: the Product
 * spotlight shows the page's featured linked product live (name, price,
 * discount, stock, options) with Buy now, and the mobile order bar points
 * at it. No section holds a copy of the product, its price or a delivery
 * fee: the offer banner's price fields are locked empty, and delivery
 * charges come from the checkout. Reviews start as bracketed prompts to
 * replace with real ones — never invented customers or ratings.
 */
const toSpotlight = (en: string, bnLabel: string) => biCta(en, bnLabel, "spotlight");

const reviewPrompt = (enQuote: string, bnQuote: string) => ({
  en: { quote: enQuote, name: "[Customer name]", role: "[District]", avatar: null, rating: "0" },
  bn: { quote: bnQuote, name: "[কাস্টমারের নাম]", role: "[জেলা]", avatar: null, rating: "0" },
});

const singleProduct: SystemTemplateDef = {
  key: "bd-single-product",
  name: "BD Single Product",
  description:
    "A focused cash-on-delivery page for one product, built for mobile visitors from Facebook ads: live price, discount, stock and options with an Order now button that opens checkout, plus trust, how-to-order, FAQ, delivery and a mobile order bar.",
  category: "ecommerce",
  spec: build([
    {
      id: "theme",
      type: "theme",
      version: 2,
      fields: {
        primary: "#0f766e",
        onPrimary: "#ffffff",
        accent: "#fbbf24",
        background: "#ffffff",
        surface: "#f0fdfa",
        text: "#0f172a",
        muted: "#475569",
        font: "bengali",
        radius: "soft",
        numerals: "auto",
        motion: "subtle",
      },
    },
    {
      id: "seo",
      type: "seo",
      fields: {
        title: bi("Order online with cash on delivery | Your Shop", "ক্যাশ অন ডেলিভারিতে অর্ডার করুন | আপনার শপ"),
        description: bi(
          "Order in a minute and pay when the product reaches you. Home delivery across Bangladesh.",
          "এক মিনিটে অর্ডার করুন, পণ্য হাতে পেয়ে টাকা দিন। সারা বাংলাদেশে হোম ডেলিভারি।",
        ),
      },
    },
    {
      id: "topbar",
      type: "announcement",
      label: "Offer bar",
      locked: { style: "dark" },
      fields: {
        icon: "gift",
        text: bi("Today's special offer · Cash on delivery across Bangladesh", "আজকের বিশেষ অফার · সারা বাংলাদেশে ক্যাশ অন ডেলিভারি"),
      },
    },
    {
      id: "hero",
      type: "promoHero",
      locked: { layout: "banner" },
      fields: {
        badge: bi("Special price for a limited time", "সীমিত সময়ের জন্য বিশেষ মূল্য"),
        // Short on purpose: on a phone the product should start on the first screen.
        headline: bi("Quality you'll love, every day", "প্রতিদিনের প্রয়োজনের সেরা সমাধান"),
        subheadline: bi("Order in a minute and pay when it reaches your door.", "এক মিনিটে অর্ডার করুন, পণ্য হাতে পেয়ে টাকা দিন।"),
        primaryCta: toSpotlight("Order now", "এখনই অর্ডার করুন"),
        // No second button by default (an empty label renders nothing); merchants can add one.
        secondaryCta: noAction(""),
        note: bi("Cash on delivery · No advance payment", "ক্যাশ অন ডেলিভারি · কোনো অগ্রিম পেমেন্ট নেই"),
      },
    },
    {
      id: "spotlight",
      type: "productSpotlight",
      fields: {
        eyebrow: bi("Special offer", "বিশেষ অফার"),
        tagline: bi(
          "Order in a minute — you pay only when the product reaches you.",
          "এক মিনিটে অর্ডার করুন — টাকা দেবেন পণ্য হাতে পাওয়ার পর।",
        ),
        highlights: bi(
          [
            { icon: "cash", text: "Cash on delivery" },
            { icon: "truck", text: "Home delivery across Bangladesh" },
            { icon: "phone", text: "Order confirmed by phone" },
          ],
          [
            { icon: "cash", text: "ক্যাশ অন ডেলিভারি" },
            { icon: "truck", text: "সারা বাংলাদেশে হোম ডেলিভারি" },
            { icon: "phone", text: "ফোনে অর্ডার কনফার্মেশন" },
          ],
        ),
        ctaLabel: bi("Order now", "এখনই অর্ডার করুন"),
        note: bi("No advance payment — pay when you receive it", "কোনো অগ্রিম টাকা লাগবে না — পণ্য হাতে পেয়ে টাকা দিন"),
        showDescription: true,
        layout: "imageLeft",
      },
    },
    {
      id: "benefits",
      type: "benefits",
      locked: { imageSide: "right" },
      fields: {
        heading: bi("Why you'll love it", "কেন এটি আপনার জন্য সেরা"),
        items: bi(
          [
            { title: "Premium quality", text: "Made with carefully chosen materials." },
            { title: "Easy to use", text: "Ready to use from the day it arrives." },
            { title: "A product you can trust", text: "Exactly what you see on this page." },
            { title: "Fast delivery", text: "Packed and sent soon after your order is confirmed." },
          ],
          [
            { title: "প্রিমিয়াম মান", text: "যত্ন করে বাছাই করা উপকরণে তৈরি।" },
            { title: "সহজ ব্যবহার", text: "হাতে পাওয়ার দিন থেকেই ব্যবহার করতে পারবেন।" },
            { title: "নির্ভরযোগ্য পণ্য", text: "এই পেজে যা দেখছেন, ঠিক তা-ই পাবেন।" },
            { title: "দ্রুত ডেলিভারি", text: "অর্ডার কনফার্ম হওয়ার পরই প্যাক করে পাঠানো হয়।" },
          ],
        ),
        cta: toSpotlight("Order now", "এখনই অর্ডার করুন"),
      },
    },
    {
      id: "trust",
      type: "trustFeatures",
      locked: { style: "cards" },
      fields: {
        heading: bi("Shop with confidence", "নিশ্চিন্তে কেনাকাটা করুন"),
        items: bi(
          [
            { icon: "cash", title: "Cash on delivery", text: "Pay only when the product arrives" },
            { icon: "phone", title: "Phone confirmation", text: "We call to confirm your order before dispatch" },
            { icon: "truck", title: "Home delivery", text: "Delivered to your door by courier" },
            { icon: "chat", title: "Easy to reach", text: "Call or message us with any question" },
          ],
          [
            { icon: "cash", title: "ক্যাশ অন ডেলিভারি", text: "পণ্য হাতে পেয়ে টাকা দিন" },
            { icon: "phone", title: "ফোনে কনফার্মেশন", text: "পাঠানোর আগে ফোন করে অর্ডার কনফার্ম করা হয়" },
            { icon: "truck", title: "হোম ডেলিভারি", text: "কুরিয়ারের মাধ্যমে আপনার দরজায়" },
            { icon: "chat", title: "সহজ যোগাযোগ", text: "যেকোনো প্রশ্নে কল বা মেসেজ করুন" },
          ],
        ),
      },
    },
    {
      id: "how",
      type: "features",
      label: "How to order",
      locked: { columns: "3", style: "cards" },
      fields: {
        heading: bi("How to order", "কীভাবে অর্ডার করবেন"),
        intro: bi("Three simple steps — no account and no advance payment.", "মাত্র ৩টি ধাপ — কোনো অ্যাকাউন্ট বা অগ্রিম পেমেন্ট লাগবে না।"),
        items: bi(
          [
            { icon: "bag", title: "1. Choose your product", text: "Pick the size, colour or option you want." },
            { icon: "cart", title: "2. Tap Order now", text: "The order form opens straight away." },
            { icon: "cash", title: "3. Confirm — pay on delivery", text: "Enter your name, phone and address. Pay when it arrives." },
          ],
          [
            { icon: "bag", title: "১. পণ্য বেছে নিন", text: "আপনার পছন্দের সাইজ, রং বা অপশন বেছে নিন।" },
            { icon: "cart", title: "২. ‘এখনই অর্ডার করুন’ চাপুন", text: "সাথে সাথে অর্ডার ফর্ম খুলে যাবে।" },
            { icon: "cash", title: "৩. কনফার্ম করুন — টাকা ডেলিভারিতে", text: "নাম, ফোন নম্বর ও ঠিকানা দিন। পণ্য হাতে পেয়ে টাকা দিন।" },
          ],
        ),
      },
    },
    {
      id: "offer",
      type: "offerBanner",
      // The live price and discount are on the Product spotlight; a second,
      // typed-in price here could disagree with it, so these stay empty.
      locked: { style: "bold", price: null, oldPrice: null },
      fields: {
        badge: bi("Special offer", "বিশেষ অফার"),
        heading: bi("Order today at the special price", "আজই অর্ডার করুন বিশেষ মূল্যে"),
        text: bi(
          "The offer price is shown with the product above. Order while the offer is on.",
          "অফার মূল্য উপরে পণ্যের সাথে দেখানো আছে। অফার চলাকালীন অর্ডার করে নিন।",
        ),
        deadline: "",
        cta: toSpotlight("Order now", "এখনই অর্ডার করুন"),
      },
    },
    {
      id: "reviews",
      type: "testimonials",
      fields: {
        heading: bi("What customers say", "কাস্টমারদের মতামত"),
        items: (() => {
          const r = [
            reviewPrompt(
              "[Replace with a real review from one of your customers — what they bought and what they liked.]",
              "[এখানে আপনার একজন কাস্টমারের আসল মতামত লিখুন — কী কিনেছেন, কী ভালো লেগেছে।]",
            ),
            reviewPrompt(
              "[Add another real customer review, for example about delivery or quality.]",
              "[আরেকজন কাস্টমারের আসল মতামত যোগ করুন — যেমন ডেলিভারি বা পণ্যের মান নিয়ে।]",
            ),
            reviewPrompt(
              "[Add a third real review, or remove this one.]",
              "[তৃতীয় একটি আসল মতামত যোগ করুন, অথবা এটি মুছে দিন।]",
            ),
          ];
          return bi(r.map((x) => x.en), r.map((x) => x.bn));
        })(),
      },
    },
    {
      id: "faq",
      type: "faq",
      fields: {
        heading: bi("Frequently asked questions", "সাধারণ জিজ্ঞাসা"),
        items: bi(
          [
            {
              question: "How can I order?",
              answer:
                "Tap “Order now”, choose your option if the product has any, then enter your name, phone number and address and confirm. You may get a call to confirm the order.",
            },
            {
              question: "Is cash on delivery available?",
              answer: "Yes. You pay for the product and the delivery charge in cash when it is delivered.",
            },
            {
              question: "How long does delivery take?",
              answer:
                "It depends on your area — see the delivery information below. The delivery charge for your area is shown before you confirm your order.",
            },
            {
              question: "Can I choose a different size, colour or option?",
              answer: "Yes. If the product comes in options, choose the one you want before ordering. Options that are out of stock can't be selected.",
            },
            {
              question: "What if I receive a damaged or wrong product?",
              answer: "Contact us as soon as possible with photos of the product, and we will help you according to our return policy.",
            },
          ],
          [
            {
              question: "কীভাবে অর্ডার করব?",
              answer:
                "“এখনই অর্ডার করুন” চাপুন, পণ্যের অপশন থাকলে পছন্দেরটি বেছে নিন, তারপর আপনার নাম, ফোন নম্বর ও ঠিকানা দিয়ে কনফার্ম করুন। অর্ডার কনফার্ম করতে আপনাকে ফোন করা হতে পারে।",
            },
            {
              question: "ক্যাশ অন ডেলিভারি আছে কি?",
              answer: "হ্যাঁ। পণ্য হাতে পাওয়ার সময় পণ্যের দাম ও ডেলিভারি চার্জ নগদে পরিশোধ করবেন।",
            },
            {
              question: "ডেলিভারি পেতে কতদিন লাগবে?",
              answer: "এটি আপনার এলাকার উপর নির্ভর করে — নিচের ডেলিভারি তথ্য দেখুন। অর্ডার কনফার্ম করার আগেই আপনার এলাকার ডেলিভারি চার্জ দেখানো হবে।",
            },
            {
              question: "অন্য সাইজ, রং বা অপশন বেছে নেওয়া যাবে?",
              answer: "হ্যাঁ। পণ্যের অপশন থাকলে অর্ডারের আগে পছন্দেরটি বেছে নিন। স্টকে নেই এমন অপশন বেছে নেওয়া যাবে না।",
            },
            {
              question: "পণ্য ভাঙা বা ভুল পেলে কী করব?",
              answer: "যত দ্রুত সম্ভব পণ্যের ছবিসহ আমাদের সাথে যোগাযোগ করুন — আমাদের রিটার্ন নীতি অনুযায়ী আমরা সাহায্য করব।",
            },
          ],
        ),
      },
    },
    {
      id: "delivery",
      type: "deliveryInfo",
      fields: {
        heading: bi("Delivery information", "ডেলিভারি তথ্য"),
        intro: bi(
          "We deliver across Bangladesh. The times below are typical and can vary by area.",
          "আমরা সারা বাংলাদেশে ডেলিভারি দিই। নিচের সময়গুলো সাধারণত প্রযোজ্য, এলাকাভেদে কম-বেশি হতে পারে।",
        ),
        // No charges here: the checkout shows the live charge for the customer's area.
        zones: bi(
          [
            { area: "Inside Dhaka", time: "1–2 days", charge: null },
            { area: "Outside Dhaka", time: "2–5 days", charge: null },
          ],
          [
            { area: "ঢাকার ভিতরে", time: "১–২ দিন", charge: null },
            { area: "ঢাকার বাইরে", time: "২–৫ দিন", charge: null },
          ],
        ),
        paymentHeading: bi("Payment", "পেমেন্ট"),
        payments: [{ method: "cod" }],
        note: bi(
          "The delivery charge for your area is shown at checkout, before you confirm your order.",
          "আপনার এলাকার ডেলিভারি চার্জ অর্ডার কনফার্ম করার আগেই চেকআউটে দেখানো হবে।",
        ),
      },
    },
    {
      id: "orderbar",
      type: "mobileActionBar",
      fields: {
        primaryCta: toSpotlight("Order now", "এখনই অর্ডার করুন"),
        whatsappCta: bi(noAction("WhatsApp"), noAction("হোয়াটসঅ্যাপ")),
        callCta: bi(noAction("Call"), noAction("কল করুন")),
      },
    },
    {
      id: "footer",
      type: "shopFooter",
      fields: {
        brandName: bi("Your Shop", "আপনার শপ"),
        tagline: bi("Quality products with cash on delivery across Bangladesh.", "মানসম্মত পণ্য, সারা বাংলাদেশে ক্যাশ অন ডেলিভারি।"),
        // The footer always shows its Contact column; merchants add their phone and full address.
        address: bi("Bangladesh", "বাংলাদেশ"),
        payments: [{ method: "cod" }],
        copyright: bi("© Your Shop. All rights reserved.", "© আপনার শপ। সর্বস্বত্ব সংরক্ষিত।"),
      },
    },
  ]),
};

export const COMMERCE_TEMPLATES: ReadonlyArray<SystemTemplateDef> = [modernShop, premiumBrand, singleProduct];
