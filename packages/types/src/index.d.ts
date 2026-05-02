import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "./router.js";
export type { AppRouter } from "./router.js";
/** All-router output map - handy on the web client for type-safe selectors. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type UserRole = "merchant" | "admin" | "agent";
export interface SessionUser {
    id: string;
    email: string;
    name?: string;
    role: UserRole;
}
export declare const PHONE_RE: RegExp;
export declare const MERCHANT_COUNTRIES: readonly ["BD", "PK", "IN", "LK", "NP", "ID", "PH", "VN", "MY", "TH"];
export type MerchantCountry = (typeof MERCHANT_COUNTRIES)[number];
export declare const MERCHANT_LANGUAGES: readonly ["en", "bn", "ur", "hi", "ta", "id", "th", "vi", "ms"];
export type MerchantLanguage = (typeof MERCHANT_LANGUAGES)[number];
export * from "./plans.js";
//# sourceMappingURL=index.d.ts.map