import type { TemplateSpec } from "./spec.js";

/**
 * System templates — shipped in code, seeded into the database by the API
 * at boot (see apps/api/src/lib/landing/system-templates.ts). Admins cannot
 * edit them in place; they duplicate one and edit the copy. When the spec
 * below changes, the seeder publishes a NEW template version; pages pinned
 * to the previous version keep rendering exactly as before until their
 * owner chooses to upgrade.
 *
 * The three are intentionally different page structures, not recolours:
 *   - Launch:   single-product launch — centered hero, feature grid, FAQ.
 *   - Showcase: product storytelling — split hero, benefits, social proof.
 *   - Local:    service business — image banner, services, about, contact.
 */

export const TEMPLATE_CATEGORIES = ["product", "service", "lead", "general"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface SystemTemplateDef {
  key: string;
  name: string;
  description: string;
  category: TemplateCategory;
  spec: TemplateSpec;
}

const launch: SystemTemplateDef = {
  key: "launch",
  name: "Launch",
  description: "A bold single-product launch page: centered hero, feature grid, FAQ and a closing call to action.",
  category: "product",
  spec: {
    specVersion: 1,
    sections: [
      {
        id: "theme",
        type: "theme",
        typeVersion: 1,
        fields: {
          primary: { default: "#4f46e5" },
          onPrimary: { default: "#ffffff" },
          accent: { default: "#a855f7" },
          background: { default: "#ffffff" },
          surface: { default: "#f5f3ff" },
          text: { default: "#111827" },
          muted: { default: "#4b5563" },
          font: { default: "system" },
          radius: { default: "round", editable: false },
        },
      },
      { id: "seo", type: "seo", typeVersion: 1 },
      {
        id: "header",
        type: "header",
        typeVersion: 1,
        fields: {
          style: { default: "transparent", editable: false },
          brandName: { default: "Nova Store" },
          cta: { default: { label: "Order now", action: { kind: "section", sectionId: "order" } } },
        },
      },
      {
        id: "hero",
        type: "hero",
        typeVersion: 1,
        fields: {
          variant: { default: "centered", editable: false },
          eyebrow: { default: "New arrival" },
          headline: { default: "Everyday quality, delivered to your door" },
          subheadline: {
            default: "Order in a minute and pay cash on delivery anywhere in Bangladesh. No advance payment, no hassle.",
          },
          primaryCta: { default: { label: "Order now", action: { kind: "section", sectionId: "order" } } },
          secondaryCta: { default: { label: "See features", action: { kind: "section", sectionId: "features" } } },
          badges: {
            default: [
              { icon: "truck", text: "Nationwide delivery" },
              { icon: "shield", text: "Cash on delivery" },
              { icon: "star", text: "4.9 customer rating" },
            ],
          },
        },
      },
      {
        id: "features",
        type: "features",
        typeVersion: 1,
        fields: {
          style: { default: "cards", editable: false },
          heading: { default: "Why you'll love it" },
          intro: { default: "Built to last and designed for daily use." },
          items: {
            default: [
              { icon: "award", title: "Premium materials", text: "Carefully sourced and quality-checked before dispatch." },
              { icon: "bolt", title: "Ready to use", text: "Arrives set up — no extra tools or accessories needed." },
              { icon: "truck", title: "Fast delivery", text: "Inside Dhaka in 1–2 days, everywhere else in 2–4 days." },
              { icon: "shield", title: "Easy returns", text: "Not right? Return it within 7 days, no questions asked." },
              { icon: "chat", title: "Real support", text: "Talk to a person on WhatsApp whenever you need help." },
              { icon: "gift", title: "Gift-ready", text: "Every order ships in protective, gift-ready packaging." },
            ],
          },
        },
      },
      {
        id: "faq",
        type: "faq",
        typeVersion: 1,
        fields: {
          items: {
            default: [
              { question: "How do I pay?", answer: "You pay **cash on delivery** when the parcel reaches you." },
              { question: "How long does delivery take?", answer: "Inside Dhaka: 1–2 days.\nOutside Dhaka: 2–4 days." },
              { question: "Can I return it?", answer: "Yes. Contact us within 7 days of delivery and we will arrange a return." },
            ],
          },
        },
      },
      {
        id: "order",
        type: "cta",
        typeVersion: 1,
        label: "Order call to action",
        fields: {
          style: { default: "band", editable: false },
          heading: { default: "Ready to order?" },
          text: { default: "Message us on WhatsApp and we'll confirm your order within minutes." },
          cta: { required: true, default: { label: "Order on WhatsApp", action: { kind: "none" } } },
        },
      },
      {
        id: "footer",
        type: "footer",
        typeVersion: 1,
        fields: {
          brandName: { default: "Nova Store" },
          tagline: { default: "Quality products, cash on delivery." },
          copyright: { default: "© Nova Store. All rights reserved." },
        },
      },
    ],
  },
};

const showcase: SystemTemplateDef = {
  key: "showcase",
  name: "Showcase",
  description: "Warm product storytelling: split hero with photo, benefit checklist, customer testimonials and a card call to action.",
  category: "product",
  spec: {
    specVersion: 1,
    sections: [
      {
        id: "theme",
        type: "theme",
        typeVersion: 1,
        fields: {
          primary: { default: "#c2410c" },
          onPrimary: { default: "#ffffff" },
          accent: { default: "#eab308" },
          background: { default: "#fffbf5" },
          surface: { default: "#ffffff" },
          text: { default: "#1c1917" },
          muted: { default: "#57534e" },
          font: { default: "serif", editable: false },
          radius: { default: "soft" },
        },
      },
      { id: "seo", type: "seo", typeVersion: 1 },
      {
        id: "header",
        type: "header",
        typeVersion: 1,
        fields: {
          style: { default: "light", editable: false },
          brandName: { default: "Amber & Oak" },
          cta: { default: { label: "Shop now", action: { kind: "section", sectionId: "order" } } },
        },
      },
      {
        id: "hero",
        type: "hero",
        typeVersion: 1,
        fields: {
          variant: { default: "split", editable: false },
          eyebrow: { default: "Handcrafted in Bangladesh" },
          headline: { default: "Crafted slowly. Made to be used every day." },
          subheadline: {
            default: "Each piece is finished by hand from natural materials — and delivered to your door with cash on delivery.",
          },
          primaryCta: { default: { label: "Order yours", action: { kind: "section", sectionId: "order" } } },
          secondaryCta: { default: { label: "Read reviews", action: { kind: "section", sectionId: "reviews" } } },
          badges: { editable: false, default: [] },
        },
      },
      {
        id: "benefits",
        type: "benefits",
        typeVersion: 1,
        fields: {
          imageSide: { default: "left" },
          heading: { default: "Why it's worth it" },
          body: { default: "We make fewer things, better. Every order is checked by hand before it leaves our workshop." },
          items: {
            default: [
              { title: "Natural materials", text: "No plastic fillers or harsh finishes." },
              { title: "Finished by hand", text: "Small-batch production, one piece at a time." },
              { title: "Built to last", text: "Designed for years of daily use." },
              { title: "Pay on delivery", text: "Inspect it first, then pay the courier." },
            ],
          },
          cta: { default: { label: "Order now", action: { kind: "section", sectionId: "order" } } },
        },
      },
      {
        id: "reviews",
        type: "testimonials",
        typeVersion: 1,
        label: "Reviews",
        fields: {
          items: {
            default: [
              { quote: "Beautifully made and arrived well packed. Paying on delivery made it easy to trust.", name: "Nusrat J.", role: "Dhaka", avatar: null, rating: "5" },
              { quote: "Better than the photos. I've already ordered a second one as a gift.", name: "Rafiq H.", role: "Chattogram", avatar: null, rating: "5" },
              { quote: "Quick delivery and the team answered all my questions on WhatsApp.", name: "Tania A.", role: "Sylhet", avatar: null, rating: "4" },
            ],
          },
        },
      },
      {
        id: "order",
        type: "cta",
        typeVersion: 1,
        label: "Order call to action",
        fields: {
          style: { default: "card", editable: false },
          heading: { default: "Bring one home" },
          text: { default: "Order today — pay the courier when it arrives." },
          cta: { required: true, default: { label: "Order on WhatsApp", action: { kind: "none" } } },
        },
      },
      {
        id: "footer",
        type: "footer",
        typeVersion: 1,
        fields: {
          brandName: { default: "Amber & Oak" },
          tagline: { default: "Handcrafted goods, delivered nationwide." },
          copyright: { default: "© Amber & Oak" },
        },
      },
    ],
  },
};

const local: SystemTemplateDef = {
  key: "local-service",
  name: "Local Business",
  description: "For service businesses: full-width image banner, service list with prices, about with key numbers, and contact details.",
  category: "service",
  spec: {
    specVersion: 1,
    sections: [
      {
        id: "theme",
        type: "theme",
        typeVersion: 1,
        fields: {
          primary: { default: "#047857" },
          onPrimary: { default: "#ffffff" },
          accent: { default: "#f59e0b" },
          background: { default: "#ffffff" },
          surface: { default: "#ecfdf5" },
          text: { default: "#0f172a" },
          muted: { default: "#475569" },
          font: { default: "humanist" },
          radius: { default: "sharp", editable: false },
        },
      },
      { id: "seo", type: "seo", typeVersion: 1 },
      {
        id: "header",
        type: "header",
        typeVersion: 1,
        fields: {
          style: { default: "solid", editable: false },
          brandName: { default: "CoolFix Services" },
          cta: { default: { label: "Book a visit", action: { kind: "section", sectionId: "contact" } } },
        },
      },
      {
        id: "hero",
        type: "hero",
        typeVersion: 1,
        fields: {
          variant: { default: "banner", editable: false },
          eyebrow: { default: "Serving Dhaka since 2015" },
          headline: { default: "Fast, reliable home service — same-day visits" },
          subheadline: { default: "Certified technicians, fixed transparent prices, and a 30-day service guarantee." },
          primaryCta: { default: { label: "Book a visit", action: { kind: "section", sectionId: "contact" } } },
          secondaryCta: { default: { label: "View services", action: { kind: "section", sectionId: "services" } } },
          badges: {
            default: [
              { icon: "clock", text: "Same-day service" },
              { icon: "shield", text: "30-day guarantee" },
            ],
          },
        },
      },
      {
        id: "services",
        type: "services",
        typeVersion: 1,
        fields: {
          heading: { default: "What we do" },
          intro: { default: "Clear prices up front. No hidden charges." },
          items: {
            default: [
              { title: "Inspection & diagnosis", text: "A technician visits, finds the problem and quotes before any work.", price: "From ৳500", image: null },
              { title: "Servicing & cleaning", text: "Full clean and check-up to keep everything running efficiently.", price: "From ৳1,200", image: null },
              { title: "Repair & parts", text: "Genuine parts, fitted and tested on the spot.", price: "Quoted on visit", image: null },
            ],
          },
        },
      },
      {
        id: "about",
        type: "about",
        typeVersion: 1,
        fields: {
          heading: { default: "A local team you can trust" },
          body: {
            default:
              "We started as two technicians with one van. Today our team covers the whole city — but we still answer the phone ourselves.\n\n- Background-checked technicians\n- Fixed prices agreed before work starts\n- Every job guaranteed for 30 days",
          },
          stats: {
            default: [
              { value: "10+", label: "Years in business" },
              { value: "8,000", label: "Jobs completed" },
              { value: "4.8★", label: "Average rating" },
            ],
          },
        },
      },
      {
        id: "contact",
        type: "contact",
        typeVersion: 1,
        fields: {
          heading: { default: "Book a visit" },
          text: { default: "Call or message us — we usually reply within 15 minutes during opening hours." },
          address: { default: "House 00, Road 00\nDhaka" },
          hours: { default: "Saturday–Thursday: 9am – 9pm\nFriday: 3pm – 9pm" },
          cta: { default: { label: "Message us on WhatsApp", action: { kind: "none" } } },
        },
      },
      {
        id: "footer",
        type: "footer",
        typeVersion: 1,
        fields: {
          brandName: { default: "CoolFix Services" },
          tagline: { default: "Home service you can rely on." },
          copyright: { default: "© CoolFix Services" },
        },
      },
    ],
  },
};

export const SYSTEM_TEMPLATES: ReadonlyArray<SystemTemplateDef> = [launch, showcase, local];

/** Starting point for a brand-new admin template. */
export function blankTemplateSpec(): TemplateSpec {
  return {
    specVersion: 1,
    sections: [
      { id: "theme", type: "theme", typeVersion: 1 },
      { id: "seo", type: "seo", typeVersion: 1 },
      { id: "hero", type: "hero", typeVersion: 1 },
      { id: "cta", type: "cta", typeVersion: 1 },
      { id: "footer", type: "footer", typeVersion: 1 },
    ],
  };
}
