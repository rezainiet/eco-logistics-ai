import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import { Heading } from "@/components/ui/heading";

/**
 * Placeholder for sections that exist in the IA but aren't shipped
 * yet (Notifications, Team & access).
 *
 * Why include them at all: the alternative is to ship a settings IA
 * that goes silent on these surfaces, then bolt them on later as a
 * fourth and fifth top-level route — exactly the fragmentation
 * pattern this redesign exists to fix (audit P1-9, P1-10). Reserving
 * the space in the nav also tells merchants "we know this is
 * missing", which earns more trust than pretending it isn't.
 *
 * Copy stays specific: each placeholder lists what it WILL contain,
 * not generic "coming soon". That's the difference between "we're
 * still building this product" and "this is the roadmap we're
 * executing on".
 */
export function ComingSoon({
  icon: Icon = Sparkles,
  title,
  description,
  bullets,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  bullets: string[];
}) {
  return (
    <section className="rounded-xl border border-dashed border-stroke/12 bg-surface px-6 py-10 text-center sm:px-10 sm:py-14">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        <span
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-subtle text-brand"
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="space-y-2">
          <span className="inline-flex items-center rounded-full border border-stroke/14 bg-surface-overlay px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
            On the roadmap
          </span>
          <Heading level="section">{title}</Heading>
          <p className="text-sm text-fg-subtle">{description}</p>
        </div>
        {bullets.length > 0 ? (
          <ul className="mt-2 w-full space-y-2 text-left">
            {bullets.map((bullet) => (
              <li
                key={bullet}
                className="flex items-start gap-2.5 rounded-md border border-stroke/8 bg-surface-overlay px-3 py-2 text-sm text-fg-muted"
              >
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
