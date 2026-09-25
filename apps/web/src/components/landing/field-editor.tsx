"use client";

import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import {
  ALLOWED_ASSET_MIME,
  CTA_ACTION_KINDS,
  MAX_ASSET_BYTES,
  type ContentIssue,
  type CtaAction,
  type CtaValue,
  type EffectiveField,
  type FieldDef,
  type ImageValue,
  newRepeaterItem,
} from "@ecom/landing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { localeInputClass } from "./bn-font";

/**
 * Schema-driven field editor. It renders exactly the fields a template
 * version exposes — nothing more — and every value it produces is
 * re-validated by `validateContent` on the client (inline errors) and again
 * on the server (authoritative). There is no HTML, CSS or script input.
 */

export interface FieldEditorEnv {
  /** Language of the content being edited — sets lang + the Bengali typeface on inputs. */
  locale: string;
  assetUrl: (assetId: string) => string | null;
  upload: (file: File) => Promise<{ id: string }>;
  /** Visible section ids a "scroll to section" CTA may target. */
  sectionTargets: Array<{ id: string; label: string }>;
}

const selectCls =
  "h-10 w-full rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";
const textareaCls =
  "min-h-[88px] w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

export function issuesAt(issues: ContentIssue[], path: string): string[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`)).map((i) => i.message);
}

function FieldShell({
  label,
  help,
  required,
  errors,
  children,
  path,
}: {
  label: string;
  help?: string;
  required?: boolean;
  errors: string[];
  children: ReactNode;
  /** Click-to-edit anchor: the preview selects a field by this path. */
  path: string;
}) {
  return (
    <div className="space-y-1.5 rounded-md" data-field-path={path}>
      <div className="text-xs font-medium text-fg-muted">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </div>
      {children}
      {help ? <p className="text-2xs text-fg-faint">{help}</p> : null}
      {errors.length ? <p className="text-2xs text-danger">{errors[0]}</p> : null}
    </div>
  );
}

export function LockedField({ field }: { field: EffectiveField }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-stroke/12 px-3 py-2 text-2xs text-fg-faint">
      <Lock className="h-3 w-3" /> {field.label} is set by the template
    </div>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
  path,
  issues,
  env,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (next: unknown) => void;
  path: string;
  issues: ContentIssue[];
  env: FieldEditorEnv;
}) {
  const errors = issuesAt(issues, path);
  const shell = (children: ReactNode) => (
    <FieldShell label={field.label} help={field.help} required={field.required} errors={errors} path={path}>
      {children}
    </FieldShell>
  );
  const str = typeof value === "string" ? value : "";
  const langProps = { lang: env.locale, className: localeInputClass(env.locale) };

  switch (field.type) {
    case "text":
    case "url":
      return shell(
        <Input
          value={str}
          maxLength={field.type === "text" ? field.maxLength ?? 160 : 2000}
          placeholder={field.type === "url" ? "https://…" : field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={errors.length > 0}
          {...(field.type === "text" ? langProps : {})}
        />,
      );
    case "textarea":
      return shell(
        <textarea
          lang={env.locale}
          className={cn(textareaCls, langProps.className)}
          value={str}
          maxLength={field.maxLength ?? 1200}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    case "richtext":
      return (
        <FieldShell
          label={field.label}
          required={field.required}
          errors={errors}
          path={path}
          help={field.help ?? "Blank line = new paragraph. **bold**, _italic_, and lines starting with “- ” for bullets."}
        >
          <textarea
            lang={env.locale}
            className={cn(textareaCls, "min-h-[120px]", langProps.className)}
            value={str}
            maxLength={field.maxLength ?? 6000}
            onChange={(e) => onChange(e.target.value)}
          />
        </FieldShell>
      );
    case "color":
      return shell(
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(str) ? str : "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-12 cursor-pointer rounded-md border border-stroke/14 bg-transparent p-1"
            aria-label={field.label}
          />
          <Input value={str} maxLength={7} onChange={(e) => onChange(e.target.value)} className="font-mono" />
        </div>,
      );
    case "select":
      return shell(
        <select className={selectCls} value={str} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>,
      );
    case "toggle":
      return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-stroke/10 px-3 py-2" data-field-path={path}>
          <span className="text-sm text-fg-muted">{field.label}</span>
          <Switch checked={value === true} onCheckedChange={(v) => onChange(v)} />
        </div>
      );
    case "image":
      return shell(<ImageInput value={value as ImageValue | null} onChange={onChange} env={env} />);
    case "price":
      return shell(
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle [font-family:var(--font-editor-bn),system-ui,sans-serif]">৳</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            className="pl-7"
            value={typeof value === "number" ? String(value) : ""}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") return onChange(null);
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : raw);
            }}
            aria-invalid={errors.length > 0}
          />
        </div>,
      );
    case "cta":
      return shell(<CtaInput value={value as CtaValue} onChange={onChange} env={env} />);
    case "repeater":
      return (
        <RepeaterInput field={field} value={Array.isArray(value) ? value : []} onChange={onChange} path={path} issues={issues} env={env} />
      );
  }
}

function ImageInput({
  value,
  onChange,
  env,
}: {
  value: ImageValue | null;
  onChange: (v: unknown) => void;
  env: FieldEditorEnv;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = value ? env.assetUrl(value.assetId) : null;

  async function pick(file: File) {
    setError(null);
    if (!(ALLOWED_ASSET_MIME as readonly string[]).includes(file.type)) {
      setError("Use a PNG, JPEG, WebP or GIF image.");
      return;
    }
    if (file.size > MAX_ASSET_BYTES) {
      setError(`Images must be ${Math.round(MAX_ASSET_BYTES / 1024)} KB or smaller.`);
      return;
    }
    setBusy(true);
    try {
      const { id } = await env.upload(file);
      onChange({ assetId: id, alt: value?.alt ?? "" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-stroke/12 bg-surface-overlay">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-5 w-5 text-fg-faint" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {value ? "Replace" : "Upload"}
          </Button>
          {value ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
              Remove
            </Button>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_ASSET_MIME.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
          }}
        />
      </div>
      {value ? (
        <Input
          value={value.alt}
          maxLength={200}
          lang={env.locale}
          className={localeInputClass(env.locale)}
          placeholder="Describe the image (alt text)"
          onChange={(e) => onChange({ ...value, alt: e.target.value })}
        />
      ) : null}
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
    </div>
  );
}

const CTA_KIND_LABEL: Record<CtaAction["kind"], string> = {
  none: "No action yet",
  link: "Open a link",
  phone: "Call a phone number",
  whatsapp: "Open WhatsApp chat",
  email: "Send an email",
  section: "Scroll to a section",
};

function blankAction(kind: CtaAction["kind"], env: FieldEditorEnv): CtaAction {
  switch (kind) {
    case "link":
      return { kind, url: "" };
    case "phone":
      return { kind, phone: "" };
    case "whatsapp":
      return { kind, phone: "", message: "" };
    case "email":
      return { kind, email: "" };
    case "section":
      return { kind, sectionId: env.sectionTargets[0]?.id ?? "hero" };
    case "none":
      return { kind };
  }
}

function CtaInput({ value, onChange, env }: { value: CtaValue | undefined; onChange: (v: unknown) => void; env: FieldEditorEnv }) {
  const v: CtaValue = value ?? { label: "", action: { kind: "none" } };
  const a = v.action;
  const set = (action: CtaAction) => onChange({ ...v, action });
  return (
    <div className="space-y-2 rounded-md border border-stroke/10 p-3">
      <Input
        value={v.label}
        maxLength={60}
        placeholder="Button text"
        lang={env.locale}
        className={localeInputClass(env.locale)}
        onChange={(e) => onChange({ ...v, label: e.target.value })}
      />
      <select className={selectCls} value={a.kind} onChange={(e) => set(blankAction(e.target.value as CtaAction["kind"], env))}>
        {CTA_ACTION_KINDS.map((k) => (
          <option key={k} value={k}>
            {CTA_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {a.kind === "link" ? (
        <Input value={a.url} placeholder="https://…" maxLength={2000} onChange={(e) => set({ ...a, url: e.target.value })} />
      ) : null}
      {a.kind === "phone" || a.kind === "whatsapp" ? (
        <Input value={a.phone} placeholder="+8801XXXXXXXXX" maxLength={30} onChange={(e) => set({ ...a, phone: e.target.value })} />
      ) : null}
      {a.kind === "whatsapp" ? (
        <Input
          value={a.message ?? ""}
          placeholder="Pre-filled message (optional)"
          maxLength={300}
          onChange={(e) => set({ ...a, message: e.target.value })}
        />
      ) : null}
      {a.kind === "email" ? (
        <Input value={a.email} placeholder="you@example.com" maxLength={254} onChange={(e) => set({ ...a, email: e.target.value })} />
      ) : null}
      {a.kind === "section" ? (
        <select className={selectCls} value={a.sectionId} onChange={(e) => set({ ...a, sectionId: e.target.value })}>
          {env.sectionTargets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function RepeaterInput({
  field,
  value,
  onChange,
  path,
  issues,
  env,
}: {
  field: Extract<FieldDef, { type: "repeater" }>;
  value: unknown[];
  onChange: (v: unknown) => void;
  path: string;
  issues: ContentIssue[];
  env: FieldEditorEnv;
}) {
  const items = value as Array<Record<string, unknown>>;
  const errors = issuesAt(issues, path).filter((_, i) => i === 0);
  const move = (from: number, to: number) => {
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    onChange(next);
  };
  return (
    <div className="space-y-2 rounded-md" data-field-path={path}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">
          {field.label}
          {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
          <span className="ml-2 text-fg-faint">
            {items.length}/{field.maxItems}
          </span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={items.length >= field.maxItems}
          onClick={() => onChange([...items, newRepeaterItem(field)])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add {field.itemLabel.toLowerCase()}
        </Button>
      </div>
      {items.map((item, idx) => (
        <div key={idx} className="space-y-3 rounded-md border border-stroke/10 bg-surface-overlay/40 p-3" data-field-path={`${path}.${idx}`}>
          <div className="flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">
              {field.itemLabel} {idx + 1}
            </span>
            <div className="flex gap-1">
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={idx === 0} onClick={() => move(idx, idx - 1)} aria-label="Move up">
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                disabled={idx === items.length - 1}
                onClick={() => move(idx, idx + 1)}
                aria-label="Move down"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-danger"
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                aria-label="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {field.itemFields.map((sub) => (
            <FieldInput
              key={sub.key}
              field={sub}
              value={item[sub.key]}
              path={`${path}.${idx}.${sub.key}`}
              issues={issues}
              env={env}
              onChange={(next) => onChange(items.map((it, i) => (i === idx ? { ...it, [sub.key]: next } : it)))}
            />
          ))}
        </div>
      ))}
      {errors.length && !items.length ? <p className="text-2xs text-danger">{errors[0]}</p> : null}
    </div>
  );
}
