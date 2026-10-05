import { AlertTriangle, CheckCircle2, Contrast, Loader2 } from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LandingSetup, SectionImportance, SectionReadiness, SectionSetup } from "./section-setup";

/**
 * Read-only "landing page setup" UI for the editor's Content tab: a compact
 * summary with the sections that need attention (each opens the existing
 * section panel), and the text shown inside each existing section row.
 * Meaning is always in words (READY, NEEDS EDITING…), never colour alone.
 */

const pad = (n: number) => String(n).padStart(2, "0");

const IMPORTANCE: Record<SectionImportance, { label: string; className: string }> = {
  required: { label: "Required", className: "border-stroke/30 text-fg" },
  recommended: { label: "Recommended", className: "border-stroke/14 text-fg-muted" },
  optional: { label: "Optional", className: "border-stroke/10 text-fg-faint" },
};

export function ImportanceLabel({ importance }: { importance: SectionImportance }) {
  const i = IMPORTANCE[importance];
  return (
    <span className={cn(badgeVariants({ variant: "outline" }), "uppercase tracking-wide", i.className)} data-importance={importance}>
      {i.label}
    </span>
  );
}

const READINESS: Record<SectionReadiness, { label: string; Icon: typeof CheckCircle2; className: string }> = {
  ready: { label: "Ready", Icon: CheckCircle2, className: "text-success" },
  "needs-editing": { label: "Needs editing", Icon: AlertTriangle, className: "text-warning" },
  "check-defaults": { label: "Check defaults", Icon: Contrast, className: "text-info" },
};

export function ReadinessLabel({ readiness }: { readiness: SectionReadiness | null }) {
  if (!readiness) {
    return (
      <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-fg-faint" data-readiness="checking">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Checking
      </span>
    );
  }
  const r = READINESS[readiness];
  return (
    <span className={cn("inline-flex items-center gap-1 font-semibold uppercase tracking-wide", r.className)} data-readiness={readiness}>
      <r.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {r.label}
    </span>
  );
}

/** What a section row shows inside its existing <summary> (phrasing content only). */
export function SectionRowContent({ section }: { section: SectionSetup }) {
  return (
    <span className="flex min-w-0 flex-1 gap-3">
      <span className="w-5 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-fg-faint" aria-hidden>
        {pad(section.number)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-fg">{section.label}</span>
          <ImportanceLabel importance={section.importance} />
        </span>
        {section.description ? <span className="mt-0.5 block text-xs text-fg-subtle">{section.description}</span> : null}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs">
          <ReadinessLabel readiness={section.readiness} />
          {section.detail ? <span className="text-fg-muted">{section.detail}</span> : null}
        </span>
      </span>
    </span>
  );
}

const SEGMENT: Record<SectionReadiness | "checking", string> = {
  ready: "bg-success",
  "needs-editing": "bg-warning",
  "check-defaults": "bg-info",
  checking: "bg-stroke/20",
};

/** Summary above the section list. `onOpen` opens a section's existing panel. */
export function SetupSummary({ setup, onOpen }: { setup: LandingSetup; onOpen: (sectionId: string) => void }) {
  const { counts, attention } = setup;
  return (
    <section aria-label="Landing page setup" className="space-y-3 rounded-lg border border-stroke/10 bg-surface p-4" data-landing-setup="">
      <div>
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">Landing page setup</h3>
        <p className="mt-1 text-sm text-fg">
          <span className="font-semibold">{counts.ready}</span> of {counts.total} sections ready
        </p>
      </div>
      {/* One segment per section, in page order — a picture of the counts, not a score. */}
      <div className="flex gap-0.5" aria-hidden>
        {setup.sections.map((s) => (
          <span key={s.id} className={cn("h-1.5 flex-1 rounded-full", SEGMENT[s.readiness ?? "checking"])} title={`${pad(s.number)} ${s.label}`} />
        ))}
      </div>
      {counts.needsEditing || counts.checkDefaults || counts.checking ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {counts.needsEditing ? (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              {counts.needsEditing} {counts.needsEditing === 1 ? "needs" : "need"} editing
            </span>
          ) : null}
          {counts.checkDefaults ? (
            <span className="inline-flex items-center gap-1 text-info">
              <Contrast className="h-3.5 w-3.5" aria-hidden />
              {counts.checkDefaults} to review
            </span>
          ) : null}
          {counts.checking ? <span className="text-fg-faint">{counts.checking} checking…</span> : null}
        </p>
      ) : (
        <p className="text-xs text-success">Every section is ready.</p>
      )}
      {attention.length ? (
        <ul className="space-y-1" aria-label="Sections that need attention">
          {attention.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onOpen(s.id)}
                className="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${s.label}: ${s.detail ?? ""}`.replace(/: $/, "")}
                data-open-section={s.id}
              >
                <ReadinessLabel readiness={s.readiness} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">
                    {pad(s.number)} {s.label}
                  </span>
                  {s.detail ? <span className="block text-fg-muted">{s.detail}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
