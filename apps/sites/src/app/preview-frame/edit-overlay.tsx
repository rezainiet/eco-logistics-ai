"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { type Locale, PREVIEW_MESSAGE_SOURCE, type TemplateSpec, resolveEditTarget } from "@ecom/landing";

/**
 * Click-to-edit layer for the editor preview (edit mode only).
 *
 * The renderer tags elements with `data-lp-section` (section) and
 * `data-lp-field` (schema path within it). Hovering outlines the nearest
 * tagged element; clicking reports its path to the editor, which resolves it
 * against the template schema and opens that field. Nothing here edits
 * content — the frame only points.
 *
 * The overlay is drawn in document coordinates with pointer-events: none, so
 * it never changes the page's layout or intercepts its own hit-testing.
 */

type Box = { top: number; left: number; width: number; height: number };

interface Hit {
  path: string;
  el: HTMLElement;
}

function hitOf(target: EventTarget | null): Hit | null {
  if (!(target instanceof Element)) return null;
  const section = target.closest<HTMLElement>("[data-lp-section]");
  if (!section) return null;
  const field = target.closest<HTMLElement>("[data-lp-field]");
  const sectionId = section.dataset.lpSection!;
  if (field && section.contains(field)) return { path: `${sectionId}.${field.dataset.lpField}`, el: field };
  return { path: sectionId, el: section };
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Element currently showing `path`, falling back to its nearest shown ancestor path. */
function elementFor(path: string): HTMLElement | null {
  const [sectionId, ...rest] = path.split(".");
  const section = document.querySelector<HTMLElement>(`[data-lp-section="${CSS.escape(sectionId!)}"]`);
  if (!section) return null;
  for (let n = rest.length; n > 0; n--) {
    const sel = `[data-lp-field="${CSS.escape(rest.slice(0, n).join("."))}"]`;
    const match = Array.from(section.querySelectorAll<HTMLElement>(sel)).find(visible);
    if (match) return match;
  }
  return section;
}

function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
}

const LOCKED_LABEL = "Template element — not editable";

export function EditOverlay({
  spec,
  locale,
  selected,
  parentOrigin,
}: {
  spec: TemplateSpec;
  locale: Locale;
  /** Selection held by the editor (survives device switches and reloads). */
  selected: string | null;
  /** Exact, allow-listed editor origin; clicks are reported only there. */
  parentOrigin: string | null;
}) {
  const [hover, setHover] = useState<{ box: Box; label: string; locked: boolean } | null>(null);
  const [current, setCurrent] = useState<string | null>(selected);
  const [selBox, setSelBox] = useState<Box | null>(null);
  const lastExternal = useRef<string | null>(null);

  const describe = useCallback(
    (path: string) => {
      const t = resolveEditTarget(spec, locale, path);
      return t.kind === "field" || t.kind === "section" ? { label: t.label, locked: false } : { label: LOCKED_LABEL, locked: true };
    },
    [spec, locale],
  );

  // Editor-driven selection: adopt it, and bring it into view when it changed
  // from the editor side (a form field was focused, or the frame reloaded).
  useEffect(() => {
    setCurrent(selected);
    if (selected && selected !== lastExternal.current) {
      requestAnimationFrame(() => elementFor(selected)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
    lastExternal.current = selected;
  }, [selected]);

  // Keep the selection outline glued to its element through re-renders,
  // scrolling, resizing and font loading.
  useLayoutEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = current ? elementFor(current) : null;
        setSelBox(el ? boxOf(el) : null);
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [current, spec]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const hit = hitOf(e.target);
      setHover(hit ? { box: boxOf(hit.el), ...describe(hit.path) } : null);
    };
    const onLeave = () => setHover(null);
    // Capture phase: in edit mode a click selects — it never follows a link,
    // submits, toggles a disclosure or runs page behaviour.
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const hit = hitOf(e.target);
      if (!hit) return;
      setCurrent(hit.path);
      lastExternal.current = hit.path; // the editor will echo it back; don't scroll
      if (parentOrigin && window.parent !== window) {
        window.parent.postMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "select", path: hit.path, locale }, parentOrigin);
      }
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("click", onClick, true);
    };
  }, [describe, locale, parentOrigin]);

  const sel = current ? describe(current) : null;
  const showHover = hover && !(selBox && hover.box.top === selBox.top && hover.box.left === selBox.left && hover.box.width === selBox.width);

  return (
    <div aria-hidden="true" data-lp-edit-overlay="" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2147483000 }}>
      {showHover ? <Outline box={hover.box} label={hover.label} tone={hover.locked ? "locked" : "hover"} /> : null}
      {selBox && sel ? <Outline box={selBox} label={sel.label} tone="selected" /> : null}
    </div>
  );
}

const TONES: Record<"hover" | "selected" | "locked", { border: string; bg: string; chip: string }> = {
  hover: { border: "2px solid rgba(37, 99, 235, 0.85)", bg: "rgba(37, 99, 235, 0.06)", chip: "#2563eb" },
  selected: { border: "2px solid #16a34a", bg: "rgba(22, 163, 74, 0.08)", chip: "#15803d" },
  locked: { border: "2px dashed rgba(100, 116, 139, 0.9)", bg: "rgba(100, 116, 139, 0.06)", chip: "#475569" },
};

function Outline({ box, label, tone }: { box: Box; label: string; tone: keyof typeof TONES }) {
  const t = TONES[tone];
  const frame: CSSProperties = {
    position: "absolute",
    top: box.top - 2,
    left: box.left - 2,
    width: box.width + 4,
    height: box.height + 4,
    border: t.border,
    background: t.bg,
    borderRadius: 4,
    boxSizing: "border-box",
  };
  const above = box.top > 26;
  const chip: CSSProperties = {
    position: "absolute",
    left: -2,
    [above ? "bottom" : "top"]: "100%",
    maxWidth: 360,
    padding: "2px 8px",
    borderRadius: 4,
    background: t.chip,
    color: "#fff",
    font: "600 12px/18px system-ui, -apple-system, 'Segoe UI', sans-serif",
    letterSpacing: "normal",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  return (
    <div style={frame}>
      <span style={chip}>{label}</span>
    </div>
  );
}
