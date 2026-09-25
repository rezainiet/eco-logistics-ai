import type { TemplateSpec, TemplateSpecSection } from "./spec.js";
import type { SystemTemplateDef } from "./templates.js";

/**
 * Bangladesh e-commerce landing templates. Bangla-first (default locale
 * bn) with complete English copy. Landing pages only: products, prices and
 * payment methods are displayed content — buttons lead to the merchant's
 * order channel (WhatsApp by default), never to a ConfirmX checkout.
 */

type Bi = { en: unknown; bn: unknown };
const bi = (en: unknown, bn: unknown): Bi => ({ en, bn });

interface SectionPlan {
  id: string;
  type: string;
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
      typeVersion: 1,
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

export const COMMERCE_TEMPLATES: ReadonlyArray<SystemTemplateDef> = [modernShop, premiumBrand];
