/**
 * Landing-page scroll reveal — progressive enhancement only.
 *
 * The renderer marks the page root with `data-lp-motion="subtle" | "lively"`
 * (theme@2, never in the editor's click-to-edit preview) and eligible
 * sections with `data-lp-reveal=""`. The server HTML hides nothing. After
 * load, this script:
 *   - does nothing if the visitor prefers reduced motion, the browser has no
 *     IntersectionObserver, or the page has no motion setting;
 *   - leaves every section that is already on screen (or above it) alone,
 *     so nothing visible ever blinks;
 *   - marks sections that start below the fold `pending` (globals.css then
 *     hides them with opacity/transform only) and flips each to `shown` the
 *     moment it scrolls into view, which plays the transition.
 * Keyboard focus inside a pending section, printing, switching on reduced
 * motion, or unmounting reveal everything at once — content can never stay
 * hidden. No library, no inline script: bundled with the page (CSP 'self').
 */

export type MotionSetting = "subtle" | "lively";

export function motionAllowed(opts: { mode: string | null; reducedMotion: boolean; hasObserver: boolean }): opts is {
  mode: MotionSetting;
  reducedMotion: false;
  hasObserver: true;
} {
  return (opts.mode === "subtle" || opts.mode === "lively") && !opts.reducedMotion && opts.hasObserver;
}

/** Sections to hold back until they scroll into view: only those starting below the visible screen. */
export function belowTheFold<T extends { getBoundingClientRect(): { top: number } }>(sections: readonly T[], viewportHeight: number): T[] {
  return sections.filter((s) => s.getBoundingClientRect().top >= viewportHeight);
}

const REVEAL = "data-lp-reveal";
const noop = () => {};

/** Starts the reveal for the landing root in `doc`; returns a cleanup that reveals everything. */
export function startReveal(doc: Document, win: Window & typeof globalThis): () => void {
  const root = doc.querySelector<HTMLElement>("[data-landing-root][data-lp-motion]");
  if (!root) return noop;
  const reduce = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const allowed = motionAllowed({
    mode: root.getAttribute("data-lp-motion"),
    reducedMotion: !!reduce?.matches,
    hasObserver: typeof win.IntersectionObserver === "function",
  });
  if (!allowed) return noop;

  const pending = belowTheFold(Array.from(root.querySelectorAll<HTMLElement>(`[${REVEAL}]`)), win.innerHeight);
  if (pending.length === 0) return noop;

  const show = (el: Element) => el.setAttribute(REVEAL, "shown");
  const observer = new win.IntersectionObserver(
    (entries: IntersectionObserverEntry[]) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        show(e.target);
        observer.unobserve(e.target);
      }
    },
    // Reveal as the top of a section passes ~92% of the screen height.
    { rootMargin: "0px 0px -8% 0px", threshold: 0 },
  );
  for (const el of pending) {
    el.setAttribute(REVEAL, "pending");
    observer.observe(el);
  }

  const revealAll = () => {
    observer.disconnect();
    for (const el of pending) if (el.getAttribute(REVEAL) === "pending") show(el);
  };
  const onFocus = (e: Event) => {
    const target = e.target as Element | null;
    const section = typeof target?.closest === "function" ? target.closest(`[${REVEAL}="pending"]`) : null;
    if (section) show(section);
  };
  const onReduceChange = (e: { matches: boolean }) => {
    if (e.matches) revealAll();
  };
  root.addEventListener("focusin", onFocus);
  win.addEventListener("beforeprint", revealAll);
  reduce?.addEventListener?.("change", onReduceChange);
  return () => {
    revealAll();
    root.removeEventListener("focusin", onFocus);
    win.removeEventListener("beforeprint", revealAll);
    reduce?.removeEventListener?.("change", onReduceChange);
  };
}
