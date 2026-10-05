"use client";

import * as React from "react";
import { Ban, Bell, Gauge, MapPin } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsSection } from "@/components/settings/section";
import { FormError, FormField } from "@/components/settings/form-field";
import { SaveBar } from "@/components/settings/save-bar";
import { buildPatch, formFromConfig, type RulesForm } from "@/lib/verification/rules-form";

const TEXTAREA =
  "w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand/30";

/**
 * Merchant verification rules — the inputs risk scoring already uses
 * (`Merchant.fraudConfig`, via merchants.getFraudConfig / updateFraudConfig).
 * Orders matching a blocked phone or address go straight to verification;
 * thresholds and velocity raise the risk score. Changes apply to new orders
 * and to the next re-score of open ones.
 */
export function VerificationRules() {
  const config = trpc.merchants.getFraudConfig.useQuery();
  const utils = trpc.useUtils();
  const [form, setForm] = React.useState<RulesForm | null>(null);

  React.useEffect(() => {
    if (config.data && !form) setForm(formFromConfig(config.data));
  }, [config.data, form]);

  const save = trpc.merchants.updateFraudConfig.useMutation({
    onSuccess: (data) => {
      utils.merchants.getFraudConfig.setData(undefined, data);
      setForm(formFromConfig(data));
      toast.success("Verification rules saved", "New orders are checked against them right away.");
    },
    onError: (err) => toast.error("Couldn't save", err.message),
  });

  if (config.isLoading || (!form && !config.isError)) {
    return <div className="text-sm text-fg-subtle">Loading…</div>;
  }
  if (config.isError || !config.data || !form) {
    return <FormError message="Couldn't load your verification rules. Refresh to try again." />;
  }

  const base = config.data;
  const { patch, errors } = buildPatch(form, base);
  const dirty = Object.keys(patch).length > 0 || Object.keys(errors).length > 0;
  const set = <K extends keyof RulesForm>(key: K, value: RulesForm[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  return (
    <div className="space-y-6 pb-24">
      <SettingsSection
        icon={Ban}
        title="Always verify"
        description="Orders from these customers go straight to the verification queue and can't be booked until someone verifies them."
      >
        <div className="space-y-4">
          <FormField
            label="Blocked phone numbers"
            htmlFor="vr-phones"
            hint="One per line. Any format — 01711…, +8801711…"
            error={errors.phones}
          >
            <textarea
              id="vr-phones"
              rows={4}
              className={TEXTAREA}
              value={form.phones}
              placeholder="01711000000"
              onChange={(e) => set("phones", e.target.value)}
            />
          </FormField>
          <FormField
            label="Block more addresses"
            htmlFor="vr-addresses"
            hint={`One per line; add “, district” at the end if you know it. ${base.blockedAddresses.length} address${base.blockedAddresses.length === 1 ? " is" : "es are"} blocked now (stored as fingerprints, not text).`}
            error={errors.newAddresses}
          >
            <textarea
              id="vr-addresses"
              rows={3}
              className={TEXTAREA}
              value={form.newAddresses}
              placeholder="House 12, Road 5, Dhanmondi, Dhaka"
              onChange={(e) => set("newAddresses", e.target.value)}
            />
          </FormField>
          {base.blockedAddresses.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={form.clearAddresses}
                onChange={(e) => set("clearAddresses", e.target.checked)}
                className="h-4 w-4"
              />
              Remove the {base.blockedAddresses.length} currently blocked address
              {base.blockedAddresses.length === 1 ? "" : "es"}
            </label>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Gauge}
        title="Order value"
        description="Orders above these cash-on-delivery amounts score as riskier. Leave empty to use your own order history automatically."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="High-value order (BDT)" htmlFor="vr-high" hint="Adds risk above this amount." error={errors.highCod}>
            <Input id="vr-high" inputMode="numeric" value={form.highCod} placeholder="Automatic" onChange={(e) => set("highCod", e.target.value)} />
          </FormField>
          <FormField label="Very high-value order (BDT)" htmlFor="vr-extreme" hint="Adds more risk above this amount." error={errors.extremeCod}>
            <Input id="vr-extreme" inputMode="numeric" value={form.extremeCod} placeholder="Automatic" onChange={(e) => set("extremeCod", e.target.value)} />
          </FormField>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={MapPin}
        title="Patterns"
        description="Signals that raise the risk score of an order."
      >
        <div className="space-y-4">
          <FormField label="Districts to watch" htmlFor="vr-districts" hint="One per line or comma-separated." error={errors.districts}>
            <textarea
              id="vr-districts"
              rows={3}
              className={TEXTAREA}
              value={form.districts}
              placeholder="Dhaka"
              onChange={(e) => set("districts", e.target.value)}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Repeat orders from one phone"
              htmlFor="vr-velocity"
              hint="Flag a phone that orders more than this many times in the window. 0 = off."
              error={errors.velocity}
            >
              <Input id="vr-velocity" inputMode="numeric" value={form.velocity} onChange={(e) => set("velocity", e.target.value)} />
            </FormField>
            <FormField label="Window (minutes)" htmlFor="vr-window" error={errors.velocityWindow}>
              <Input id="vr-window" inputMode="numeric" value={form.velocityWindow} onChange={(e) => set("velocityWindow", e.target.value)} />
            </FormField>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection icon={Bell} title="Notifications" description="Where you hear about orders that need verifying.">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-fg">Notify me about orders that need verification</p>
            <p className="text-xs text-fg-subtle">An in-app notification when a high-risk order arrives.</p>
          </div>
          <Switch
            checked={form.alertOnPendingReview}
            onCheckedChange={(v) => set("alertOnPendingReview", v)}
            aria-label="Notify me about orders that need verification"
          />
        </div>
      </SettingsSection>

      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        saveDisabled={Object.keys(errors).length > 0 || Object.keys(patch).length === 0}
        onSave={() => save.mutate(patch)}
        onDiscard={() => setForm(formFromConfig(base))}
      />
    </div>
  );
}
