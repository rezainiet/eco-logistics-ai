"use client";

/**
 * Couriers section.
 *
 * Extracted verbatim from the old `<CouriersSection>` in the
 * 1,282-line settings monolith. Logic preserved 1:1 — same tRPC
 * procedures (`merchants.getCouriers`, `merchants.upsertCourier`,
 * `merchants.removeCourier`), same provider list, same encrypted-at-
 * rest messaging.
 *
 * What's different:
 *   - Wraps content in `<SettingsSection>` so spacing matches the
 *     other sections (audit P1-6).
 *   - Uses shared `<FormField>` / `<FormError>` (audit P2-1).
 *
 * What's NOT changed:
 *   - The COURIER_PROVIDERS list, validation, dialog flow.
 *   - The "Remove courier" two-step confirm gate.
 *   - The masked API key display + validation-error inline pattern.
 *     Per audit § 10, this is exactly the kind of operational detail
 *     the redesign wants more of, not less.
 */
import { useEffect, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Key,
  Loader2,
  Pencil,
  Truck,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const COURIER_PROVIDERS = [
  {
    id: "pathao",
    label: "Pathao",
    needsSecret: true,
    docs: "https://merchant.pathao.com/",
  },
  {
    id: "steadfast",
    label: "Steadfast",
    needsSecret: true,
    docs: "https://www.steadfast.com.bd/",
  },
  { id: "redx", label: "RedX", needsSecret: false, docs: "https://redx.com.bd/" },
  {
    id: "ecourier",
    label: "eCourier",
    needsSecret: true,
    docs: "https://ecourier.com.bd/",
  },
  {
    id: "paperfly",
    label: "Paperfly",
    needsSecret: true,
    docs: "https://paperfly.com.bd/",
  },
  { id: "other", label: "Other", needsSecret: false, docs: "" },
] as const;

type CourierId = (typeof COURIER_PROVIDERS)[number]["id"];

export function CouriersSection() {
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
    editing != null
      ? (configured.find((c) => c.name === editing) ?? null)
      : null;

  return (
    <SettingsSection
      icon={Truck}
      title="Courier credentials"
      description="Keys are encrypted with AES-256-GCM before they touch the database."
      actions={
        <Button
          onClick={openNew}
          className="bg-brand text-white hover:bg-brand-hover"
        >
          Add courier
        </Button>
      }
    >
      <div className="space-y-3">
        {couriers.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-md border border-stroke/6 bg-white/5"
              />
            ))}
          </div>
        ) : null}
        {!couriers.isLoading && configured.length === 0 ? (
          <CourierEmptyState onConnect={openNew} />
        ) : null}
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
                    {c.preferredDistricts.length > 0 ? (
                      <span>
                        {c.preferredDistricts.length} preferred district
                        {c.preferredDistricts.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  {c.validationError ? (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-danger">
                      <AlertCircle className="h-3 w-3" /> {c.validationError}
                    </p>
                  ) : null}
                </div>
              </div>
              {/*
                Touch targets here are now min-h-9 (36px) buttons in a
                gap-2 row that wraps on the smallest viewports — better
                than the previous 32px (audit P1-12). Still under
                Apple's 44pt floor by 2px; keeping them at sm because
                the row already wraps to a new flex column on
                <640px and the buttons get full width there.
              */}
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
      </div>

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
    </SettingsSection>
  );
}

function CourierEmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stroke/12 px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-subtle">
        <Truck className="h-5 w-5 text-brand" />
      </div>
      <div>
        <p className="font-medium text-fg">No couriers connected yet</p>
        <p className="mt-1 text-sm text-fg-subtle">
          Add Pathao or Steadfast credentials to start booking pickups and
          pulling tracking events.
        </p>
      </div>
      <Button
        onClick={onConnect}
        className="bg-brand text-white hover:bg-brand-hover"
      >
        Connect first courier
      </Button>
    </div>
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
          {mutation.error ? <FormError message={mutation.error.message} /> : null}
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
              {mutation.isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
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
      const firstAvailable = (COURIER_PROVIDERS.find(
        (p) => !existingIds.has(p.id),
      )?.id ?? "pathao") as CourierId;
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
          <DialogTitle>
            {isEdit ? "Edit courier" : "Connect courier"}
          </DialogTitle>
          <DialogDescription className="text-fg-subtle">
            Credentials are encrypted before storage. We never log raw API keys.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField label="Provider" htmlFor="provider">
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
                  const used =
                    existingIds.has(p.id) && p.id !== editingCourier?.name;
                  return (
                    <SelectItem key={p.id} value={p.id} disabled={used}>
                      {p.label}
                      {used ? " (already connected)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {providerMeta?.docs ? (
              <a
                href={providerMeta.docs}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                {providerMeta.label} merchant portal{" "}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </FormField>

          <FormField label="Account / Merchant ID" htmlFor="accountId" required>
            <Input
              id="accountId"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="e.g. 23019"
              maxLength={200}
              required
            />
          </FormField>

          <FormField
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
          </FormField>

          {providerMeta?.needsSecret ? (
            <FormField
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
            </FormField>
          ) : null}

          <FormField
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
          </FormField>

          <FormField
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
          </FormField>

          {mutation.error ? <FormError message={mutation.error.message} /> : null}

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
              {mutation.isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {isEdit ? "Update credentials" : "Save courier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
