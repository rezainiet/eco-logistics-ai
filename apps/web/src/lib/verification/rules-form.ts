/**
 * Verification-rules form ⇄ `merchants.getFraudConfig` / `updateFraudConfig`.
 * Pure helpers so parsing and "what changed" are testable without React.
 */

export interface FraudConfigView {
  highCodThreshold: number | null;
  extremeCodThreshold: number | null;
  suspiciousDistricts: string[];
  blockedPhones: string[];
  blockedAddresses: string[];
  velocityThreshold: number;
  velocityWindowMin: number;
  alertOnPendingReview: boolean;
}

export interface RulesForm {
  highCod: string;
  extremeCod: string;
  districts: string;
  phones: string;
  /** New addresses to block, one per line ("address, district" optional). */
  newAddresses: string;
  /** Drop the currently blocked (hashed) addresses. */
  clearAddresses: boolean;
  velocity: string;
  velocityWindow: string;
  alertOnPendingReview: boolean;
}

export function formFromConfig(c: FraudConfigView): RulesForm {
  return {
    highCod: c.highCodThreshold === null ? "" : String(c.highCodThreshold),
    extremeCod: c.extremeCodThreshold === null ? "" : String(c.extremeCodThreshold),
    districts: c.suspiciousDistricts.join("\n"),
    phones: c.blockedPhones.join("\n"),
    newAddresses: "",
    clearAddresses: false,
    velocity: String(c.velocityThreshold ?? 0),
    velocityWindow: String(c.velocityWindowMin ?? 10),
    alertOnPendingReview: c.alertOnPendingReview,
  };
}

/** One entry per line (commas also separate, except in addresses). */
export function splitList(raw: string, { commas = true }: { commas?: boolean } = {}): string[] {
  const parts = raw.split(commas ? /[\n,]/ : /\n/);
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}

export interface RulesPatch {
  highCodThreshold?: number | null;
  extremeCodThreshold?: number | null;
  suspiciousDistricts?: string[];
  blockedPhones?: string[];
  blockedAddresses?: string[];
  blockedAddressesRaw?: Array<{ address: string; district?: string }>;
  velocityThreshold?: number;
  velocityWindowMin?: number;
  alertOnPendingReview?: boolean;
}

export type FieldErrors = Partial<Record<keyof RulesForm, string>>;

function parseAmount(v: string): number | null | "invalid" {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n) : "invalid";
}

function parseInt0(v: string, min: number, max: number): number | "invalid" {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : "invalid";
}

/** Validate the form and return only the fields that differ from `base`. */
export function buildPatch(form: RulesForm, base: FraudConfigView): { patch: RulesPatch; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const patch: RulesPatch = {};

  const high = parseAmount(form.highCod);
  const extreme = parseAmount(form.extremeCod);
  if (high === "invalid") errors.highCod = "Enter an amount in BDT, or leave empty for automatic.";
  if (extreme === "invalid") errors.extremeCod = "Enter an amount in BDT, or leave empty for automatic.";
  if (typeof high === "number" && typeof extreme === "number" && extreme <= high) {
    errors.extremeCod = "Must be higher than the high-value amount.";
  }
  if (high !== "invalid" && high !== base.highCodThreshold) patch.highCodThreshold = high;
  if (extreme !== "invalid" && extreme !== base.extremeCodThreshold) patch.extremeCodThreshold = extreme;

  const districts = splitList(form.districts);
  if (districts.join("|") !== base.suspiciousDistricts.join("|")) patch.suspiciousDistricts = districts;

  const phones = splitList(form.phones);
  const badPhone = phones.find((p) => p.replace(/\D+/g, "").length < 6);
  if (badPhone) errors.phones = `"${badPhone}" doesn't look like a phone number.`;
  const phoneDigits = phones.map((p) => p.replace(/\D+/g, ""));
  if (!badPhone && phoneDigits.join("|") !== base.blockedPhones.join("|")) patch.blockedPhones = phones;

  const raw = splitList(form.newAddresses, { commas: false }).map((line) => {
    const i = line.lastIndexOf(",");
    const address = (i > 0 ? line.slice(0, i) : line).trim();
    const district = i > 0 ? line.slice(i + 1).trim() : "";
    return district ? { address, district } : { address };
  });
  const shortAddr = raw.find((a) => a.address.length < 4);
  if (shortAddr) errors.newAddresses = `"${shortAddr.address}" is too short to be an address.`;
  if (!shortAddr && (raw.length > 0 || form.clearAddresses)) {
    patch.blockedAddresses = form.clearAddresses ? [] : base.blockedAddresses;
    if (raw.length > 0) patch.blockedAddressesRaw = raw;
  }

  const velocity = parseInt0(form.velocity, 0, 1000);
  const windowMin = parseInt0(form.velocityWindow, 1, 1440);
  if (velocity === "invalid") errors.velocity = "Whole number from 0 (off) to 1000.";
  if (windowMin === "invalid") errors.velocityWindow = "Whole number of minutes, 1–1440.";
  if (velocity !== "invalid" && velocity !== base.velocityThreshold) patch.velocityThreshold = velocity;
  if (windowMin !== "invalid" && windowMin !== base.velocityWindowMin) patch.velocityWindowMin = windowMin;

  if (form.alertOnPendingReview !== base.alertOnPendingReview) patch.alertOnPendingReview = form.alertOnPendingReview;

  return { patch, errors };
}
