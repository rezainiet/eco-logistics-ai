import Link from "next/link";

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-8 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(0,132,212,0.3)] bg-[rgba(0,132,212,0.08)] px-3 py-1 text-xs font-medium text-[#7FC7F2]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#0084D4]" />
          Logistics platform
        </span>
        <h1 className="text-5xl font-semibold tracking-tight text-[#F3F4F6] md:text-6xl">
          Ship faster.
          <br />
          <span className="text-[#0084D4]">With clarity.</span>
        </h1>
        <p className="max-w-md text-base text-[#9CA3AF]">
          Unified order, courier, and call-center operations for modern merchants.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-md bg-[#0084D4] px-5 text-sm font-medium text-white transition-colors hover:bg-[#0072BB]"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-10 items-center justify-center rounded-md border border-[rgba(209,213,219,0.15)] bg-[#1A1D2E] px-5 text-sm font-medium text-[#D1D5DB] transition-colors hover:border-[rgba(209,213,219,0.3)] hover:text-[#F3F4F6]"
          >
            Create account
          </Link>
        </div>
      </div>
    </main>
  );
}
