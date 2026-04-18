export type { AppRouter } from "./router.js";

export type UserRole = "merchant" | "admin" | "agent";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
}
