import { safeHttpsUrl } from "../_lib/status";

interface MerchantHeaderProps {
  displayName: string;
  logoUrl?: string;
  /** Hex color, already sanitized. */
  primaryColor?: string | null;
}

export function MerchantHeader({ displayName, logoUrl, primaryColor }: MerchantHeaderProps) {
  const safeLogo = safeHttpsUrl(logoUrl);
  const accent = primaryColor ?? undefined;
  return (
    <header className="flex items-center gap-3">
      {safeLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={safeLogo}
          alt={`${displayName} logo`}
          className="h-10 w-10 rounded-md object-cover"
          loading="eager"
        />
      ) : (
        <div
          className="flex h-10 w-10 items-center justify-center rounded-md text-sm font-semibold text-white"
          style={{ backgroundColor: accent ?? "#0f172a" }}
          aria-hidden
        >
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div>
        <p className="text-xs uppercase tracking-wider text-gray-400">Order from</p>
        <p className="text-base font-semibold text-gray-900">{displayName}</p>
      </div>
    </header>
  );
}
