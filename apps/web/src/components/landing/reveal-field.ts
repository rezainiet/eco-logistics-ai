/**
 * Bring an editor field into view: open its section, scroll it to the middle
 * of the viewport (so sticky headers never cover it — no pixel offsets), and
 * optionally focus its control. Fields are found by the stable
 * `data-section-id` / `data-field-path` attributes the editor renders, never by
 * layout or class names.
 *
 * Used for click-to-edit from the preview and for "Fix missing fields".
 */

/** The DOM surface this needs — satisfied by any real Element. */
export interface RevealElement {
  open?: boolean;
  querySelector(selectors: string): RevealElement | null;
  scrollIntoView(arg?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
  classList: { add(...t: string[]): void; remove(...t: string[]): void };
}

export interface RevealResult {
  section: RevealElement | null;
  anchor: RevealElement | null;
  focused: RevealElement | null;
}

/** Controls that hold a field's value, in the order a user would edit them. */
export const VALUE_CONTROL_SELECTOR =
  "input:not([type=file]):not([type=hidden]):not([type=checkbox]), textarea, select";

const attr = (v: string) => v.replace(/["\\]/g, "\\$&");

export function revealField(
  root: RevealElement,
  path: string,
  opts: { focus: boolean; flash?: string[]; schedule?: (fn: () => void, ms: number) => void },
): RevealResult {
  const parts = path.split(".");
  const section = root.querySelector(`details[data-section-id="${attr(parts[0]!)}"]`);
  if (section) section.open = true;
  // The deepest rendered anchor: a repeater item field, else its item, else the field.
  let anchor: RevealElement | null = null;
  for (let n = parts.length; n > 1 && !anchor; n--) {
    anchor = root.querySelector(`[data-field-path="${attr(parts.slice(0, n).join("."))}"]`);
  }
  const target = anchor ?? section;
  if (!target) return { section, anchor, focused: null };
  // A field is centred; a whole section is shown from its top.
  target.scrollIntoView({ block: anchor ? "center" : "start", behavior: "smooth" });
  if (opts.flash?.length) {
    target.classList.add(...opts.flash);
    (opts.schedule ?? setTimeout)(() => target.classList.remove(...opts.flash!), 1600);
  }
  let focused: RevealElement | null = null;
  if (anchor && opts.focus) {
    // An invalid control first (e.g. the empty action of a CTA), else the first value control.
    focused =
      anchor.querySelector('[aria-invalid="true"]') ?? anchor.querySelector(VALUE_CONTROL_SELECTOR) ?? anchor.querySelector("button");
    focused?.focus({ preventScroll: true });
  }
  return { section, anchor, focused };
}
