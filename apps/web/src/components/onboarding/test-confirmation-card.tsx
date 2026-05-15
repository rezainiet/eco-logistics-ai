"use client";

import { Loader2, MessageSquare, CheckCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Onboarding "wow" surface. A brand-new merchant lands on an empty
 * dashboard and has no way to feel the product until a real customer
 * order arrives — which on a slow weekday could be hours away (audit
 * 04 §1, 05 Tier 1.2). This card lets them text *themselves* the exact
 * bilingual, brand-stamped confirmation SMS their Bangladeshi customers
 * will receive, in one click, within the first two minutes.
 *
 * The mutation (merchants.sendTestSms) is rate-limited 5/hour server-side
 * and uses the real order-confirmation template, so a successful send
 * proves the entire pipeline AND shows the merchant their brand on a
 * real handset. No new backend read — reuses the existing procedure.
 */
export function TestConfirmationCard() {
  const mutation = trpc.merchants.sendTestSms.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Confirmation SMS sent to ••••${data.phoneSuffix}. Check your phone — that's exactly what your customers see.`,
      );
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const sent = mutation.isSuccess;

  return (
    <Card className="border-stroke/12 bg-surface">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">
            See what your customers will receive
          </h3>
          <p className="mt-1 text-sm text-fg-muted">
            Send the real confirmation SMS — branded with your business name,
            in Bangla and English — to your own phone right now. No order
            required.
          </p>
        </div>
        <Button
          type="button"
          variant={sent ? "outline" : "default"}
          size="default"
          className="shrink-0"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : sent ? (
            <>
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              Send again
            </>
          ) : (
            <>
              <MessageSquare className="mr-1.5 h-4 w-4" />
              Send test confirmation
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
