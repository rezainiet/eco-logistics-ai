"use client";

import { useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Key,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  Phone,
  ShieldCheck,
  Truck,
  User as UserIcon,
  X,
} from "lucide-react";
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

const COUNTRIES = [
  { code: "BD", label: "Bangladesh" },
  { code: "PK", label: "Pakistan" },
  { code: "IN", label: "India" },
  { code: "LK", label: "Sri Lanka" },
  { code: "NP", label: "Nepal" },
  { code: "ID", label: "Indonesia" },
  { code: "PH", label: "Philippines" },
  { code: "VN", label: "Vietnam" },
  { code: "MY", label: "Malaysia" },
  { code: "TH", label: "Thailand" },
] as const;

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "bn", label: "বাংলা" },
  { code: "ur", label: "اردو" },
  { code: "hi", label: "हिन्दी" },
  { code: "ta", label: "தமிழ்" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "th", label: "ไทย" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "ms", label: "Bahasa Melayu" },
] as const;

const COURIER_PROVIDERS = [
  { id: "pathao", label: "Pathao", needsSecret: true, docs: "https://merchant.pathao.com/" },
  { id: "steadfast", label: "Steadfast", needsSecret: false, docs: "https://www.steadfast.com.bd/" },
  { id: "redx", label: "RedX", needsSecret: false, docs: "https://redx.com.bd/" },
  { id: "ecourier", label: "eCourier", needsSecret: true, docs: "https://ecourier.com.bd/" },
  { id: "paperfly", label: "Paperfly", needsSecret: true, docs: "https://paperfly.com.bd/" },
  { id: "other", label: "Other", needsSecret: false, docs: "" },
] as const;

type CourierId = (typeof COURIER_PROVIDERS)[number]["id"];

type TabKey = "profile" | "couriers" | "billing";

const TABS: Array<{ key: TabKey; label: string; icon: typeof UserIcon }> = [
  { key: "profile", label: "Profile", icon: UserIcon },
  { key: "couriers", label: "Couriers", icon: Truck },
  { key: "billing", label: "Billing", icon: CreditCard },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>("profile");

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-[#F3F4F6]">Settings</h1>
        <p className="text-sm text-[#9CA3AF]">
          Manage your business profile, courier credentials, and billing.
        </p>
      </header>

      <nav
        className="flex gap-1 rounded-lg border border-[rgba(209,213,219,0.08)] bg-[#111318] p-1"
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
                  ? "bg-[#1A1D2E] text-[#F3F4F6] shadow-[0_1px_3px_0_rgba(0,0,0,0.2)]"
                  : "text-[#9CA3AF] hover:text-[#F3F4F6]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "profile" && <ProfileSection />}
      {tab === "couriers" && <CouriersSection />}
      {tab === "billing" && <BillingSection />}

      <DangerZone />
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
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(0,132,212,0.12)]">
            <Building2 className="h-5 w-5 text-[#0084D4]" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg font-semibold">Business profile</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
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
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6B7280]" />
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
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6B7280]" />
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

          <div className="flex items-center justify-between border-t border-[rgba(209,213,219,0.08)] pt-4">
            <p className="text-xs text-[#6B7280]">Changes are encrypted and saved immediately.</p>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-[#0084D4] text-white hover:bg-[#0072BB]"
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
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(16,185,129,0.12)]">
            <Truck className="h-5 w-5 text-[#10B981]" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Courier credentials</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Keys are encrypted with AES-256-GCM before they touch the database.
            </CardDescription>
          </div>
        </div>
        <Button
          onClick={openNew}
          className="bg-[#0084D4] text-white hover:bg-[#0072BB]"
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
                className="h-16 animate-pulse rounded-md border border-[rgba(209,213,219,0.06)] bg-[rgba(255,255,255,0.02)]"
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
              <Button onClick={openNew} className="bg-[#0084D4] text-white hover:bg-[#0072BB]">
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
              className="flex flex-col gap-3 rounded-lg border border-[rgba(209,213,219,0.08)] bg-[rgba(255,255,255,0.02)] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-md bg-[#111318] text-xs font-bold uppercase text-[#0084D4]">
                  {(meta?.label ?? c.name).slice(0, 2)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#F3F4F6]">
                      {meta?.label ?? c.name}
                    </span>
                    {c.enabled ? (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-[rgba(16,185,129,0.12)] text-[#34D399]"
                      >
                        Enabled
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]"
                      >
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#9CA3AF]">
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
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[#F87171]">
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
                  className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#D1D5DB] hover:bg-[#1A1D2E]"
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
        className="border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.06)] text-[#F87171] hover:bg-[rgba(239,68,68,0.12)]"
      >
        <X className="mr-1.5 h-3.5 w-3.5" />
        Remove
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="border border-[rgba(209,213,219,0.15)] bg-[#1A1D2E] text-[#F3F4F6]">
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription className="text-[#9CA3AF]">
              Stored credentials will be deleted. Past orders remain untouched.
            </DialogDescription>
          </DialogHeader>
          {mutation.error && <FormError message={mutation.error.message} />}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirm(false)}
              className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#D1D5DB] hover:bg-[#232738]"
            >
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate({ name })}
              disabled={mutation.isLoading}
              className="bg-[#EF4444] text-white hover:bg-[#DC2626]"
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
      <DialogContent className="border border-[rgba(209,213,219,0.15)] bg-[#1A1D2E] text-[#F3F4F6] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit courier" : "Connect courier"}</DialogTitle>
          <DialogDescription className="text-[#9CA3AF]">
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
                className="mt-1 inline-flex items-center gap-1 text-xs text-[#0084D4] hover:underline"
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
              className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#D1D5DB] hover:bg-[#232738]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isLoading || !accountId.trim() || !apiKey.trim()}
              className="bg-[#0084D4] text-white hover:bg-[#0072BB]"
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
        className: "bg-[rgba(16,185,129,0.12)] text-[#34D399]",
      };
    if (s === "trial")
      return {
        icon: Clock,
        label: "Trial",
        className: "bg-[rgba(245,158,11,0.12)] text-[#FBBF24]",
      };
    if (s === "past_due")
      return {
        icon: AlertCircle,
        label: "Past due",
        className: "bg-[rgba(239,68,68,0.12)] text-[#F87171]",
      };
    return {
      icon: AlertCircle,
      label: s.replace("_", " "),
      className: "bg-[rgba(156,163,175,0.15)] text-[#D1D5DB]",
    };
  }, [billing?.status]);

  const currency = profile.data?.country === "BD" ? "৳" : "$";
  const trialEndsAtLabel = billing?.trialEndsAt
    ? new Date(billing.trialEndsAt).toLocaleDateString()
    : null;

  return (
    <Card className="border-[rgba(209,213,219,0.1)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(139,92,246,0.12)]">
            <CreditCard className="h-5 w-5 text-[#8B5CF6]" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Plan & billing</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Your subscription status and trial information.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {profile.isLoading && <div className="h-28 animate-pulse rounded-md bg-[rgba(255,255,255,0.02)]" />}

        {billing && (
          <>
            <div className="flex flex-col gap-4 rounded-lg border border-[rgba(209,213,219,0.08)] bg-[rgba(255,255,255,0.02)] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.4px] text-[#9CA3AF]">
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
                <p className="mt-2 text-2xl font-semibold capitalize text-[#F3F4F6]">
                  {billing.tier}
                </p>
                <p className="text-sm text-[#9CA3AF]">
                  {currency}
                  {billing.rate.toLocaleString()} / month
                </p>
              </div>
              <div className="text-right">
                {billing.status === "trial" && trialEndsAtLabel && (
                  <>
                    <p className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">
                      Trial ends
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[#F3F4F6]">
                      {trialEndsAtLabel}
                    </p>
                    <p className="mt-1 text-sm text-[#FBBF24]">
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
                    <p className="text-xs uppercase tracking-[0.4px] text-[#9CA3AF]">
                      Activated
                    </p>
                    <p className="mt-1 text-lg font-semibold text-[#F3F4F6]">
                      {new Date(billing.activatedAt).toLocaleDateString()}
                    </p>
                  </>
                )}
              </div>
            </div>

            {(billing.status === "trial" || billing.status === "past_due") && (
              <div className="rounded-lg border border-[rgba(0,132,212,0.25)] bg-[rgba(0,132,212,0.08)] p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#0084D4]" />
                  <div className="flex-1">
                    <p className="font-medium text-[#F3F4F6]">
                      Ready to continue past the trial?
                    </p>
                    <p className="mt-1 text-sm text-[#9CA3AF]">
                      Pay via bKash / Nagad and message us the transaction ID on WhatsApp — your
                      account is activated within minutes.
                    </p>
                    <Button
                      asChild
                      className="mt-3 bg-[#0084D4] text-white hover:bg-[#0072BB]"
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
          className="rounded-md border border-[rgba(209,213,219,0.08)] bg-[rgba(255,255,255,0.02)] px-3 py-3"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.4px] text-[#6B7280]">
            {f.label}
          </p>
          <p className="mt-1 text-sm text-[#F3F4F6] capitalize">{f.value}</p>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────── Danger Zone ─────────────────────────────── */

function DangerZone() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-[rgba(239,68,68,0.15)] bg-[#1A1D2E] text-[#F3F4F6]">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(239,68,68,0.1)]">
            <LogOut className="h-5 w-5 text-[#F87171]" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Session</CardTitle>
            <CardDescription className="text-[#9CA3AF]">
              Sign out from this device. You can sign back in any time.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          className="border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.06)] text-[#F87171] hover:bg-[rgba(239,68,68,0.12)]"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border border-[rgba(209,213,219,0.15)] bg-[#1A1D2E] text-[#F3F4F6]">
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription className="text-[#9CA3AF]">
              You will be returned to the login page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="border-[rgba(209,213,219,0.15)] bg-[#111318] text-[#D1D5DB] hover:bg-[#232738]"
            >
              Stay signed in
            </Button>
            <Button
              onClick={() => void signOut({ callbackUrl: "/login" })}
              className="bg-[#EF4444] text-white hover:bg-[#DC2626]"
            >
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
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
      <Label htmlFor={htmlFor} className="text-[#D1D5DB]">
        {label}
        {required && <span className="ml-1 text-[#F87171]">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-[#6B7280]">{hint}</p>}
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm text-[#FCA5A5]"
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[rgba(209,213,219,0.12)] px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(0,132,212,0.1)]">
        <Icon className="h-5 w-5 text-[#0084D4]" />
      </div>
      <div>
        <p className="font-medium text-[#F3F4F6]">{title}</p>
        <p className="mt-1 text-sm text-[#9CA3AF]">{description}</p>
      </div>
      {cta}
    </div>
  );
}
