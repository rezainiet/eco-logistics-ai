"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Lock,
  ShieldAlert,
} from "lucide-react";
import type { PlanTier } from "@ecom/types";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PROVIDER_LABEL: Record<string, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  custom_api: "Custom API",
  csv: "CSV",
};

const TIER_LABEL: Record<PlanTier, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

/**
 * Dialog shown BEFORE a merchant downgrades their plan. Calls the
 * `billing.previewPlanChange` query to enumerate which active
 * integrations will be disabled by the new tier's caps + provider
 * allowlist. Splits the result into two buckets so the merchant can
 * tell the difference between:
 *
 *   - "Provider not on the new plan"  — fixable only by upgrading
 *     (or by disconnecting voluntarily before the tier flip).
 *   - "Over the integration cap"      — fixable by re-prioritising
 *     which connectors stay before confirming.
 *
 * The dialog is fully self-contained and stateless from the parent's
 * perspective — pass the target tier and an `onConfirm` callback. The
 * parent retains responsibility for the actual mutation that performs
 * the tier change (Stripe checkout, admin RBAC mutation, etc.) so the
 * preview component stays neutral about HOW the downgrade is applied.
 */
export function DowngradeWarningDialog({
  open,
  onOpenChange,
  targetTier,
  onConfirm,
  isConfirming,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The plan the merchant has chosen to switch to. Lookups & preview
   * are computed against this. A `null` `targetTier` is allowed (the
   * dialog stays gated `open=false`) so callers can lazy-set it.
   */
  targetTier: PlanTier | null;
  /**
   * Fired when the merchant clicks "Yes, downgrade". The parent
   * triggers the actual checkout/mutation; the dialog stays open and
   * shows a spinner until the parent toggles `isConfirming` back to
   * false (typically via `onOpenChange(false)` in `onSettled`).
   */
  onConfirm: () => void;
  isConfirming?: boolean;
}) {
  // Skip the query when the dialog isn't open — saves a roundtrip on
  // pages where the parent renders a hidden modal instance.
  const enabled = open && !!targetTier;
  const preview = trpc.billing.previewPlanChange.useQuery(
    targetTier ? { targetTier } : { targetTier: "starter" as PlanTier },
    {
      enabled,
      // Stale immediately so toggling tier in the parent re-fetches
      // when the dialog is opened with a different target.
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  );

  const summary = useMemo(() => {
    if (!preview.data) return null;
    const { preview: p, from, to, isDowngrade, isUpgrade } = preview.data;
    const totalDisabled = p.disabled.length + p.providerLocked.length;
    return {
      from,
      to,
      isDowngrade,
      isUpgrade,
      totalDisabled,
      capChange: { activeBefore: p.activeBefore, cap: p.cap },
      disabled: p.disabled,
      providerLocked: p.providerLocked,
    };
  }, [preview.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {summary?.isDowngrade ? (
              <AlertTriangle className="h-5 w-5 text-warning" />
            ) : (
              <ShieldAlert className="h-5 w-5 text-brand" />
            )}
            {summary?.isDowngrade
              ? "Confirm downgrade"
              : summary?.isUpgrade
                ? "Confirm plan change"
                : "Plan change preview"}
          </DialogTitle>
          <DialogDescription className="text-fg-muted">
            {targetTier ? (
              <>
                You're moving from{" "}
                <strong className="text-fg">
                  {summary ? TIER_LABEL[summary.from] : "—"}
                </strong>{" "}
                to{" "}
                <strong className="text-fg">{TIER_LABEL[targetTier]}</strong>.
                Review what changes before you confirm.
              </>
            ) : (
              "Pick a target plan to preview the change."
            )}
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading || !summary ? (
          <div className="flex items-center justify-center py-8 text-fg-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="ml-2 text-sm">Calculating impact…</span>
          </div>
        ) : preview.isError ? (
          <div className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-xs text-danger">
            We couldn't generate a preview. Refresh the page and try again, or
            contact support if it keeps failing.
          </div>
        ) : summary.totalDisabled === 0 ? (
          <CleanFitNotice
            isDowngrade={summary.isDowngrade}
            isUpgrade={summary.isUpgrade}
          />
        ) : (
          <DisableImpactList
            disabled={summary.disabled}
            providerLocked={summary.providerLocked}
            capChange={summary.capChange}
          />
        )}

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isConfirming}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isConfirming || preview.isLoading || preview.isError}
            // Color the confirm button by severity: a downgrade that
            // disables connectors is destructive copy; a clean-fit
            // change is a normal primary CTA.
            variant={
              summary && summary.totalDisabled > 0 ? "destructive" : "default"
            }
          >
            {isConfirming ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {summary && summary.totalDisabled > 0
              ? `Yes, downgrade and disable ${summary.totalDisabled}`
              : summary?.isUpgrade
                ? "Confirm upgrade"
                : "Confirm change"}
            {!isConfirming ? <ArrowRight className="ml-1.5 h-3.5 w-3.5" /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Friendly path: nothing breaks. Reassures the merchant. */
function CleanFitNotice({
  isDowngrade,
  isUpgrade,
}: {
  isDowngrade: boolean;
  isUpgrade: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border border-success/30 bg-success-subtle p-4 text-sm text-success">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">No integrations will be affected.</p>
          <p className="text-xs text-fg-muted">
            Your current connectors all fit under the new plan's caps.
            {isDowngrade
              ? " Other features (analytics retention, fraud-review quota, call minutes) may be reduced — review the pricing page for the full feature matrix."
              : isUpgrade
                ? " You'll get more headroom and any newly-enabled providers will be selectable from the Connections panel."
                : null}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Destructive path: list what's about to be disabled, by reason. */
function DisableImpactList({
  disabled,
  providerLocked,
  capChange,
}: {
  disabled: Array<{
    id: string;
    provider: string;
    accountKey?: string;
    label?: string | null;
  }>;
  providerLocked: Array<{ id: string; provider: string; accountKey?: string }>;
  capChange: { activeBefore: number; cap: number };
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-warning/30 bg-warning-subtle p-3 text-xs text-warning">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>
              {disabled.length + providerLocked.length} integration
              {disabled.length + providerLocked.length === 1 ? "" : "s"} will be
              disabled.
            </strong>{" "}
            Webhook history and dead-letter rows are kept — you can reconnect
            after upgrading without losing data.
          </p>
        </div>
      </div>

      {providerLocked.length > 0 ? (
        <Group
          icon={<Lock className="h-4 w-4 text-danger" />}
          title="Not available on the new plan"
          subtitle="These providers aren't included in the target tier. Upgrade to keep them, or disconnect manually before downgrading."
          rows={providerLocked.map((r) => ({
            id: r.id,
            provider: r.provider,
            accountKey: r.accountKey,
          }))}
          tone="danger"
        />
      ) : null}

      {disabled.length > 0 ? (
        <Group
          icon={<AlertTriangle className="h-4 w-4 text-warning" />}
          title={`Over the integration cap (${capChange.cap} max)`}
          subtitle={`You currently have ${capChange.activeBefore} active connectors. We'll keep the newest under the cap and disable the oldest.`}
          rows={disabled.map((r) => ({
            id: r.id,
            provider: r.provider,
            accountKey: r.accountKey,
            label: r.label,
          }))}
          tone="warning"
        />
      ) : null}
    </div>
  );
}

function Group({
  icon,
  title,
  subtitle,
  rows,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  rows: Array<{
    id: string;
    provider: string;
    accountKey?: string;
    label?: string | null;
  }>;
  tone: "danger" | "warning";
}) {
  const borderClass =
    tone === "danger" ? "border-danger/30" : "border-warning/30";
  return (
    <div className={`space-y-2 rounded-md border bg-surface-raised/40 p-3 ${borderClass}`}>
      <div className="flex items-start gap-2">
        {icon}
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-fg">{title}</p>
          <p className="text-xs text-fg-muted">{subtitle}</p>
        </div>
      </div>
      <ul className="ml-6 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <span className="text-fg-muted">•</span>
            <span className="font-medium text-fg">
              {PROVIDER_LABEL[r.provider] ?? r.provider}
            </span>
            <span className="font-mono text-2xs text-fg-subtle">
              {r.label || r.accountKey || r.id}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
