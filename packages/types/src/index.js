// Single source of truth for phone number validation. Mirrors PHONE_RE in
// the @ecom/db package so the web app (which can't pull in mongoose) shares
// the exact same shape as the API routes and Mongoose schemas.
export const PHONE_RE = /^\+?[0-9]{7,15}$/;
// Country and language code lists - must stay in lock-step with the
// COUNTRIES and LANGUAGES enums in the @ecom/db merchant model. The web
// app can't pull in mongoose, so the codes live here and the DB package
// mirrors them. If you add a code to one place, add it to the other; the
// TypeScript types in dependent files will surface the drift at compile
// time once that file imports from here.
export const MERCHANT_COUNTRIES = [
    "BD",
    "PK",
    "IN",
    "LK",
    "NP",
    "ID",
    "PH",
    "VN",
    "MY",
    "TH",
];
export const MERCHANT_LANGUAGES = [
    "en",
    "bn",
    "ur",
    "hi",
    "ta",
    "id",
    "th",
    "vi",
    "ms",
];
export * from "./plans.js";
//# sourceMappingURL=index.js.map