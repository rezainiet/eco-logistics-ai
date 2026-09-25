/**
 * Bangla default copy for the original system templates (Launch, Showcase,
 * Local Business). Applied through `spec.localeDefaults.bn`, so a Bangla
 * page starts with natural Bangla instead of English placeholders.
 */

const whatsappNone = (label: string) => ({ label, action: { kind: "none" } });
const toSection = (label: string, sectionId: string) => ({ label, action: { kind: "section", sectionId } });

export const LAUNCH_BN = {
  header: { brandName: "নোভা স্টোর", cta: toSection("অর্ডার করুন", "order") },
  hero: {
    eyebrow: "নতুন এসেছে",
    headline: "প্রতিদিনের মানসম্মত পণ্য, পৌঁছে যাবে আপনার দরজায়",
    subheadline:
      "এক মিনিটেই অর্ডার করুন, পণ্য হাতে পেয়ে টাকা দিন — সারা বাংলাদেশে ক্যাশ অন ডেলিভারি। কোনো অগ্রিম পেমেন্ট নেই।",
    primaryCta: toSection("এখনই অর্ডার করুন", "order"),
    secondaryCta: toSection("বিস্তারিত দেখুন", "features"),
    badges: [
      { icon: "truck", text: "সারা দেশে ডেলিভারি" },
      { icon: "shield", text: "ক্যাশ অন ডেলিভারি" },
      { icon: "star", text: "৪.৯ কাস্টমার রেটিং" },
    ],
  },
  features: {
    heading: "কেন আমাদের পণ্য বেছে নেবেন",
    intro: "টেকসই, মানসম্মত এবং প্রতিদিনের ব্যবহারের জন্য তৈরি।",
    items: [
      { icon: "award", title: "প্রিমিয়াম মানের উপকরণ", text: "প্রতিটি পণ্য পাঠানোর আগে যাচাই করা হয়।" },
      { icon: "bolt", title: "ব্যবহারের জন্য প্রস্তুত", text: "বাড়তি কোনো যন্ত্রপাতি বা অ্যাক্সেসরিজ লাগবে না।" },
      { icon: "truck", title: "দ্রুত ডেলিভারি", text: "ঢাকার ভিতরে ১–২ দিন, ঢাকার বাইরে ২–৪ দিন।" },
      { icon: "shield", title: "সহজ রিটার্ন", text: "পছন্দ না হলে ৭ দিনের মধ্যে ফেরত দিন।" },
      { icon: "chat", title: "সরাসরি সাপোর্ট", text: "যেকোনো প্রয়োজনে WhatsApp-এ আমাদের সাথে কথা বলুন।" },
      { icon: "gift", title: "উপহারের জন্য উপযোগী", text: "প্রতিটি অর্ডার সুন্দর ও নিরাপদ প্যাকেজিংয়ে পাঠানো হয়।" },
    ],
  },
  faq: {
    heading: "সচরাচর জিজ্ঞাসা",
    items: [
      { question: "কীভাবে পেমেন্ট করব?", answer: "পণ্য হাতে পেয়ে **ক্যাশ অন ডেলিভারিতে** টাকা পরিশোধ করুন।" },
      { question: "ডেলিভারি পেতে কত দিন লাগে?", answer: "ঢাকার ভিতরে: ১–২ দিন।\nঢাকার বাইরে: ২–৪ দিন।" },
      { question: "পণ্য ফেরত দেওয়া যাবে?", answer: "হ্যাঁ। ডেলিভারির ৭ দিনের মধ্যে আমাদের জানান, আমরা রিটার্নের ব্যবস্থা করব।" },
    ],
  },
  order: {
    heading: "অর্ডার করতে প্রস্তুত?",
    text: "WhatsApp-এ মেসেজ দিন, কয়েক মিনিটের মধ্যেই আপনার অর্ডার কনফার্ম করা হবে।",
    cta: whatsappNone("WhatsApp-এ অর্ডার করুন"),
  },
  footer: {
    brandName: "নোভা স্টোর",
    tagline: "মানসম্মত পণ্য, ক্যাশ অন ডেলিভারি।",
    copyright: "© নোভা স্টোর। সর্বস্বত্ব সংরক্ষিত।",
  },
};

export const SHOWCASE_BN = {
  header: { brandName: "অ্যাম্বার অ্যান্ড ওক", cta: toSection("এখনই কিনুন", "order") },
  hero: {
    eyebrow: "বাংলাদেশে হাতে তৈরি",
    headline: "যত্ন নিয়ে তৈরি, প্রতিদিন ব্যবহারের জন্য।",
    subheadline: "প্রাকৃতিক উপকরণে হাতে তৈরি প্রতিটি পণ্য — ক্যাশ অন ডেলিভারিতে পৌঁছে যাবে আপনার দরজায়।",
    primaryCta: toSection("আপনারটি অর্ডার করুন", "order"),
    secondaryCta: toSection("রিভিউ পড়ুন", "reviews"),
  },
  benefits: {
    heading: "কেন এটি সেরা",
    body: "আমরা কম বানাই, কিন্তু ভালো বানাই। ওয়ার্কশপ থেকে পাঠানোর আগে প্রতিটি অর্ডার হাতে যাচাই করা হয়।",
    items: [
      { title: "প্রাকৃতিক উপকরণ", text: "কোনো প্লাস্টিক ফিলার বা কড়া রাসায়নিক নেই।" },
      { title: "হাতে ফিনিশিং", text: "অল্প পরিমাণে, একটি একটি করে তৈরি।" },
      { title: "দীর্ঘস্থায়ী", text: "বছরের পর বছর প্রতিদিন ব্যবহারের উপযোগী।" },
      { title: "ডেলিভারিতে পেমেন্ট", text: "আগে দেখে নিন, তারপর কুরিয়ারকে টাকা দিন।" },
    ],
    cta: toSection("অর্ডার করুন", "order"),
  },
  reviews: {
    heading: "আমাদের কাস্টমাররা যা বলছেন",
    items: [
      { quote: "চমৎকার কাজ, খুব সুন্দরভাবে প্যাক করা ছিল। ক্যাশ অন ডেলিভারি থাকায় ভরসা পেয়েছি।", name: "নুসরাত জাহান", role: "ঢাকা", avatar: null, rating: "5" },
      { quote: "ছবির চেয়েও সুন্দর। উপহার দেওয়ার জন্য আরেকটি অর্ডার করেছি।", name: "রফিকুল হাসান", role: "চট্টগ্রাম", avatar: null, rating: "5" },
      { quote: "দ্রুত ডেলিভারি, আর WhatsApp-এ সব প্রশ্নের উত্তর পেয়েছি।", name: "তানিয়া আক্তার", role: "সিলেট", avatar: null, rating: "4" },
    ],
  },
  order: {
    heading: "একটি বাড়িতে নিয়ে যান",
    text: "আজই অর্ডার করুন — পণ্য পৌঁছালে কুরিয়ারকে টাকা দিন।",
    cta: whatsappNone("WhatsApp-এ অর্ডার করুন"),
  },
  footer: {
    brandName: "অ্যাম্বার অ্যান্ড ওক",
    tagline: "হাতে তৈরি পণ্য, সারা দেশে ডেলিভারি।",
    copyright: "© অ্যাম্বার অ্যান্ড ওক",
  },
};

export const LOCAL_BN = {
  header: { brandName: "কুলফিক্স সার্ভিসেস", cta: toSection("ভিজিট বুক করুন", "contact") },
  hero: {
    eyebrow: "২০১৫ সাল থেকে ঢাকায়",
    headline: "দ্রুত ও নির্ভরযোগ্য হোম সার্ভিস — একই দিনে",
    subheadline: "অভিজ্ঞ টেকনিশিয়ান, আগে থেকে জানানো নির্দিষ্ট মূল্য এবং ৩০ দিনের সার্ভিস গ্যারান্টি।",
    primaryCta: toSection("ভিজিট বুক করুন", "contact"),
    secondaryCta: toSection("সার্ভিসগুলো দেখুন", "services"),
    badges: [
      { icon: "clock", text: "একই দিনে সার্ভিস" },
      { icon: "shield", text: "৩০ দিনের গ্যারান্টি" },
    ],
  },
  services: {
    heading: "আমরা যা করি",
    intro: "আগে থেকেই পরিষ্কার মূল্য, কোনো লুকানো চার্জ নেই।",
    items: [
      { title: "পরিদর্শন ও সমস্যা নির্ণয়", text: "টেকনিশিয়ান এসে সমস্যা খুঁজে বের করবেন এবং কাজের আগেই খরচ জানাবেন।", price: "৳৫০০ থেকে", image: null },
      { title: "সার্ভিসিং ও পরিষ্কার", text: "সম্পূর্ণ পরিষ্কার ও চেক-আপ, যাতে সবকিছু ঠিকঠাক চলে।", price: "৳১,২০০ থেকে", image: null },
      { title: "মেরামত ও যন্ত্রাংশ", text: "আসল যন্ত্রাংশ, সেখানেই লাগিয়ে পরীক্ষা করা হয়।", price: "ভিজিটের সময় জানানো হবে", image: null },
    ],
  },
  about: {
    heading: "আপনার এলাকার বিশ্বস্ত টিম",
    body:
      "আমরা শুরু করেছিলাম দুজন টেকনিশিয়ান আর একটি ভ্যান নিয়ে। আজ আমাদের টিম পুরো শহরে কাজ করে — তবুও ফোনটা আমরাই ধরি।\n\n- যাচাই করা টেকনিশিয়ান\n- কাজ শুরুর আগেই নির্দিষ্ট মূল্য\n- প্রতিটি কাজে ৩০ দিনের গ্যারান্টি",
    stats: [
      { value: "১০+", label: "বছরের অভিজ্ঞতা" },
      { value: "৮,০০০", label: "সম্পন্ন কাজ" },
      { value: "৪.৮★", label: "গড় রেটিং" },
    ],
  },
  contact: {
    heading: "ভিজিট বুক করুন",
    text: "কল বা মেসেজ করুন — অফিস সময়ে সাধারণত ১৫ মিনিটের মধ্যে উত্তর দিই।",
    address: "বাড়ি ০০, রোড ০০\nঢাকা",
    hours: "শনিবার–বৃহস্পতিবার: সকাল ৯টা – রাত ৯টা\nশুক্রবার: বিকাল ৩টা – রাত ৯টা",
    cta: whatsappNone("WhatsApp-এ মেসেজ দিন"),
  },
  footer: {
    brandName: "কুলফিক্স সার্ভিসেস",
    tagline: "নির্ভরযোগ্য হোম সার্ভিস।",
    copyright: "© কুলফিক্স সার্ভিসেস",
  },
};
