import type { ReactNode } from "react";
import { AccountShell } from "@/components/shell/account-shell";

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
