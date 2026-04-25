import type { ReactNode } from "react";
import { AccountShell } from "@/components/shell/account-shell";

export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
