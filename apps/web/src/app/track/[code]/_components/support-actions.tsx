import { STRINGS, type Lang } from "../_lib/i18n";

interface SupportActionsProps {
  supportPhone?: string;
  supportEmail?: string;
  primaryColor?: string | null;
  lang?: Lang;
}

export function SupportActions({
  supportPhone,
  supportEmail,
  primaryColor,
  lang = "bn",
}: SupportActionsProps) {
  if (!supportPhone && !supportEmail) return null;
  const accent = primaryColor ?? "#0f172a";
  const t = STRINGS[lang];

  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
        {t.needHelp}
      </h2>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {supportPhone ? (
          <a
            href={`tel:${supportPhone.replace(/[^+\d]/g, "")}`}
            className="inline-flex flex-1 items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:opacity-90"
            style={{ backgroundColor: accent }}
          >
            {t.callMerchant}
          </a>
        ) : null}
        {supportEmail ? (
          <a
            href={`mailto:${supportEmail}`}
            className="inline-flex flex-1 items-center justify-center rounded-md border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            {t.contactSupport}
          </a>
        ) : null}
      </div>
    </div>
  );
}
