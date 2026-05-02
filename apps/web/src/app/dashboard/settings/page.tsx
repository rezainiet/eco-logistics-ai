"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Key,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  Palette,
  Pencil,
  Phone,
  ShieldCheck,
  Truck,
  User as UserIcon,
  X,
} from "lucide-react";
import { AutomationModePicker } from "@/components/automation/automation-mode-picker";
import { BrandingSection } from "@/components/branding/branding-section";
import {
  MERCHANT_COUNTRIES,
  MERCHANT_LANGUAGES,
  type MerchantCountry,
  type MerchantLanguage,
} from "@ecom/types";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Codes come from @ecom/types (shared with the API and DB); labels are
// UI-only metadata. Using `Record<MerchantCountry, string>` forces TypeScript
// to error if a new code is added upstream and we forget to add a label.
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

const COURIER_PROVIDERS = [
  { id: "pathao", label: "Pathao", needsSecret: true, docs: "https://merchant.pathao.com/" },
  { id: "steadfast", label: "Steadfast", needsSecret: true, docs: "https://www.steadfast.com.bd/" },
  { id: "redx", label: "RedX", needsSecret: false, docs: "https://redx.com.bd/" },
  { id: "ecourier", label: "eCourier", needsSecret: true, docs: "https://ecourier.com.bd/" },
  { id: "paperfly", label: "Paperfly", needsSecret: true, docs: "https://paperfly.com.bd/" },
  { id: "other", label: "Other", needsSecret: false, docs: "" },
] as const;

type CourierId = (typeof COURIER_PROVIDERS)[number]["id"];

type TabKey = "profile" | "branding" | "couriers" | "automation" | "security" | "billing";

const TABS: Array<{ key: TabKey; label: string; icon: typeof UserIcon }> = [
  { key: "profile", label: "Profile", icon: UserIcon },
  { key: "branding", label: "Branding", icon: Palette },
  { key: "couriers", label: "Couriers", icon: Truck },
  { key: "automation", label: "Automation", icon: Bot },
  { key: "security", label: "Security", icon: Lock },
  { key: "billing", label: "Billing", icon: CreditCard },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>("profile");

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Settings</h1>
        <p className="text-sm text-fg-subtle">
          Manage your business profile, courier credentials, and billing.
        </p>
      </header>

      <nav
        className="flex gap-1 rounded-lg border border-stroke/8 bg-surface-overlay p-1"
        role="tablist"
        aria-label="Settings sections"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-surface text-fg shadow-[0_1px_3px_0_rgba(0,0,0,0.2)]"
                  : "text-fg-subtle hover:text-fg"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "profile" && <ProfileSection />}
      {tab === "branding" && <BrandingSection />}
      {tab === "couriers" && <CouriersSection />}
      {tab === "automation" && <AutomationModePicker />}
      {tab === "security" && <SecuritySection />}
      {tab === "billing" && <BillingSection />}
    </div>
  );
}

/* ─────────────────────────────── Profile ─────────────────────────────── */

function ProfileSection() {
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
    touched && businessName.trim().length > 0 && !mutation.isLoading && !profile.isLoading;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !profile.data) return;
    const payload: Record<string, unknown> = {};
    if (businessName !== profile.data.businessName) payload.businessName = businessName.trim();
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
    <Card className="border-stroke/10 bg-surface text-fg">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/14">
            <Building2 className="h-5 w-5 text-brand" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg font-semibold">Business profile</CardTitle>
            <CardDescription className="text-fg-subtle">
              How your business appears across the platform.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSave} className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Business name" htmlFor="businessName" required>
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
            </Field>
            <Field label="Email" htmlFor="email" hint="Contact support to change this.">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
                <Input
                  id="email"
                  value={email}
                  disabled
                  className="pl-9 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
            </Field>
            <Field label="Phone" htmlFor="phone" hint="International format, e.g. +8801712345678">
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
            </Field>
            <Field label="Member since" htmlFor="createdAt">
              <Input id="createdAt" value={createdAt} disabled className="disabled:opacity-70" />
            </Field>
            <Field label="Country" htmlFor="country">
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
            </Field>
            <Field label="Language" htmlFor="language">
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
            </Field>
          </div>

          {mutation.error && (
            <FormError message={mutation.error.message} />
          )}

          <div className="flex items-center justify-between border-t border-stroke/8 pt-4">
            <p className="text-xs text-fg-faint">Changes are encrypted and saved immediately.</p>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-brand text-white hover:bg-brand-hover"
            >
              {mutation.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────── Couriers ─────────────────────────────── */

function CouriersSection() {
  const utils = trpc.useUtils();
  const couriers = trpc.merchants.getCouriers.useQuery();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CourierId | null>(null);

  const configured = couriers.data ?? [];
  const configuredIds = new Set(configured.map((c) => c.name));

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(id: CourierId) {
    setEditing(id);
    setOpen(true);
  }

  const editingCourier =
    editing != null ? configured.find((c) => c.name === editing) ?? null : null;

  return (
    <Card className="border-stroke/10 bg-surface text-fg">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-subtle">
            <Truck className="h-5 w-5 text-success" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Courier credentials</CardTitle>
            <CardDescription className="text-fg-subtle">
              Keys are encrypted with AES-256-GCM before they touch the database.
            </CardDescription>
          </div>
        </div>
        <Button
          onClick={openNew}
          className="bg-brand text-white hover:bg-brand-hover"
        >
          Add courier
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {couriers.isLoading && (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-md border border-stroke/6 bg-white/5"
              />
            ))}
          </div>
        )}
        {!couriers.isLoading && configured.length === 0 && (
          <EmptyState
            icon={Truck}
            title="No couriers connected yet"
            description="Add Pathao or Steadfast credentials to start booking pickups and pulling tracking events."
            cta={
              <Button onClick={openNew} className="bg-brand text-white hover:bg-brand-hover">
                Connect first courier
              </Button>
            }
          />
        )}
        {configured.map((c) => {
          const meta = COURIER_PROVIDERS.find((p) => p.id === c.name);
          return (
            <div
              key={c.name}
              className="flex flex-col gap-3 rounded-lg border border-stroke/8 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-md bg-surface-overlay text-xs font-bold uppercase text-brand">
                  {(meta?.label ?? c.name).slice(0, 2)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg">
                      {meta?.label ?? c.name}
                    </span>
                    {c.enabled ? (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-success-subtle text-success"
                      >
                        Enabled
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-surface-raised text-fg-muted"
                      >
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
                    <span className="inline-flex items-center gap-1.5">
                      <Key className="h-3 w-3" />
                      {c.apiKeyMasked || "••••"}
                    </span>
                    <span>Account: {c.accountId}</span>
                    {c.preferredDistricts.length > 0 && (
                      <span>
                        {c.preferredDistricts.length} preferred district
                        {c.preferredDistricts.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {c.validationError && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-danger">
                      <AlertCircle className="h-3 w-3" /> {c.validationError}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEdit(c.name as CourierId)}
                  className="border-stroke/14 bg-surface-overlay text-fg-muted hover:bg-surface"
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
                <RemoveCourierButton
                  name={c.name as CourierId}
                  onRemoved={() => void utils.merchants.getCouriers.invalidate()}
                />
              </div>
            </div>
          );
        })}
      </CardContent>

      <CourierDialog
        open={open}
        onOpenChange={setOpen}
        existingIds={configuredIds}
        editingCourier={editingCourier}
        onSaved={() => {
          setOpen(false);
          void utils.merchants.getCouriers.invalidate();
        }}
      />
    </Card>
  );
}

function RemoveCourierButton({
  name,
  onRemoved,
}: {
  name: CourierId;
  onRemoved: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const mutation = trpc.merchants.removeCourier.useMutation({
    onSuccess: () => {
      setConfirm(false);
      onRemoved();
    },
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirm(true)}
        className="border-danger/25 bg-danger/6 text-danger hover:bg-danger/14"
      >
        <X className="mr-1.5 h-3.5 w-3.5" />
        Remove
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="border border-stroke/14 bg-surface text-fg">
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription className="text-fg-subtle">
              Stored credentials will be deleted. Past orders remain untouched.
            </DialogDescription>
          </DialogHeader>
          {mutation.error && <FormError message={mutation.error.message} />}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(false)}
              className="border-stroke/14 bg-surface-overlay text-fg-muted hover:bg-surface-hover"
            >
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate({ name })}
              disabled={mutation.isLoading}
              className="bg-danger text-white hover:bg-danger/90"
            >
              {mutation.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove courier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CourierDialog({
  open,
  onOpenChange,
  existingIds,
  editingCourier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: Set<string>;
  editingCourier: {
    name: string;
    accountId: string;
    preferredDistricts: string[];
    enabled: boolean;
    baseUrl: string | null;
  } | null;
  onSaved: () => void;
}) {
  const mutation = trpc.merchants.upsertCourier.useMutation({ onSuccess: onSaved });

  const [provider, setProvider] = useState<CourierId>("pathao");
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [districts, setDistricts] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editingCourier) {
      setProvider(editingCourier.name as CourierId);
      setAccountId(editingCourier.accountId);
      setApiKey("");
      setApiSecret("");
      setBaseUrl(editingCourier.baseUrl ?? "");
      setDistricts(editingCourier.preferredDistricts.join(", "));
    } else {
      const firstAvailable = (COURIER_PROVIDERS.find((p) => !existingIds.has(p.id))?.id ??
        "pathao") as CourierId;
      setProvider(firstAvailable);
      setAccountId("");
      setApiKey("");
      setApiSecret("");
      setBaseUrl("");
      setDistricts("");
    }
  }, [open, editingCourier, existingIds]);

  const providerMeta = COURIER_PROVIDERS.find((p) => p.id === provider);
  const isEdit = !!editingCourier;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId.trim() || !apiKey.trim()) return;
    await mutation.mutateAsync({
      name: provider,
      accountId: accountId.trim(),
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim() ? apiSecret.trim() : undefined,
      baseUrl: baseUrl.trim() ? baseUrl.trim() : undefined,
      preferredDistricts: districts
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-stroke/14 bg-surface text-fg sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit courier" : "Connect courier"}</DialogTitle>
          <DialogDescription className="text-fg-subtle">
            Credentials are encrypted before storage. We never log raw API keys.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Provider" htmlFor="provider">
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as CourierId)}
              disabled={isEdit}
            >
              <SelectTrigger id="provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COURIER_PROVIDERS.map((p) => {
                  const used = existingIds.has(p.id) && p.id !== editingCourier?.name;
                  return (
                    <SelectItem key={p.id} value={p.id} disabled={used}>
                      {p.label}
                      {used ? " (already connected)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {providerMeta?.docs && (
              <a
                href={providerMeta.docs}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                {providerMeta.label} merchant portal <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Field>

          <Field label="Account / Merchant ID" htmlFor="accountId" required>
            <Input
              id="accountId"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="e.g. 23019"
              maxLength={200}
              required
            />
          </Field>

          <Field
            label={isEdit ? "New API key" : "API key"}
            htmlFor="apiKey"
            hint={
              isEdit
                ? "Re-enter your key to rotate it. Leave current values untouched by cancelling."
                : "We encrypt this with AES-256-GCM."
            }
            required
          >
            <Input
              id="apiKey"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••••"
              required
              minLength={4}
              maxLength={500}
            />
          </Field>

          {providerMeta?.needsSecret && (
            <Field
              label="API secret"
              htmlFor="apiSecret"
              hint="Required by some providers (e.g. Pathao client secret)."
            >
              <Input
                id="apiSecret"
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="••••••••••"
                maxLength={500}
              />
            </Field>
          )}

          <Field
            label="Base URL (optional)"
            htmlFor="baseUrl"
            hint="Override the provider endpoint for sandbox or regional servers."
          >
            <Input
              id="baseUrl"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api-hermes.pathao.com"
              inputMode="url"
              maxLength={300}
            />
          </Field>

          <Field
            label="Preferred districts"
            htmlFor="districts"
            hint="Comma-separated. Used by the courier router to match orders."
          >
            <Input
              id="districts"
              value={districts}
              onChange={(e) => setDistricts(e.target.value)}
              placeholder="Dhaka, Chattogram, Sylhet"
            />
          </Field>

          {mutation.error && <FormError message={mutation.error.message} />}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-stroke/14 bg-surface-overlay text-fg-muted hover:bg-surface-hover"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isLoading || !accountId.trim() || !apiKey.trim()}
              className="bg-brand text-white hover:bg-brand-hover"
            >
              {mutation.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? "Update credentials" : "Save courier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────── Security ─────────────────────────────── */

function SecuritySection() {
  const profile = trpc.merchants.getProfile.useQuery();
  const utils = trpc.useUtils();
  const change = trpc.merchants.changePassword.useMutation({
    onSuccess: () => {
      toast.success("Password updated", "Use the new password next time you sign in.");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (err) => toast.error("Couldn't change password", err.message),
  });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = !!confirm && next !== confirm;
  const tooShort = !!next && next.length < 8;
  const sameAsOld = !!current && !!next && current === next;
  const canSubmit = !!current && !!next && !!confirm && !mismatch && !tooShort && !sameAsOld;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    await change.mutateAsync({ currentPassword: current, newPassword: next });
  }

  async function onResendVerify() {
    if (!profile.data?.email) return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const res = await fetch(`${apiUrl}/auth/resend-verification`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: profile.data.email }),
    });
    if (res.ok) {
      toast.success("Verification email sent", "Check your inbox.");
      void utils.merchants.getProfile.invalidate();
    } else {
      toast.error("Couldn't resend", "Please try again in a moment.");
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/14">
              <Lock className="h-5 w-5 text-brand" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg font-semibold">Change password</CardTitle>
              <CardDescription className="text-fg-subtle">
                Re-enter your current password, then choose a new one.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Current password" htmlFor="currentPassword" required>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="••••••••"
                required
              />
            </Field>
            <Field
              label="New password"
              htmlFor="newPassword"
              hint="At least 8 characters. A passphrase you'll remember works best."
              required
            >
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
              {tooShort && <p className="mt-1 text-xs text-danger">At least 8 characters.</p>}
              {sameAsOld && (
                <p className="mt-1 text-xs text-danger">New password must be different.</p>
              )}
            </Field>
            <Field label="Confirm new password" htmlFor="confirmPassword" required>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat the new password"
                required
              />
              {mismatch && <p className="mt-1 text-xs text-danger">Passwords do not match.</p>}
            </Field>
            {change.error && <FormError message={change.error.message} />}
            <div className="flex items-center justify-end border-t border-stroke/8 pt-4">
              <Button
                type="submit"
                disabled={!canSubmit || change.isLoading}
                className="bg-brand text-white hover:bg-brand-hover"
              >
                {change.isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-subtle">
              <Mail className="h-5 w-5 text-success" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg font-semibold">Email verification</CardTitle>
              <CardDescription className="text-fg-subtle">
                {profile.data?.emailVerified
                  ? "Your email is verified — you'll receive billing receipts and trial reminders."
                  : "Confirm your email so we can send billing receipts and trial reminders."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-fg-muted">{profile.data?.email ?? "—"}</span>
          {profile.data?.emailVerified ? (
            <Badge
              variant="outline"
              className="border-transparent bg-success-subtle text-success"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" /> Verified
            </Badge>
          ) : (
            <>
              <Badge
                variant="outline"
                className="border-transparent bg-warning-subtle text-warning"
              >
                Not verified
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResendVerify}
                className="ml-auto"
              >
                Resend verification
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─────────────────────────────── Billing ─────────────────────────────── */

function BillingSection() {
  const profile = trpc.merchants.getProfile.useQuery();
  const billing = profile.data?.billing;

  const statusBadge = useMemo(() => {
    const s = billing?.status ?? "trial";
    if (s === "active")
      return {
        icon: CheckCircle2,
        label: "Active",
        className: "bg-success-subtle text-success",
      };
    if (s === "trial")
      return {
        icon: Clock,
        label: "Trial",
        className: "bg-warning-subtle text-warning",
      };
    if (s === "past_due")
      return {
        icon: AlertCircle,
        label: "Past due",
        className: "bg-danger/14 text-danger",
      };
    return {
      icon: AlertCircle,
      label: s.replace("_", " "),
      className: "bg-surface-raised text-fg-muted",
    };
  }, [billing?.status]);

  const currency = profile.data?.country === "BD" ? "৳" : "$";
  const trialEndsAtLabel = billing?.trialEndsAt
    ? new Date(billing.trialEndsAt).toLocaleDateString()
    : null;

  return (
    <Card className="border-stroke/10 bg-surface text-fg">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(262_83%_62%/0.14)]">
            <CreditCard className="h-5 w-5 text-[hsl(262_83%_72%)]" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Plan & billing</CardTitle>
            <CardDescription className="text-fg-subtle">
              Your subscription status and trial information.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {profile.isLoading && <div className="h-28 animate-pulse rounded-md bg-white/5" />}

        {billing && (
          <>
            <div className="flex flex-col gap-4 rounded-lg border border-stroke/8 bg-white/5 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.4px] text-fg-subtle">
                    Current plan
                  </span>
                  <Badge
                    variant="outline"
                    className={`border-transparent ${statusBadge.className}`}
                  >
                    <statusBadge.icon className="mr-1 h-3 w-3" />
                    {statusBadge.label}
                  </Badge>
                </div>
                <p className="mt-2 text-2xl font-semibold capitalize text-fg">
                  {billing.tier}
                </p>
                <p className="text-sm text-fg-subtle">
                  {currency}
                  {billing.rate.toLocaleString()} / month
                </p>
              </div>
              <div className="text-right">
                {billing.status === "trial" && trialEndsAtLabel && (
                  <>
                    <p className="text-xs uppercase tracking-[0.4px] text-fg-subtle">
                      Trial ends
                    </p>
                    <p className="mt-1 text-lg font-semibold text-fg">
                      {trialEndsAtLabel}
                    </p>
                    <p className="mt-1 text-sm text-warning">
                      {billing.trialExpired
                        ? "Expired — upgrade to continue"
                        : billing.trialDaysLeft === null
                        ? null
                        : `${billing.trialDaysLeft} day${
                            billing.trialDaysLeft === 1 ? "" : "s"
                          } left`}
                    </p>
                  </>
                )}
                {billing.status === "active" && billing.activatedAt && (
                  <>
                    <p className="text-xs uppercase tracking-[0.4px] text-fg-subtle">
                      Activated
                    </p>
                    <p className="mt-1 text-lg font-semibold text-fg">
                      {new Date(billing.activatedAt).toLocaleDateString()}
                    </p>
                  </>
                )}
              </div>
            </div>

            {(billing.status === "trial" || billing.status === "past_due") && (
              <div className="rounded-lg border border-brand/25 bg-brand/8 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                  <div className="flex-1">
                    <p className="font-medium text-fg">
                      Ready to continue past the trial?
                    </p>
                    <p className="mt-1 text-sm text-fg-subtle">
                      Pay via bKash / Nagad and message us the transaction ID on WhatsApp — your
                      account is activated within minutes.
                    </p>
                    <Button
                      asChild
                      className="mt-3 bg-brand text-white hover:bg-brand-hover"
                    >
                      <a
                        href="https://wa.me/8801700000000"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Message billing on WhatsApp
                        <ExternalLink className="ml-2 h-3.5 w-3.5" />
                      </a>
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <BillingFactsGrid billing={billing} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BillingFactsGrid({
  billing,
}: {
  billing: {
    startDate: string | Date | null;
    activatedAt: string | Date | null;
    trialEndsAt: string | Date | null;
    status: string;
  };
}) {
  const facts = [
    {
      label: "Joined",
      value: billing.startDate ? new Date(billing.startDate).toLocaleDateString() : "—",
    },
    {
      label: "Activated",
      value: billing.activatedAt
        ? new Date(billing.activatedAt).toLocaleDateString()
        : "—",
    },
    {
      label: "Trial ends",
      value: billing.trialEndsAt
        ? new Date(billing.trialEndsAt).toLocaleDateString()
        : "—",
    },
    { label: "Status", value: billing.status.replace("_", " ") },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {facts.map((f) => (
        <div
          key={f.label}
          className="rounded-md border border-stroke/8 bg-white/5 px-3 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.4px] text-fg-faint">
            {f.label}
          </p>
          <p className="mt-1 text-sm text-fg capitalize">{f.value}</p>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────── Shared bits ─────────────────────────────── */

function Field({
  label,
  htmlFor,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-fg-muted">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-fg-faint">{hint}</p>}
    </div>
  );
}

/**
 * "Send test SMS" affordance — proves end-to-end pipeline (provider creds →
 * carrier delivery) for the merchant before they trust automated SMS for
 * order confirmations. Disabled when the form has unsaved phone changes,
 * since the test sends to whatever's persisted, not what's typed.
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

function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/8 px-3 py-2 text-sm text-danger"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  cta,
}: {
  icon: typeof Truck;
  title: string;
  description: string;
  cta?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stroke/12 px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-subtle">
        <Icon className="h-5 w-5 text-brand" />
      </div>
      <div>
        <p className="font-medium text-fg">{title}</p>
        <p className="mt-1 text-sm text-fg-subtle">{description}</p>
      </div>
      {cta}
    </div>
  );
}
