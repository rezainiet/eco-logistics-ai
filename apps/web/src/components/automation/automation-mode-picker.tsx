"use client";

import { useState } from "react";
import { Bot, AlertCircle, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

const MODE_DESCRIPTIONS: Record<string, string> = {
  manual: "Every order goes to pending — you click Confirm or Reject. Safest.",
  semi_auto: "Low-risk orders auto-confirm. Medium / high stay in pending. Auto-book is opt-in.",
  full_auto: "Low-risk orders auto-confirm AND auto-book. Medium stays in pending; high always reviews.",
};

/**
 * Drop into /dashboard/settings as a new section. Reads + writes
 * Merchant.automationConfig via the merchants router.
 */
export function AutomationModePicker() {
  const utils = trpc.useUtils();
  const cfg = trpc.merchants.getAutomationConfig.useQuery();
  const update = trpc.merchants.updateAutomationConfig.useMutation({
    onSuccess: () => utils.merchants.getAutomationConfig.invalidate(),
  });

  const [error, setError] = useState<string | null>(null);

  if (cfg.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading automation settings…
        </CardContent>
      </Card>
    );
  }

  const data = cfg.data ?? {
    enabled: false,
    mode: "manual" as const,
    maxRiskForAutoConfirm: 39,
    autoBookEnabled: false,
    autoBookCourier: null as string | null,
    enabledCouriers: [] as string[],
  };

  const setField = async (input: Parameters<typeof update.mutate>[0]) => {
    try {
      setError(null);
      await update.mutateAsync(input);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-fg-muted" aria-hidden />
          <CardTitle className="text-lg">Order automation</CardTitle>
        </div>
        <CardDescription>
          Decide how new orders flow through your account. Defaults to manual —
          turning automation on can cut your daily review work to a few clicks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Enable automation</Label>
            <p className="text-xs text-fg-muted">
              When off, every order goes to pending — same as today.
            </p>
          </div>
          <Switch
            checked={data.enabled}
            onCheckedChange={(v) => void setField({ enabled: v })}
          />
        </div>

        <div className={data.enabled ? "" : "pointer-events-none opacity-50"}>
          <Label className="text-sm">Mode</Label>
          <Select
            value={data.mode}
            onValueChange={(v) => void setField({ mode: v as "manual" | "semi_auto" | "full_auto" })}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue placeholder="Pick a mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual (default)</SelectItem>
              <SelectItem value="semi_auto">Semi-automatic</SelectItem>
              <SelectItem value="full_auto">Full automatic</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-fg-muted">{MODE_DESCRIPTIONS[data.mode]}</p>
        </div>

        <div className={data.enabled && data.mode !== "manual" ? "" : "pointer-events-none opacity-50"}>
          <Label className="text-sm">Auto-confirm risk ceiling</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={data.maxRiskForAutoConfirm}
            onChange={(e) =>
              void setField({ maxRiskForAutoConfirm: Number.parseInt(e.target.value || "0", 10) })
            }
            className="mt-1 w-32"
          />
          <p className="mt-1 text-xs text-fg-muted">
            Orders scoring above this number require your manual confirmation,
            even if the level is "low".
          </p>
        </div>

        <div className={data.enabled && data.mode === "full_auto" ? "" : "pointer-events-none opacity-50"}>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Auto-book courier</Label>
              <p className="text-xs text-fg-muted">
                Auto-confirmed orders also get a tracking number from your default
                courier.
              </p>
            </div>
            <Switch
              checked={data.autoBookEnabled}
              onCheckedChange={(v) => void setField({ autoBookEnabled: v })}
            />
          </div>
          {data.autoBookEnabled && data.enabledCouriers.length > 0 ? (
            <div className="mt-2">
              <Select
                value={data.autoBookCourier ?? data.enabledCouriers[0] ?? ""}
                onValueChange={(v) => void setField({ autoBookCourier: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a courier" />
                </SelectTrigger>
                <SelectContent>
                  {data.enabledCouriers.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/8 p-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
