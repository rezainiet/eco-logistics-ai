"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import type { BrandingConfig, BrandingPatch } from "@ecom/branding";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Admin Branding Panel.
 *
 * Reads + writes the centralized SaaS BrandingConfig via tRPC. Every
 * field is optional in the patch — we send only what changed.
 * Optimistic-concurrency check on the server (`expectedVersion`)
 * rejects writes that would silently overwrite a peer admin's edits.
 *
 * Asset fields are URLs only — the architecture decision was
 * Cloudinary-compatible: paste a CDN URL, never upload bytes through
 * the SaaS database. This keeps the BrandingConfig document small and
 * keeps backups portable.
 *
 * The "envOverriddenFields" array from the server tags fields that are
 * pinned by `BRANDING_OVERRIDES` env. Those inputs render disabled with
 * a small lock icon so admins know their changes won't take effect
 * until the env override is removed.
 */

type Branding = BrandingConfig;
type Patch = BrandingPatch;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function BrandingPanel() {
  const utils = trpc.useUtils();
  const query = trpc.adminBranding.get.useQuery();
  const mutation = trpc.adminBranding.update.useMutation({
    onSuccess: (out) => {
      void utils.adminBranding.get.invalidate();
      void utils.branding.current.invalidate();
      toast.success(
        "Branding saved",
        out.changedFields.length
          ? `${out.changedFields.length} field${out.changedFields.length === 1 ? "" : "s"} updated.`
          : "No changes.",
      );
    },
    onError: (err) => {
      toast.error("Couldn't save branding", err.message);
    },
  });

  const [draft, setDraft] = useState<Patch>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (query.data) {
      setDraft({});
      setVersion(query.data.branding.version);
    }
  }, [query.data]);

  const branding = query.data?.branding;
  const env = useMemo(
    () => new Set(query.data?.envOverriddenFields ?? []),
    [query.data?.envOverriddenFields],
  );

  function isLocked(path: string): boolean {
    return env.has(path);
  }

  function patchTop<K extends keyof Patch>(key: K, value: Patch[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function patchSub<
    G extends "colors" | "email" | "seo" | "operational" | "assets",
    K extends keyof NonNullable<Patch[G]>,
  >(group: G, key: K, value: NonNullable<Patch[G]>[K]) {
    setDraft((d) => ({
      ...d,
      [group]: { ...(d[group] ?? {}), [key]: value } as Patch[G],
    }));
  }

  if (query.isLoading || !branding) {
    return (
      <div className="flex h-64 items-center justify-center text-fg-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  // Effective values for inputs: draft overrides applied on top of server state.
  const eff = {
    ...branding,
    ...draft,
    colors: { ...branding.colors, ...(draft.colors ?? {}) },
    assets: { ...branding.assets, ...(draft.assets ?? {}) },
    email: { ...branding.email, ...(draft.email ?? {}) },
    seo: { ...branding.seo, ...(draft.seo ?? {}) },
    operational: { ...branding.operational, ...(draft.operational ?? {}) },
  };

  const dirty = Object.keys(draft).length > 0;
  const colorErrors = (Object.entries(eff.colors) as [string, string | undefined][])
    .filter(([k, v]) => k !== "accent" && typeof v === "string" && v && !HEX_RE.test(v))
    .map(([k]) => k);
  const canSave = dirty && colorErrors.length === 0 && !mutation.isLoading;

  const onSave = () => {
    mutation.mutate({ patch: draft, expectedVersion: version });
  };
  const onReset = () => {
    setDraft({});
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="SaaS branding"
        description="One source of truth for the SaaS identity. Changes apply to every public surface within ~60 s — no redeploy required."
      />

      {/* Identity */}
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg">Identity</CardTitle>
          <CardDescription>Name, tagline, contact addresses.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
            label="SaaS name"
            value={eff.name}
            onChange={(v) => patchTop("name", v)}
            locked={isLocked("name")}
          />
          <Field
            label="Legal name"
            value={eff.legalName}
            onChange={(v) => patchTop("legalName", v)}
            locked={isLocked("legalName")}
          />
          <Field
            label="Tagline"
            value={eff.tagline}
            onChange={(v) => patchTop("tagline", v)}
            locked={isLocked("tagline")}
          />
          <Field
            label="Short tagline"
            value={eff.shortTagline}
            onChange={(v) => patchTop("shortTagline", v)}
            locked={isLocked("shortTagline")}
          />
          <Field
            label="Support email"
            type="email"
            value={eff.supportEmail}
            onChange={(v) => patchTop("supportEmail", v)}
            locked={isLocked("supportEmail")}
          />
          <Field
            label="Privacy email"
            type="email"
            value={eff.privacyEmail}
            onChange={(v) => patchTop("privacyEmail", v)}
            locked={isLocked("privacyEmail")}
          />
          <Field
            label="Sales email"
            type="email"
            value={eff.salesEmail}
            onChange={(v) => patchTop("salesEmail", v)}
            locked={isLocked("salesEmail")}
          />
          <Field
            label="Hello email"
            type="email"
            value={eff.helloEmail}
            onChange={(v) => patchTop("helloEmail", v)}
            locked={isLocked("helloEmail")}
          />
          <Field
            label="Home URL"
            value={eff.homeUrl}
            onChange={(v) => patchTop("homeUrl", v)}
            locked={isLocked("homeUrl")}
          />
          <Field
            label="Status page URL"
            value={eff.statusPageUrl}
            onChange={(v) => patchTop("statusPageUrl", v)}
            locked={isLocked("statusPageUrl")}
          />
        </CardContent>
      </Card>

      {/* Visual */}
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg">Visual</CardTitle>
          <CardDescription>
            Colours and asset URLs (Cloudinary-compatible). Paste CDN
            URLs; uploads happen out-of-band.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <ColorField
              label="Brand"
              hex={eff.colors.brand}
              onChange={(v) => patchSub("colors", "brand", v)}
              locked={isLocked("colors.brand")}
              error={!HEX_RE.test(eff.colors.brand)}
            />
            <ColorField
              label="Brand hover"
              hex={eff.colors.brandHover}
              onChange={(v) => patchSub("colors", "brandHover", v)}
              locked={isLocked("colors.brandHover")}
              error={!HEX_RE.test(eff.colors.brandHover)}
            />
            <ColorField
              label="Brand active"
              hex={eff.colors.brandActive}
              onChange={(v) => patchSub("colors", "brandActive", v)}
              locked={isLocked("colors.brandActive")}
              error={!HEX_RE.test(eff.colors.brandActive)}
            />
            <ColorField
              label="Brand foreground"
              hex={eff.colors.brandFg}
              onChange={(v) => patchSub("colors", "brandFg", v)}
              locked={isLocked("colors.brandFg")}
              error={!HEX_RE.test(eff.colors.brandFg)}
            />
            <ColorField
              label="Surface base"
              hex={eff.colors.surfaceBase}
              onChange={(v) => patchSub("colors", "surfaceBase", v)}
              locked={isLocked("colors.surfaceBase")}
              error={!HEX_RE.test(eff.colors.surfaceBase)}
            />
            <ColorField
              label="Foreground"
              hex={eff.colors.fg}
              onChange={(v) => patchSub("colors", "fg", v)}
              locked={isLocked("colors.fg")}
              error={!HEX_RE.test(eff.colors.fg)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <UrlField
              label="Logo URL"
              value={eff.assets.logo.url}
              onChange={(v) =>
                patchSub("assets", "logo", { ...eff.assets.logo, url: v })
              }
              locked={isLocked("assets.logo.url")}
            />
            <UrlField
              label="Favicon URL"
              value={eff.assets.favicon.url}
              onChange={(v) =>
                patchSub("assets", "favicon", { ...eff.assets.favicon, url: v })
              }
              locked={isLocked("assets.favicon.url")}
            />
            <UrlField
              label="OG image URL"
              value={eff.assets.ogImage.url}
              onChange={(v) =>
                patchSub("assets", "ogImage", {
                  ...eff.assets.ogImage,
                  url: v,
                })
              }
              locked={isLocked("assets.ogImage.url")}
            />
            <UrlField
              label="Email logo URL"
              value={eff.assets.emailLogo?.url ?? ""}
              onChange={(v) =>
                patchSub("assets", "emailLogo", {
                  url: v,
                  alt: eff.assets.emailLogo?.alt ?? eff.name,
                })
              }
              locked={isLocked("assets.emailLogo.url")}
            />
          </div>
          <ColorPreview branding={eff} />
        </CardContent>
      </Card>

      {/* Email */}
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg">Email</CardTitle>
          <CardDescription>
            Sender identity + transactional shell. Updates apply to every
            template (verify, reset, trial, billing, alerts) on the next
            send.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
            label="Sender name"
            value={eff.email.senderName}
            onChange={(v) => patchSub("email", "senderName", v)}
            locked={isLocked("email.senderName")}
          />
          <Field
            label="Sender address"
            type="email"
            value={eff.email.senderAddress}
            onChange={(v) => patchSub("email", "senderAddress", v)}
            locked={isLocked("email.senderAddress")}
          />
          <Field
            label="Reply-to"
            type="email"
            value={eff.email.replyTo ?? ""}
            onChange={(v) => patchSub("email", "replyTo", v)}
            locked={isLocked("email.replyTo")}
          />
          <Field
            label="CTA default label"
            value={eff.email.ctaTextDefault}
            onChange={(v) => patchSub("email", "ctaTextDefault", v)}
            locked={isLocked("email.ctaTextDefault")}
          />
          <Field
            label="Footer line"
            value={eff.email.footer}
            onChange={(v) => patchSub("email", "footer", v)}
            locked={isLocked("email.footer")}
            wide
          />
          <Field
            label="Support line"
            value={eff.email.supportLine}
            onChange={(v) => patchSub("email", "supportLine", v)}
            locked={isLocked("email.supportLine")}
            wide
          />
        </CardContent>
      </Card>

      {/* SEO */}
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg">SEO &amp; social</CardTitle>
          <CardDescription>
            Title template, OG defaults, Twitter handle.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
            label="Default meta title"
            value={eff.seo.metaTitleDefault}
            onChange={(v) => patchSub("seo", "metaTitleDefault", v)}
            locked={isLocked("seo.metaTitleDefault")}
          />
          <Field
            label="Title template (must include %s)"
            value={eff.seo.metaTitleTemplate}
            onChange={(v) => patchSub("seo", "metaTitleTemplate", v)}
            locked={isLocked("seo.metaTitleTemplate")}
          />
          <Field
            label="OG site name"
            value={eff.seo.ogSiteName}
            onChange={(v) => patchSub("seo", "ogSiteName", v)}
            locked={isLocked("seo.ogSiteName")}
          />
          <Field
            label="Twitter handle"
            value={eff.seo.twitterHandle ?? ""}
            onChange={(v) => patchSub("seo", "twitterHandle", v)}
            locked={isLocked("seo.twitterHandle")}
          />
          <Field
            label="Meta description"
            value={eff.seo.metaDescription}
            onChange={(v) => patchSub("seo", "metaDescription", v)}
            locked={isLocked("seo.metaDescription")}
            wide
          />
        </CardContent>
      </Card>

      {/* Operational */}
      <Card className="border-stroke/10 bg-surface text-fg">
        <CardHeader>
          <CardTitle className="text-lg">Operational</CardTitle>
          <CardDescription>
            SDK identifiers, third-party prefixes, SMS sender brand.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
            label="SDK global name (window.X)"
            value={eff.operational.sdkGlobalName}
            onChange={(v) => patchSub("operational", "sdkGlobalName", v)}
            locked={isLocked("operational.sdkGlobalName")}
          />
          <Field
            label="SDK console prefix"
            value={eff.operational.sdkConsolePrefix}
            onChange={(v) => patchSub("operational", "sdkConsolePrefix", v)}
            locked={isLocked("operational.sdkConsolePrefix")}
          />
          <Field
            label="SMS brand"
            value={eff.operational.smsBrand}
            onChange={(v) => patchSub("operational", "smsBrand", v)}
            locked={isLocked("operational.smsBrand")}
          />
          <Field
            label="Stripe product prefix"
            value={eff.operational.stripeProductPrefix}
            onChange={(v) =>
              patchSub("operational", "stripeProductPrefix", v)
            }
            locked={isLocked("operational.stripeProductPrefix")}
          />
          <Field
            label="WooCommerce webhook prefix"
            value={eff.operational.woocommerceWebhookPrefix}
            onChange={(v) =>
              patchSub("operational", "woocommerceWebhookPrefix", v)
            }
            locked={isLocked("operational.woocommerceWebhookPrefix")}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-xl border border-stroke/10 bg-surface px-4 py-3">
        <div className="text-xs text-fg-subtle">
          Version on disk: <code>v{version}</code>
          {dirty ? <span className="ml-2 text-warning">· unsaved changes</span> : null}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="border-stroke/14 text-fg-muted"
            onClick={onReset}
            disabled={!dirty || mutation.isLoading}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
          </Button>
          <Button
            className="bg-brand text-brand-fg hover:bg-brand-hover"
            onClick={onSave}
            disabled={!canSave}
          >
            {mutation.isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save className="mr-1.5 h-3.5 w-3.5" /> Save changes
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  locked,
  type,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  locked?: boolean;
  type?: string;
  wide?: boolean;
}) {
  return (
    <div className={`space-y-1.5 ${wide ? "md:col-span-2" : ""}`}>
      <Label className="flex items-center gap-1.5 text-fg-subtle">
        {label}
        {locked ? <Lock className="h-3 w-3 text-fg-faint" aria-label="env-locked" /> : null}
      </Label>
      <Input
        type={type ?? "text"}
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function UrlField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  locked?: boolean;
}) {
  return <Field {...props} type="url" />;
}

function ColorField({
  label,
  hex,
  onChange,
  locked,
  error,
}: {
  label: string;
  hex: string;
  onChange: (v: string) => void;
  locked?: boolean;
  error?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-fg-subtle">
        {label}
        {locked ? <Lock className="h-3 w-3 text-fg-faint" /> : null}
      </Label>
      <div className="flex items-center gap-2 rounded-md border border-stroke/14 bg-surface-overlay p-2">
        <input
          type="color"
          value={HEX_RE.test(hex) ? hex : "#000000"}
          disabled={locked}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-9 cursor-pointer rounded border border-stroke/14 bg-transparent disabled:opacity-50"
          aria-label={`${label} colour picker`}
        />
        <Input
          value={hex}
          disabled={locked}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="#C6F84F"
          spellCheck={false}
          className={`font-mono ${error ? "border-danger/60" : ""}`}
        />
      </div>
      {error ? <p className="text-xs text-danger">Use 6-digit hex.</p> : null}
    </div>
  );
}

function ColorPreview({ branding }: { branding: { name: string; colors: { brand: string; brandFg: string; brandHover: string; surfaceBase: string; fg: string } } }) {
  const c = branding.colors;
  return (
    <div className="space-y-2">
      <Label className="text-fg-subtle">Live preview</Label>
      <div
        className="rounded-xl border border-stroke/10 p-4"
        style={{ background: c.surfaceBase, color: c.fg }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: c.brand, color: c.brandFg }}
          >
            {branding.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{branding.name}</div>
            <div className="text-xs opacity-70">Sample workspace chrome</div>
          </div>
          <button
            type="button"
            disabled
            className="ml-auto rounded-md px-3 py-2 text-xs font-medium"
            style={{ background: c.brand, color: c.brandFg }}
          >
            Primary CTA
          </button>
          <button
            type="button"
            disabled
            className="rounded-md px-3 py-2 text-xs font-medium"
            style={{ background: c.brandHover, color: c.brandFg }}
          >
            Hover state
          </button>
        </div>
      </div>
    </div>
  );
}
