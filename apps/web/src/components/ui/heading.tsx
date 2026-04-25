import * as React from "react";
import { cn } from "@/lib/utils";

type Level = "display" | "page" | "section" | "subsection" | "eyebrow";

const LEVEL_CLASS: Record<Level, string> = {
  display: "text-3xl font-semibold tracking-tight text-fg md:text-4xl",
  page: "text-2xl font-semibold tracking-tight text-fg",
  section: "text-lg font-semibold tracking-tight text-fg",
  subsection: "text-sm font-semibold text-fg",
  eyebrow:
    "text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle",
};

const LEVEL_TAG: Record<Level, keyof JSX.IntrinsicElements> = {
  display: "h1",
  page: "h1",
  section: "h2",
  subsection: "h3",
  eyebrow: "p",
};

type HeadingProps = {
  level?: Level;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  children: React.ReactNode;
};

export function Heading({ level = "page", as, className, children }: HeadingProps) {
  const Tag = (as ?? LEVEL_TAG[level]) as keyof JSX.IntrinsicElements;
  return React.createElement(
    Tag,
    { className: cn(LEVEL_CLASS[level], className) },
    children,
  );
}

export function Eyebrow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn(LEVEL_CLASS.eyebrow, className)}>{children}</p>;
}
