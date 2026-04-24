import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard/orders");

  return (
    <main className="relative flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
