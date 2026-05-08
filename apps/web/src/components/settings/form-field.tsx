import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Canonical settings form field.
 *
 * Promoted from the local `<Field>` helper that lived inside the
 * 1,282-line settings monolith (audit P2-1). Every settings section
 * uses this so spacing rhythm, hint copy size, error tone, and
 * required-asterisk colour stay consistent.
 *
 * The shape mirrors what the old helper accepted — we kept the same
 * prop names so migrating the existing forms is a no-brain swap.
 */
export type FormFieldProps = {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  required?: boolean;
  /** Inline error tied to this field (e.g. validation mismatch). */
  error?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
};

export function FormField({
  label,
  htmlFor,
  hint,
  required,
  error,
  className,
  children,
}: FormFieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)} data-form-field>
      <Label htmlFor={htmlFor} className="text-fg-muted">
        {label}
        {required ? <span className="ml-1 text-danger">*</span> : null}
      </Label>
      {/*
        Children are rendered as-is. Callers that need to associate a
        description for screen readers wire `aria-describedby` to the
        `data-form-field-describedby` attribute we expose below — most
        callers won't need this.
      */}
      <div data-form-field-describedby={describedBy}>{children}</div>
      {hint ? (
        <p id={hintId} className="text-xs text-fg-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Surface-level form error banner. Use for server-side errors that
 * aren't tied to a single field (e.g. "Something went wrong saving").
 * For per-field validation use `FormField`'s `error` prop instead.
 */
export function FormError({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-danger/25 bg-danger/8 px-3 py-2 text-sm text-danger",
        className,
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="mt-0.5 h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{message}</span>
    </div>
  );
}
