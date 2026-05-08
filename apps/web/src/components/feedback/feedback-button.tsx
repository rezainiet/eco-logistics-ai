"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { MessageSquarePlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";

/**
 * Topbar "Send feedback" button — design-partner phase only.
 *
 * Opens a small sheet with one kind selector + a free-form message
 * textarea. Submits to `feedback.submit` and closes on success.
 *
 * No CRM, no attachments, no rich text. The message goes to one row in
 * `MerchantFeedback`; ops triages it through the admin surface.
 */

const KIND_OPTIONS: ReadonlyArray<{ value: FeedbackKind; label: string; hint: string }> = [
  {
    value: "onboarding",
    label: "Onboarding",
    hint: "Got stuck connecting your store, importing orders, or finishing setup.",
  },
  {
    value: "integration",
    label: "Integration",
    hint: "Shopify / WooCommerce / custom-API not behaving as expected.",
  },
  {
    value: "support",
    label: "Need help",
    hint: "A specific question we can help you answer.",
  },
  {
    value: "bug",
    label: "Looks broken",
    hint: "Something's clearly wrong — error message, missing data, etc.",
  },
  {
    value: "feature_request",
    label: "Feature request",
    hint: "Something Cordon should do that it doesn't yet.",
  },
  {
    value: "general",
    label: "General feedback",
    hint: "Anything else you want us to hear.",
  },
];

type FeedbackKind =
  | "onboarding"
  | "integration"
  | "support"
  | "bug"
  | "feature_request"
  | "general";

export function FeedbackButton() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<FeedbackKind>("general");
  const [message, setMessage] = React.useState("");

  const submit = trpc.feedback.submit.useMutation({
    onSuccess: () => {
      toast.success(
        "Thanks — we got it",
        "We read every piece of feedback. Expect a reply if it needs one.",
      );
      setMessage("");
      setKind("general");
      setOpen(false);
    },
    onError: (err) => {
      toast.error(
        "Couldn't send",
        err.message?.slice(0, 200) ?? "Please try again.",
      );
    },
  });

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= 2000 && !submit.isLoading;

  const onSubmit = () => {
    if (!canSubmit) return;
    submit.mutate({
      kind,
      message: trimmed,
      pagePath: pathname ?? undefined,
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-stroke/12 bg-surface px-3 text-xs text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">Feedback</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full p-6 sm:max-w-md">
          <SheetHeader className="space-y-1.5">
            <SheetTitle>Send feedback</SheetTitle>
            <SheetDescription>
              We're onboarding our first design partners. Anything you tell
              us right now shapes what we ship next.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-[0.06em] text-fg-subtle">
                What's it about?
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {KIND_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setKind(opt.value)}
                    className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                      kind === opt.value
                        ? "border-brand bg-brand-subtle text-fg"
                        : "border-stroke/12 bg-surface text-fg-subtle hover:border-stroke/24"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-2xs text-fg-subtle">
                {KIND_OPTIONS.find((o) => o.value === kind)?.hint}
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="feedback-message"
                className="text-xs font-medium uppercase tracking-[0.06em] text-fg-subtle"
              >
                What's on your mind?
              </label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                maxLength={2000}
                placeholder="Tell us what happened — the more concrete, the better."
                className="w-full rounded-md border border-stroke/12 bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-stroke/24 focus:outline-none"
              />
              <div className="flex items-center justify-between text-2xs text-fg-subtle">
                <span>
                  {trimmed.length} / 2000
                </span>
                {pathname ? <span className="font-mono">{pathname}</span> : null}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submit.isLoading}
              >
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={!canSubmit}>
                {submit.isLoading ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
