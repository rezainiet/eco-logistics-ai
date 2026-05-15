import Link from "next/link";
import { STRINGS, type Lang } from "../_lib/i18n";

interface NotFoundProps {
  code: string;
  lang?: Lang;
}

export function NotFoundCard({ code, lang = "bn" }: NotFoundProps) {
  const t = STRINGS[lang];
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 py-10 text-center">
      <div className="text-6xl" aria-hidden>
        📦
      </div>
      <h1 className="mt-6 text-2xl font-semibold text-gray-900">
        {t.notFoundTitle}
      </h1>
      <p className="mt-3 text-base text-gray-600">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm text-gray-800">
          {code}
        </span>{" "}
        — {t.notFoundBody}
      </p>
      <p className="mt-2 text-sm text-gray-500">{t.notFoundHint}</p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
      >
        {t.backHome}
      </Link>
    </div>
  );
}
