import type { ReactNode } from "react";
import { AccountShell } from "@/components/shell/account-shell";
import { Providers } from "@/app/providers";

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AccountShell>{children}</AccountShell>
    </Providers>
  );
}
