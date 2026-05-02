import Link from "next/link";

interface NotFoundProps {
  code: string;
}

export function NotFoundCard({ code }: NotFoundProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 py-10 text-center">
      <div className="text-6xl" aria-hidden>
        📦
      </div>
      <h1 className="mt-6 text-2xl font-semibold text-gray-900">
        We couldn't find that order
      </h1>
      <p className="mt-3 text-base text-gray-600">
        The tracking code{" "}
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm text-gray-800">
          {code}
        </span>{" "}
        doesn't match any order on our system.
      </p>
      <p className="mt-2 text-sm text-gray-500">
        Double-check the link from your message, or contact the merchant
        directly — they can re-send a working tracking link.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
      >
        Back to home
      </Link>
    </div>
  );
}
