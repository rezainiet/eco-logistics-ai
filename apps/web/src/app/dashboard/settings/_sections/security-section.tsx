"use client";

/**
 * Security section.
 *
 * Extracted verbatim from the old `<SecuritySection>` in the
 * 1,282-line settings monolith.
 *
 * CRITICAL: the password form preserves the anti-GET-fallthrough
 * hardening from the original — `method="post" action="/api/auth/__nope"`
 * + capturing onSubmit with native preventDefault. Without this, a slow
 * hydration / JS error causes the browser's native form submission to
 * fall through as GET, putting BOTH the current and new passwords in the
 * URL (history, dev stdout, every reverse-proxy access log). Same defense
 * as login/signup/reset-password. This was a real prod incident — see
 * the comment chain in apps/web/src/app/(auth)/login/page.tsx for the
 * original write-up.
 *
 * Logic preserved 1:1.
 */
import { useState } from "react";
import { CheckCircle2, Lock, Loader2, Mail } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/settings/section";
import { FormField, FormError } from "@/components/settings/form-field";

export function SecuritySection() {
  const profile = trpc.merchants.getProfile.useQuery();
  const utils = trpc.useUtils();
  const change = trpc.merchants.changePassword.useMutation({
    onSuccess: () => {
      toast.success(
        "Password updated",
        "Use the new password next time you sign in.",
      );
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
  const canSubmit =
    !!current && !!next && !!confirm && !mismatch && !tooShort && !sameAsOld;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    await change.mutateAsync({
      currentPassword: current,
      newPassword: next,
    });
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
    <div className="space-y-6">
      <SettingsSection
        icon={Lock}
        title="Change password"
        description="Re-enter your current password, then choose a new one."
      >
        {/*
          SECURITY: explicit method="post" + dummy action + capturing
          onSubmit with native preventDefault. Without this, a slow
          hydration / JS error causes the browser's native form
          submission to fall through as GET, putting BOTH the
          current and new passwords in the URL — history, dev
          stdout, every reverse-proxy access log. Same defense as
          login/signup/reset-password. See login/page.tsx for the
          original incident note.
        */}
        <form
          method="post"
          action="/api/auth/__nope"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(e);
          }}
          className="space-y-4"
        >
          <FormField label="Current password" htmlFor="currentPassword" required>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="••••••••"
              required
            />
          </FormField>
          <FormField
            label="New password"
            htmlFor="newPassword"
            hint="At least 8 characters. A passphrase you'll remember works best."
            required
            error={
              tooShort
                ? "At least 8 characters."
                : sameAsOld
                  ? "New password must be different."
                  : undefined
            }
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
          </FormField>
          <FormField
            label="Confirm new password"
            htmlFor="confirmPassword"
            required
            error={mismatch ? "Passwords do not match." : undefined}
          >
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat the new password"
              required
            />
          </FormField>
          {change.error ? <FormError message={change.error.message} /> : null}
          <div className="flex items-center justify-end border-t border-stroke/8 pt-4">
            <Button
              type="submit"
              disabled={!canSubmit || change.isLoading}
              className="bg-brand text-white hover:bg-brand-hover"
            >
              {change.isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Update password
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection
        icon={Mail}
        title="Email verification"
        description={
          profile.data?.emailVerified
            ? "Your email is verified — you'll receive billing receipts and trial reminders."
            : "Confirm your email so we can send billing receipts and trial reminders."
        }
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
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
        </div>
      </SettingsSection>
    </div>
  );
}
