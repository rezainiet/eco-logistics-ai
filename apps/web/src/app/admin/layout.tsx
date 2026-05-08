import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Toaster } from "@/components/ui/toast";
import { Providers } from "@/app/providers";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/admin/billing");
  if (session.user?.role !== "admin") redirect("/dashboard");

  return (
    <Providers>
    <div className="flex min-h-screen bg-[#0B0E1A]">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-[rgba(209,213,219,0.08)] bg-[#111318] md:flex md:flex-col">
        <div className="flex items-center gap-2 border-b border-[rgba(209,213,219,0.08)] px-5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EF4444] text-sm font-bold text-white">
            A
          </span>
          <span className="text-sm font-semibold text-[#F3F4F6]">Admin</span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4 text-sm">
          <Link
            href="/admin"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Dashboard
          </Link>
          <Link
            href="/admin/billing"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Payment risk queue
          </Link>
          <Link
            href="/admin/fraud"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Fraud overview
          </Link>
          <Link
            href="/admin/alerts"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Alerts
          </Link>
          <Link
            href="/admin/system"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            System health
          </Link>
          <Link
            href="/admin/audit"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Audit log
          </Link>
          <Link
            href="/admin/access"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            Admin access
          </Link>
          <Link
            href="/admin/branding"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            SaaS branding
          </Link>
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 text-[#D1D5DB] hover:bg-[#1A1D2E] hover:text-[#F3F4F6]"
          >
            ← Back to merchant
          </Link>
        </nav>
        <div className="border-t border-[rgba(209,213,219,0.08)] px-5 py-3 text-xs text-[#6B7280]">
          Signed in as {session.user?.email}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
      <Toaster />
    </div>
    </Providers>
  );
}
