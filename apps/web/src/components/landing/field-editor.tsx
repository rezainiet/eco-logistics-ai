"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import {
  ALLOWED_ASSET_MIME,
  ctaActionsFor,
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

/**
 * Invalid state for any control carrying aria-invalid="true": danger border
 * plus a subtle ring (design-system danger token), also while focused.
 */
export const invalidCls =
  "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger/20 aria-[invalid=true]:focus-visible:border-danger aria-[invalid=true]:focus-visible:ring-danger/35";
const selectCls = cn(
  "h-10 w-full rounded-md border border-stroke/14 bg-surface-raised px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
  invalidCls,
);
const textareaCls = cn(
  "min-h-[88px] w-full rounded-md border border-stroke/14 bg-surface-raised px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
  invalidCls,
);

export function issuesAt(issues: ContentIssue[], path: string): string[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`)).map((i) => i.message);
}

/** Ids tying a field's controls to its visible label and its error message. */
interface FieldA11y {
  labelId: string;
  errorId: string;
  invalid: boolean;
  /** Spread onto the control(s) that hold the field's value. */
  control: { "aria-labelledby": string; "aria-invalid"?: true; "aria-describedby"?: string };
}

function useFieldA11y(errors: string[]): FieldA11y {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const invalid = errors.length > 0;
  return {
    labelId,
    errorId,
    invalid,
    control: invalid
      ? { "aria-labelledby": labelId, "aria-invalid": true, "aria-describedby": errorId }
      : { "aria-labelledby": labelId },
  };
}

function FieldShell({
  label,
  help,
  required,
  errors,
  children,
  path,
  a11y,
}: {
  label: string;
  help?: string;
  required?: boolean;
  errors: string[];
  children: ReactNode;
  /** Click-to-edit anchor: the preview selects a field by this path. */
  path: string;
  a11y: FieldA11y;
}) {
  return (
    <div className="space-y-1.5 rounded-md" data-field-path={path} data-invalid={a11y.invalid || undefined}>
      <div id={a11y.labelId} className={cn("text-xs font-medium", a11y.invalid ? "text-danger" : "text-fg-muted")}>
        {label}
        {required ? (
          <>
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </div>
      {children}
      {help ? <p className="text-2xs text-fg-faint">{help}</p> : null}
      {errors.length ? (
        <p id={a11y.errorId} className="text-2xs text-danger">
          {errors[0]}
        </p>
      ) : null}
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
  const a11y = useFieldA11y(errors);
  const shell = (children: ReactNode, help = field.help) => (
    <FieldShell label={field.label} help={help} required={field.required} errors={errors} path={path} a11y={a11y}>
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
          {...a11y.control}
          {...(field.type === "text" ? langProps : {})}
          className={cn(field.type === "text" ? langProps.className : undefined, invalidCls)}
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
          {...a11y.control}
        />,
      );
    case "richtext":
      return shell(
        <textarea
          lang={env.locale}
          className={cn(textareaCls, "min-h-[120px]", langProps.className)}
          value={str}
          maxLength={field.maxLength ?? 6000}
          onChange={(e) => onChange(e.target.value)}
          {...a11y.control}
        />,
        field.help ?? "Blank line = new paragraph. **bold**, _italic_, and lines starting with “- ” for bullets.",
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
          <Input value={str} maxLength={7} onChange={(e) => onChange(e.target.value)} className={cn("font-mono", invalidCls)} {...a11y.control} />
        </div>,
      );
    case "select":
      return shell(
        <select className={selectCls} value={str} onChange={(e) => onChange(e.target.value)} {...a11y.control}>
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
          <span id={a11y.labelId} className="text-sm text-fg-muted">
            {field.label}
          </span>
          <Switch checked={value === true} onCheckedChange={(v) => onChange(v)} aria-labelledby={a11y.labelId} />
        </div>
      );
    case "image":
      return shell(<ImageInput value={value as ImageValue | null} onChange={onChange} env={env} a11y={a11y} />);
    case "price":
      return shell(
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle [font-family:var(--font-editor-bn),system-ui,sans-serif]">৳</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            className={cn("pl-7", invalidCls)}
            value={typeof value === "number" ? String(value) : ""}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") return onChange(null);
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : raw);
            }}
            {...a11y.control}
          />
        </div>,
      );
    case "cta":
      return shell(
        <CtaInput value={value as CtaValue} onChange={onChange} env={env} a11y={a11y} label={field.label} kinds={ctaActionsFor(field)} />,
      );
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
  a11y,
}: {
  value: ImageValue | null;
  onChange: (v: unknown) => void;
  env: FieldEditorEnv;
  a11y: FieldA11y;
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
        <div
          className={cn(
            "flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-surface-overlay",
            a11y.invalid ? "border-danger ring-2 ring-danger/20" : "border-stroke/12",
          )}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-5 w-5 text-fg-faint" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            aria-describedby={a11y.invalid ? a11y.errorId : undefined}
            className={a11y.invalid ? "border-danger" : undefined}
          >
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

function CtaInput({
  value,
  onChange,
  env,
  a11y,
  label,
  kinds,
}: {
  value: CtaValue | undefined;
  onChange: (v: unknown) => void;
  env: FieldEditorEnv;
  a11y: FieldA11y;
  label: string;
  /** What the button may do — every kind unless the field restricts it. */
  kinds: ReadonlyArray<CtaAction["kind"]>;
}) {
  const v: CtaValue = value ?? { label: "", action: { kind: "none" } };
  const a = v.action;
  const set = (action: CtaAction) => onChange({ ...v, action });
  // Mark the part that is actually missing: the button text, the action, or
  // (for a malformed destination) the destination inputs.
  const labelInvalid = a11y.invalid && !v.label.trim();
  const actionInvalid = a11y.invalid && a.kind === "none";
  const detailInvalid = a11y.invalid && !labelInvalid && !actionInvalid;
  const mark = (invalid: boolean) =>
    invalid ? { "aria-invalid": true as const, "aria-describedby": a11y.errorId } : {};
  const detail = { ...mark(detailInvalid), className: invalidCls };
  return (
    <div className={cn("space-y-2 rounded-md border p-3", a11y.invalid ? "border-danger-border" : "border-stroke/10")}>
      <Input
        value={v.label}
        maxLength={60}
        placeholder="Button text"
        lang={env.locale}
        className={cn(localeInputClass(env.locale), invalidCls)}
        aria-label={`${label} — button text`}
        {...mark(labelInvalid)}
        onChange={(e) => onChange({ ...v, label: e.target.value })}
      />
      <select
        className={selectCls}
        value={a.kind}
        aria-label={`${label} — what the button does`}
        {...mark(actionInvalid)}
        onChange={(e) => set(blankAction(e.target.value as CtaAction["kind"], env))}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {CTA_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {a.kind === "link" ? (
        <Input value={a.url} placeholder="https://…" maxLength={2000} aria-label={`${label} — link`} {...detail} onChange={(e) => set({ ...a, url: e.target.value })} />
      ) : null}
      {a.kind === "phone" || a.kind === "whatsapp" ? (
        <Input value={a.phone} placeholder="+8801XXXXXXXXX" maxLength={30} aria-label={`${label} — phone number`} {...detail} onChange={(e) => set({ ...a, phone: e.target.value })} />
      ) : null}
      {a.kind === "whatsapp" ? (
        <Input
          value={a.message ?? ""}
          aria-label={`${label} — WhatsApp message`}
          placeholder="Pre-filled message (optional)"
          maxLength={300}
          onChange={(e) => set({ ...a, message: e.target.value })}
        />
      ) : null}
      {a.kind === "email" ? (
        <Input value={a.email} placeholder="you@example.com" maxLength={254} aria-label={`${label} — email address`} {...detail} onChange={(e) => set({ ...a, email: e.target.value })} />
      ) : null}
      {a.kind === "section" ? (
        <select
          className={selectCls}
          value={a.sectionId}
          aria-label={`${label} — section to scroll to`}
          {...mark(detailInvalid)}
          onChange={(e) => set({ ...a, sectionId: e.target.value })}
        >
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
  // The list's own issues (too few items, none at all); item-field issues show on the item fields.
  const errors = issues.filter((i) => i.path === path).map((i) => i.message);
  const a11y = useFieldA11y(errors);
  const move = (from: number, to: number) => {
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    onChange(next);
  };
  return (
    <div className="space-y-2 rounded-md" data-field-path={path} data-invalid={a11y.invalid || undefined}>
      <div className="flex items-center justify-between">
        <span id={a11y.labelId} className={cn("text-xs font-medium", a11y.invalid ? "text-danger" : "text-fg-muted")}>
          {field.label}
          {field.required ? (
            <>
              <span aria-hidden className="ml-0.5 text-danger">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
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
          aria-describedby={a11y.invalid ? a11y.errorId : undefined}
          className={a11y.invalid ? "border-danger" : undefined}
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
      {errors.length ? (
        <p id={a11y.errorId} className="text-2xs text-danger">
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}
