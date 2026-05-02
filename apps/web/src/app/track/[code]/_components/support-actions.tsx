interface SupportActionsProps {
  supportPhone?: string;
  supportEmail?: string;
  primaryColor?: string | null;
}

export function SupportActions({ supportPhone, supportEmail, primaryColor }: SupportActionsProps) {
  if (!supportPhone && !supportEmail) return null;
  const accent = primaryColor ?? "#0f172a";

  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
      {supportPhone ? (
        <a
          href={`tel:${supportPhone.replace(/[^+\d]/g, "")}`}
          className="inline-flex flex-1 items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          📞 Call merchant
        </a>
      ) : null}
      {supportEmail ? (
        <a
          href={`mailto:${supportEmail}`}
          className="inline-flex flex-1 items-center justify-center rounded-md border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          ✉️ Contact support
        </a>
      ) : null}
    </div>
  );
}
