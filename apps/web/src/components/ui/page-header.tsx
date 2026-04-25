import * as React from "react";
import { cn } from "@/lib/utils";
import { Heading, Eyebrow } from "@/components/ui/heading";

type PageHeaderProps = {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-stroke/8 pb-5 md:flex-row md:items-end md:justify-between md:gap-6",
        className,
      )}
    >
      <div className="space-y-1.5">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Heading level="page">{title}</Heading>
        {description ? (
          <p className="max-w-2xl text-sm text-fg-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
