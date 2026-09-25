export const metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

/** Unknown host, unpublished, archived or malformed — all look the same. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-center text-neutral-800">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-neutral-400">404</p>
        <h1 className="mt-2 text-2xl font-bold">This page isn&apos;t available</h1>
        <p className="mt-2 text-neutral-500">Check the address, or contact the business that shared it with you.</p>
      </div>
    </main>
  );
}
