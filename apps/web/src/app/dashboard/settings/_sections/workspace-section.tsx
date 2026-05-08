"use client";

/**
 * Workspace (business profile) section.
 *
 * Extracted verbatim from the old `<ProfileSection>` in the
 * 1,282-line settings monolith. Logic preserved 1:1 — same tRPC
 * procedures (`merchants.getProfile`, `merchants.updateProfile`,
 * `merchants.sendTestSms`), same dirty-tracking, same
 * payload-building (only changed fields are sent), same disabled
 * email + member-since rows.
 *
 * What's different:
 *   - Wraps content in `<SettingsSection>` instead of an inline
 *     Card-with-icon-tile, so spacing rhythm matches every other
 *     section (audit P1-6, P1-7).
 *   - Uses the shared `<FormField>` and `<FormError>` primitives
 *     (audit P2-1).
 *   - Footer messaging now reads "Changes save immediately, are
 *     encrypted at rest." — same intent, calmer tone.
 *
 * What's NOT changed:
 *   - The tRPC mutation contract.
 *   - The `<TestSmsButton>` three-state disable logic (preserved as
 *     an internal helper because it's settings-specific).
 *   - The legacy "Member since" + "Email (disabled)" panels.
 */
import { useEffect, useState } from "react";
import {
  Building2,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react";
import {
  MERCHANT_COUNTRIES,
  MERCHANT_LANGUAGES,
  type MerchantCountry,
  type MerchantLanguage,
} from "@ecom/types";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection } from "@/components/settings/section";
import { FormField, FormError } from "@/components/settings/form-field";

const COUNTRY_LABELS: Record<MerchantCountry, string> = {
  BD: "Bangladesh",
  PK: "Pakistan",
  IN: "India",
  LK: "Sri Lanka",
  NP: "Nepal",
  ID: "Indonesia",
  PH: "Philippines",
  VN: "Vietnam",
  MY: "Malaysia",
  TH: "Thailand",
};
const COUNTRIES = MERCHANT_COUNTRIES.map((code) => ({
  code,
  label: COUNTRY_LABELS[code],
}));

const LANGUAGE_LABELS: Record<MerchantLanguage, string> = {
  en: "English",
  bn: "বাংলা",
  ur: "اردو",
  hi: "हिन्दी",
  ta: "தமிழ்",
  id: "Bahasa Indonesia",
  th: "ไทย",
  vi: "Tiếng Việt",
  ms: "Bahasa Melayu",
};
const LANGUAGES = MERCHANT_LANGUAGES.map((code) => ({
  code,
  label: LANGUAGE_LABELS[code],
}));

export function WorkspaceSection() {
  const utils = trpc.useUtils();
  const profile = trpc.merchants.getProfile.useQuery();
  const mutation = trpc.merchants.updateProfile.useMutation({
    onSuccess: () => {
      void utils.merchants.getProfile.invalidate();
    },
  });

  const [businessName, setBusinessName] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("BD");
  const [language, setLanguage] = useState("en");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!profile.data) return;
    setBusinessName(profile.data.businessName ?? "");
    setPhone(profile.data.phone ?? "");
    setCountry(profile.data.country ?? "BD");
    setLanguage(profile.data.language ?? "en");
    setTouched(false);
  }, [profile.data]);

  const canSubmit =
    touched &&
    businessName.trim().length > 0 &&
    !mutation.isLoading &&
    !profile.isLoading;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !profile.data) return;
    const payload: Record<string, unknown> = {};
    if (businessName !== profile.data.businessName)
      payload.businessName = businessName.trim();
    if (phone !== (profile.data.phone ?? "") && phone.trim())
      payload.phone = phone.trim();
    if (country !== profile.data.country) payload.country = country;
    if (language !== profile.data.language) payload.language = language;
    if (Object.keys(payload).length === 0) return;
    await mutation.mutateAsync(payload as never);
    setTouched(false);
  }

  const email = profile.data?.email ?? "";
  const createdAt = profile.data?.createdAt
    ? new Date(profile.data.createdAt).toLocaleDateString()
    : "—";

  return (
    <SettingsSection
      icon={Building2}
      title="Business profile"
      description="How your business appears across the platform — to customers, couriers, and our support team."
    >
      <form onSubmit={onSave} className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <FormField label="Business name" htmlFor="businessName" required>
            <Input
              id="businessName"
              value={businessName}
              onChange={(e) => {
                setBusinessName(e.target.value);
                setTouched(true);
              }}
              placeholder="Acme Electronics"
              maxLength={200}
              required
            />
          </FormField>
          <FormField
            label="Email"
            htmlFor="email"
            hint="Contact support to change this."
          >
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
              <Input
                id="email"
                value={email}
                disabled
                className="pl-9 disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>
          </FormField>
          <FormField
            label="Phone"
            htmlFor="phone"
            hint="International format, e.g. +8801712345678"
          >
            <div className="relative">
              <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
              <Input
                id="phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setTouched(true);
                }}
                inputMode="tel"
                placeholder="+8801712345678"
                className="pl-9"
              />
            </div>
            <TestSmsButton
              phoneOnFile={profile.data?.phone ?? null}
              phoneInForm={phone}
              dirty={touched}
            />
          </FormField>
          <FormField label="Member since" htmlFor="createdAt">
            <Input
              id="createdAt"
              value={createdAt}
              disabled
              className="disabled:opacity-70"
            />
          </FormField>
          <FormField label="Country" htmlFor="country">
            <Select
              value={country}
              onValueChange={(v) => {
                setCountry(v);
                setTouched(true);
              }}
            >
              <SelectTrigger id="country">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Language" htmlFor="language">
            <Select
              value={language}
              onValueChange={(v) => {
                setLanguage(v);
                setTouched(true);
              }}
            >
              <SelectTrigger id="language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        {mutation.error ? <FormError message={mutation.error.message} /> : null}

        <div className="flex flex-col-reverse gap-3 border-t border-stroke/8 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-fg-faint">
            Changes are encrypted at rest and saved immediately.
          </p>
          <Button
            type="submit"
            disabled={!canSubmit}
            className="bg-brand text-white hover:bg-brand-hover sm:w-auto"
          >
            {mutation.isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Save changes
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

/**
 * "Send test SMS" affordance — proves end-to-end pipeline (provider creds →
 * carrier delivery) for the merchant before they trust automated SMS for
 * order confirmations. Disabled when the form has unsaved phone changes,
 * since the test sends to whatever's persisted, not what's typed.
 *
 * Preserved verbatim from the original monolith.
 */
function TestSmsButton({
  phoneOnFile,
  phoneInForm,
  dirty,
}: {
  phoneOnFile: string | null;
  phoneInForm: string;
  dirty: boolean;
}) {
  const phoneChanged = phoneInForm !== (phoneOnFile ?? "");
  const disabledReason = !phoneOnFile
    ? "Add and save a phone number first."
    : phoneChanged && dirty
      ? "Save your phone change first, then test."
      : null;
  const mutation = trpc.merchants.sendTestSms.useMutation({
    onSuccess: (data) => {
      toast.success(`Test SMS sent to ••••${data.phoneSuffix}`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-stroke/8 bg-bg-subtle px-3 py-2 text-xs">
      <span className="text-fg-faint">
        Verify your number receives messages from us.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={mutation.isPending || disabledReason !== null}
        title={disabledReason ?? undefined}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Sending…
          </>
        ) : (
          <>
            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
            Send test SMS
          </>
        )}
      </Button>
    </div>
  );
}
