import type { ReactNode } from "react";
import { AccountShell } from "@/components/shell/account-shell";

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
