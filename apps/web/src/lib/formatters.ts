export function formatBDT(n: number | undefined | null): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `৳ ${value.toLocaleString()}`;
}

export function formatNumber(n: number | undefined | null): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return value.toLocaleString();
}

export function formatPercent(n: number | undefined | null, digits = 1): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${value.toFixed(digits)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function formatRelative(iso: string | Date | undefined | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Math.max(0, Date.now() - d.getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

/**
 * Same as formatRelative, but lets the caller pick the empty-state
 * copy instead of bare "—". Use this anywhere the merchant might see
 * "—" right after a confidence-building action (Connect, Save,
 * Upload) — a literal em-dash there reads as broken even though the
 * value just hasn't arrived yet.
 */
export function formatRelativeOr(
  iso: string | Date | undefined | null,
  fallback: string,
): string {
  if (!iso) return fallback;
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return fallback;
  return formatRelative(d);
}

/**
 * Smart "Last sync" label for integrations / connectors. Chooses
 * between three states depending on what data is actually available:
 *   - Has lastSyncAt          → "Last sync: 5m ago"
 *   - No lastSyncAt yet, just
 *     connected (< 5 min)     → "Just connected · syncing soon"
 *   - No lastSyncAt, older    → "Awaiting first sync"
 *
 * Pass the connectedAt timestamp so a freshly-installed integration
 * doesn't read like a broken one.
 */
export function formatLastSync(
  lastSyncAt: string | Date | null | undefined,
  connectedAt?: string | Date | null,
): string {
  if (lastSyncAt) return `Last sync: ${formatRelative(lastSyncAt)}`;
  if (connectedAt) {
    const c = typeof connectedAt === "string" ? new Date(connectedAt) : connectedAt;
    if (!Number.isNaN(c.getTime())) {
      const ageMs = Date.now() - c.getTime();
      if (ageMs >= 0 && ageMs < 5 * 60_000) {
        return "Just connected · syncing soon";
      }
    }
  }
  return "Awaiting first sync";
}

export function formatDate(iso: string | Date | undefined | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string | Date | undefined | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initialsFromLabel(label: string | undefined | null): string {
  if (!label) return "M";
  const cleaned = label.trim().replace(/@.*$/, "");
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return cleaned.slice(0, 2).toUpperCase() || "M";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase() || "M";
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() || "M";
}
